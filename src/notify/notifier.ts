import { findDoctor, findService, type ClinicConfig } from "../clinic/schema.js";
import type { Appointment } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import { formatDateTimeLongRu, fromUtcIso } from "../scheduling/time.js";
import { maskPhone } from "../security/pii.js";

export type AppointmentEventType =
  | "appointment_created"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "appointment_confirmed";

export type AdminEvent =
  | { type: AppointmentEventType; appointment: Appointment; previousStartUtc?: string }
  | { type: "handoff"; phone: string; patientName?: string | null; reason: string; summary: string }
  | { type: "message_while_paused"; phone: string; patientName?: string | null; text: string }
  | { type: "agent_error"; phone: string; error: string }
  | { type: "reminder_not_sent"; appointment: Appointment; reason: string }
  | { type: "privacy_request"; phone: string; patientName?: string | null; kind: string; details?: string | null }
  | { type: "security_alert"; phone: string; issue: string; details?: string }
  | { type: "spam_blocked"; phone: string; reason: string; hours: number }
  | { type: "budget_exceeded"; scope: "clinic" | "global"; spentUsd: number; limitUsd: number }
  | { type: "stale_message"; phone: string; text: string; sentAt: string };

export interface NotifierOptions {
  telegramBotToken?: string;
  fetchImpl?: typeof fetch;
}

const HANDOFF_REASONS: Record<string, string> = {
  patient_request: "пациент просит администратора",
  complaint: "жалоба / недовольство",
  medical_urgent: "срочная медицинская ситуация",
  unknown_answer: "нет ответа в данных клиники",
  billing_or_documents: "оплата, возврат, документы",
  late_change: "поздняя отмена/перенос",
  model_refusal: "ИИ не смог ответить",
  other: "другое",
};

/**
 * Уведомления администраторам клиники: Telegram и/или вебхук в CRM.
 * Никогда не бросает исключений — ошибка доставки не должна ломать диалог с пациентом.
 */
export class Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: NotifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async notify(clinic: ClinicConfig, event: AdminEvent): Promise<void> {
    const text = formatAdminEvent(clinic, event);
    // В лог — только тип события и маскированный номер: персональные данные в логах не храним.
    log.info(`[${clinic.id}] уведомление: ${event.type}`, "phone" in event ? { phone: maskPhone(event.phone) } : undefined);

    const jobs: Array<Promise<void>> = [];
    if (this.opts.telegramBotToken) {
      for (const chatId of clinic.notifications.telegram_chat_ids) {
        jobs.push(this.sendTelegram(chatId, text));
      }
    }
    if (clinic.notifications.webhook_url) {
      jobs.push(this.sendWebhook(clinic.notifications.webhook_url, { clinic_id: clinic.id, event: event.type, text, data: event }));
    }
    await Promise.all(jobs);
  }

  private async sendTelegram(chatId: string, text: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.opts.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn("Telegram не принял уведомление", { chatId, status: res.status, body: await res.text() });
    } catch (err) {
      log.warn("Не удалось отправить уведомление в Telegram", { chatId, error: errorMessage(err) });
    }
  }

  private async sendWebhook(url: string, payload: unknown): Promise<void> {
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn("Вебхук уведомлений ответил ошибкой", { url, status: res.status });
    } catch (err) {
      log.warn("Не удалось отправить вебхук уведомления", { url, error: errorMessage(err) });
    }
  }
}

function waLink(phone: string): string {
  return `+${phone} (https://wa.me/${phone})`;
}

