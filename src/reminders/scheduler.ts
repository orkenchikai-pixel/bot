import type { ClinicRegistry } from "../clinic/registry.js";
import { findDoctor, findService, type ClinicConfig } from "../clinic/schema.js";
import type { Appointment, Repo } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import type { Transport } from "../messaging/transport.js";
import type { Notifier } from "../notify/notifier.js";
import { DateTime, formatDayRu, fromUtcIso, toUtcIso } from "../scheduling/time.js";

export interface ReminderDeps {
  repo: Repo;
  registry: ClinicRegistry;
  transport: Transport;
  notifier: Notifier;
  now?: () => DateTime;
}

/** Окно WhatsApp для свободных сообщений — 24 часа после последнего сообщения пациента (берём с запасом). */
const SESSION_WINDOW_HOURS = 23.5;
/** Не напоминаем о приёмах, до которых осталось меньше этого. */
const MIN_HOURS_BEFORE = 2;

export function reminderText(clinic: ClinicConfig, appt: Appointment): string {
  const start = fromUtcIso(appt.start_utc, clinic.timezone);
  const doctor = findDoctor(clinic, appt.doctor_id)?.name ?? "";
  const service = findService(clinic, appt.service_id)?.name ?? "";
  return (
    `Здравствуйте, ${appt.patient_name}! Напоминаем о записи в «${clinic.name}»: ` +
    `*${formatDayRu(start)} в ${start.toFormat("HH:mm")}*, ${service}${doctor ? `, врач ${doctor}` : ""}.\n` +
    `Адрес: ${clinic.address}\n\n` +
    `Пожалуйста, ответьте «Да», если придёте, или напишите, если нужно перенести или отменить запись.`
  );
}

/**
 * Один проход: находит записи, о которых пора напомнить, и отправляет напоминания.
 * Внутри 24-часового окна — обычным сообщением, вне окна — утверждённым шаблоном (требование WhatsApp).
 */
export async function runReminderPass(deps: ReminderDeps): Promise<{ sent: number; skipped: number }> {
  const now = (deps.now ?? (() => DateTime.utc()))();
  const nowIso = toUtcIso(now);
  const maxHours = Math.max(24, ...deps.registry.list().map((c) => c.reminders.hours_before));
  const candidates = deps.repo.appointmentsForReminder(
    toUtcIso(now.plus({ hours: MIN_HOURS_BEFORE })),
    toUtcIso(now.plus({ hours: maxHours })),
    toUtcIso(now.minus({ hours: 1 })), // только что созданные записи не напоминаем
  );

  let sent = 0;
  let skipped = 0;
  for (const appt of candidates) {
    const clinic = deps.registry.get(appt.clinic_id);
    if (!clinic || !clinic.reminders.enabled) continue;
    const hoursLeft = DateTime.fromISO(appt.start_utc).diff(now, "hours").hours;
    if (hoursLeft > clinic.reminders.hours_before) continue;

    // Пациент отписался («СТОП») или отозвал согласие — не пишем (требование WhatsApp и закона о данных).
    const patient = deps.repo.getPatient(clinic.id, appt.patient_phone);
    if (patient?.reminders_opt_out) {
      deps.repo.setReminderStatus(appt.id, "skipped_opt_out", nowIso);
      continue;
    }
    if (patient?.consent_status === "refused" || patient?.consent_status === "withdrawn") {
      deps.repo.setReminderStatus(appt.id, "skipped_no_consent", nowIso);
      continue;
    }

    const conv = deps.repo.getConversation(clinic.id, appt.patient_phone);
    const inWindow =
      conv?.last_inbound_at !== null &&
      conv?.last_inbound_at !== undefined &&
      DateTime.fromISO(conv.last_inbound_at).plus({ hours: SESSION_WINDOW_HOURS }).toMillis() > now.toMillis();

    try {
      if (inWindow) {
        const text = reminderText(clinic, appt);
        const res = await deps.transport.sendText(clinic, appt.patient_phone, text);
        deps.repo.logOutbound({ clinicId: clinic.id, phone: appt.patient_phone, author: "reminder", text, waMessageId: res.messageId, createdAtUtc: nowIso });
        deps.repo.setReminderStatus(appt.id, "sent_text", nowIso);
        sent++;
      } else if (clinic.reminders.template_name && deps.transport.sendTemplate) {
        const start = fromUtcIso(appt.start_utc, clinic.timezone);
        const params = [
          appt.patient_name,
          formatDayRu(start),
          start.toFormat("HH:mm"),
          findDoctor(clinic, appt.doctor_id)?.name ?? "",
          clinic.name,
        ];
        const res = await deps.transport.sendTemplate(clinic, appt.patient_phone, {
          name: clinic.reminders.template_name,
          language: clinic.reminders.template_language,
          bodyParams: params,
        });
        deps.repo.logOutbound({
          clinicId: clinic.id,
          phone: appt.patient_phone,
          author: "reminder",
          text: `Напоминание (шаблон ${clinic.reminders.template_name}): ${params.join(", ")}`,
          waMessageId: res.messageId,
          createdAtUtc: nowIso,
        });
        deps.repo.ensureConversation(clinic.id, appt.patient_phone, nowIso);
        deps.repo.setReminderStatus(appt.id, "sent_template", nowIso);
        sent++;
      } else {
        deps.repo.setReminderStatus(appt.id, "skipped_no_template", nowIso);
        skipped++;
        await deps.notifier.notify(clinic, {
          type: "reminder_not_sent",
          appointment: appt,
          reason: "пациент не писал больше 24 часов, а шаблон напоминания не настроен (reminders.template_name)",
        });
      }
    } catch (err) {
      deps.repo.setReminderStatus(appt.id, "failed", nowIso);
      skipped++;
      log.error("Не удалось отправить напоминание", { appointment: appt.id, error: errorMessage(err) });
      await deps.notifier.notify(clinic, { type: "reminder_not_sent", appointment: appt, reason: errorMessage(err) });
    }
  }
  if (sent + skipped > 0) log.info("Напоминания", { sent, skipped });
  return { sent, skipped };
}

export function startReminderScheduler(deps: ReminderDeps, intervalMinutes: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReminderPass(deps);
    } catch (err) {
      log.error("Сбой планировщика напоминаний", { error: errorMessage(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMinutes * 60_000);
  void tick();
  return () => clearInterval(timer);
}