export function formatAdminEvent(clinic: ClinicConfig, event: AdminEvent): string {
  const header = `🏥 ${clinic.name}`;
  switch (event.type) {
    case "appointment_created":
    case "appointment_cancelled":
    case "appointment_rescheduled":
    case "appointment_confirmed": {
      const a = event.appointment;
      const titles: Record<AppointmentEventType, string> = {
        appointment_created: `🟢 Новая запись №${a.id} (через WhatsApp)`,
        appointment_cancelled: `🔴 Пациент отменил запись №${a.id}`,
        appointment_rescheduled: `🔁 Перенос записи №${a.id}`,
        appointment_confirmed: `✅ Пациент подтвердил визит №${a.id}`,
      };
      const when = formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone));
      const lines = [
        header,
        titles[event.type],
        `Пациент: ${a.patient_name}, ${waLink(a.patient_phone)}`,
        `Услуга: ${findService(clinic, a.service_id)?.name ?? a.service_id}`,
        `Врач: ${findDoctor(clinic, a.doctor_id)?.name ?? a.doctor_id}`,
        event.previousStartUtc
          ? `Было: ${formatDateTimeLongRu(fromUtcIso(event.previousStartUtc, clinic.timezone))}\nСтало: ${when}`
          : `Когда: ${when}`,
      ];
      if (a.comment) lines.push(`Комментарий: ${a.comment}`);
      if (event.type === "appointment_cancelled" && a.cancel_reason) lines.push(`Причина: ${a.cancel_reason}`);
      return lines.join("\n");
    }
    case "handoff":
      return [
        header,
        "🙋 Нужен администратор — бот поставлен на паузу в этом чате",
        `Пациент: ${event.patientName ?? "имя неизвестно"}, ${waLink(event.phone)}`,
        `Причина: ${HANDOFF_REASONS[event.reason] ?? event.reason}`,
        `Суть: ${event.summary}`,
      ].join("\n");
    case "message_while_paused":
      return [
        header,
        "💬 Сообщение пациента (бот на паузе, ответьте сами)",
        `Пациент: ${event.patientName ?? "имя неизвестно"}, ${waLink(event.phone)}`,
        `Текст: ${event.text}`,
      ].join("\n");
    case "agent_error":
      return [header, "⚠️ ИИ-администратор не смог ответить пациенту", `Пациент: ${waLink(event.phone)}`, `Ошибка: ${event.error}`].join(
        "\n",
      );
    case "privacy_request": {
      const kinds: Record<string, string> = {
        delete_data: "удалить персональные данные",
        export_data: "выдать копию персональных данных",
        withdraw_consent: "отзыв согласия на обработку данных (ИИ больше не отвечает этому пациенту)",
      };
      return [
        header,
        "🔐 Запрос пациента о персональных данных — обработайте в срок, установленный законом",
        `Пациент: ${event.patientName ?? "имя неизвестно"}, ${waLink(event.phone)}`,
        `Запрос: ${kinds[event.kind] ?? event.kind}`,
        ...(event.details ? [`Подробности: ${event.details}`] : []),
        "Выгрузка и удаление данных — через админ-API (раздел «Права пациента» в README).",
      ].join("\n");
    }
    case "security_alert":
      return [
        header,
        "🛡 Фильтр безопасности остановил ответ ИИ (возможная попытка взлома бота)",
        `Пациент: ${waLink(event.phone)}`,
        `Что сработало: ${event.issue}`,
        ...(event.details ? [`Подробности: ${event.details}`] : []),
      ].join("\n");
    case "spam_blocked":
      return [
        header,
        `🚫 Номер заблокирован на ${event.hours} ч за спам (${event.reason === "day_limit" ? "слишком много сообщений за сутки" : "слишком много сообщений за час"})`,
        `Номер: ${waLink(event.phone)}`,
        "Снять блокировку можно через админ-API (раздел «Блок-лист» в README).",
      ].join("\n");
    case "budget_exceeded":
      return [
        header,
        `💸 Исчерпан дневной бюджет на ИИ (${event.scope === "clinic" ? "эта клиника" : "весь сервис"}): $${event.spentUsd.toFixed(2)} из $${event.limitUsd.toFixed(2)}`,
        "До конца дня новые сообщения пациентов пересылаются администратору без ответа ИИ.",
      ].join("\n");
    case "stale_message":
      return [
        header,
        "⏳ Сообщение пришло с большой задержкой (сбой доставки) — ИИ на него не отвечал, ответьте сами",
        `Пациент: ${waLink(event.phone)}`,
        `Отправлено: ${event.sentAt}`,
        `Текст: ${event.text}`,
      ].join("\n");
    case "reminder_not_sent": {
      const a = event.appointment;
      return [
        header,
        `⚠️ Не удалось отправить напоминание о записи №${a.id}`,
        `Пациент: ${a.patient_name}, ${waLink(a.patient_phone)}`,
        `Когда: ${formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone))}`,
        `Причина: ${event.reason}`,
      ].join("\n");
    }
  }
}
