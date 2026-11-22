import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DentalAgent, RunTurnResult } from "../agent/agent.js";
import { buildHistory, sanitizeTurnForStorage } from "../agent/history.js";
import { buildTurnContext } from "../agent/prompt.js";
import { guardContextFor } from "../agent/safety.js";
import type { ToolContext } from "../agent/tools.js";
import type { ClinicRegistry } from "../clinic/registry.js";
import type { ClinicConfig } from "../clinic/schema.js";
import type { Conversation, Patient, Repo } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import type { AdminEvent, Notifier } from "../notify/notifier.js";
import {
  CONSENT_NO_ID,
  CONSENT_TEXTS,
  CONSENT_YES_ID,
  consentRequestText,
  detectConsentAnswer,
  detectReminderCommand,
  noticeText,
} from "../privacy/consent.js";
import { DateTime, formatDateTimeLongRu, toUtcIso } from "../scheduling/time.js";
import { guardReply, SAFE_FALLBACK } from "../security/output-guard.js";
import { logText, maskPhone } from "../security/pii.js";
import { Semaphore, Throttle } from "../security/ratelimit.js";
import { sanitizeInbound } from "../security/sanitize.js";
import { SPAM_WARNINGS, SpamGuard } from "../security/spam.js";
import { splitMessage, toWhatsAppText } from "../whatsapp/format.js";
import type { Transport } from "./transport.js";

export interface InboundMessage {
  clinicId: string;
  /** wa_id пациента — номер в международном формате без «+». */
  phone: string;
  profileName?: string;
  waMessageId?: string;
  /** Текст сообщения или описание вложения ([голосовое сообщение …]). */
  text: string;
  image?: { mediaId: string; mimeType?: string };
  /** id нажатой кнопки (например, согласие на обработку данных). */
  replyId?: string;
  /** Когда пациент отправил сообщение (по данным WhatsApp). */
  sentAt?: DateTime;
}

export interface DispatcherSettings {
  /** Сколько ждать следующих сообщений пациента, прежде чем отвечать (люди часто пишут несколькими сообщениями). */
  debounceMs: number;
  /** На сколько часов бот замолкает после передачи диалога администратору. */
  handoffHours: number;
  historyMaxTurns: number;
  historyDays: number;
  /** Больше стольких ответов ИИ одному чату в час / в сутки — пауза и передача администратору. */
  maxTurnsPerHour?: number;
  maxTurnsPerDay?: number;
  /** Длинные сообщения обрезаются (защита от «простыней» с инструкциями и лишних расходов). */
  maxInboundChars?: number;
  /** Сообщения старше стольких часов (досланные после сбоя) ИИ не обрабатывает — их получает администратор. */
  staleMessageHours?: number;
  /** Общий дневной бюджет на ИИ по всем клиникам, USD. 0 — без общего лимита. */
  globalDailyBudgetUsd?: number;
  /** Секрет канареечной метки (тот же, что у агента). */
  canarySecret?: string;
}

export interface DispatcherDeps {
  repo: Repo;
  registry: ClinicRegistry;
  agent: DentalAgent;
  transport: Transport;
  notifier: Notifier;
  settings: DispatcherSettings;
  now?: () => DateTime;
  spamGuard?: SpamGuard;
  /** Ограничение одновременных запросов к ИИ. */
  aiLimiter?: Semaphore;
}

interface PendingItem {
  logId: number;
  text: string;
  image?: { mediaId: string; mimeType?: string };
}

interface ConversationState {
  clinicId: string;
  phone: string;
  pending: PendingItem[];
  timer?: NodeJS.Timeout;
  running: boolean;
  lastWaMessageId?: string;
  idleWaiters: Array<() => void>;
}

const CANNED = {
  refusal: "Извините, с этим вопросом я помочь не смогу. Ваше сообщение передано администратору — он ответит здесь же.",
  stuck: "Извините, мне нужно чуть больше времени, чтобы разобраться. Ваш вопрос передан администратору — он скоро ответит здесь же.",
  error: "Извините, у нас техническая заминка. Ваше сообщение получено — администратор ответит вам в ближайшее время.",
  busy: "Сейчас я не могу ответить автоматически. Ваше сообщение передано администратору — он ответит здесь же.",
};

const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CONSENT_REPROMPT_MINUTES = 10;

/**
 * Оркестратор диалогов. Порядок проверок входящего сообщения:
 *   повтор вебхука → блок-лист → антиспам → устаревшее сообщение → команды СТОП/СТАРТ →
 *   согласие на обработку данных → пауза (отвечает администратор) → очередь к ИИ.
 * Один чат обрабатывается строго последовательно, разные чаты — параллельно (с лимитом).
 */
export class Dispatcher {
  private readonly states = new Map<string, ConversationState>();
  private readonly now: () => DateTime;
  private readonly spam: SpamGuard;
  private readonly aiLimiter: Semaphore;
  private readonly onceADay = new Throttle(24 * 3_600_000);
  private stopping = false;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? (() => DateTime.utc());
    this.spam = deps.spamGuard ?? new SpamGuard();
    this.aiLimiter = deps.aiLimiter ?? new Semaphore(8);
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    const { repo, settings } = this.deps;
    const clinic = this.deps.registry.get(msg.clinicId);
    if (!clinic) {
      log.warn("Сообщение для неизвестной клиники", { clinicId: msg.clinicId });
      return;
    }
    const now = this.now();
    const nowIso = toUtcIso(now);
    const phone = msg.phone;
    const { text: cleanText, removedInvisible } = sanitizeInbound(msg.text, settings.maxInboundChars ?? 2000);
    const text = cleanText || "(пустое сообщение)";
    const isNewChat = !repo.isKnownPatient(clinic.id, phone);

    const logId = repo.logInbound({ clinicId: clinic.id, phone, text, waMessageId: msg.waMessageId, createdAtUtc: nowIso });
    if (logId === null) {
      log.info("Повтор вебхука — сообщение уже обработано");
      return;
    }
    repo.ensureConversation(clinic.id, phone, nowIso);
    repo.touchPatient(clinic.id, phone, msg.profileName, nowIso);
    repo.touchInbound(clinic.id, phone, nowIso);
    log.info(`📩 [${clinic.id}] ${maskPhone(phone)}: ${logText(text)}`);
    if (removedInvisible > 0) log.warn("Во входящем сообщении удалены невидимые символы", { clinic: clinic.id, phone: maskPhone(phone), removedInvisible });

    // 1. Блок-лист
    if (repo.activeBlock(clinic.id, phone, nowIso)) {
      repo.markProcessed([logId], nowIso);
      return;
    }

    // 2. Антиспам
    const verdict = this.spam.check({ clinicId: clinic.id, phone, text, isNewChat, now: now.toMillis() });
    if (verdict.action === "block") {
      this.blockNumber(clinic.id, phone, verdict.hours, verdict.reason, "auto");
      repo.markProcessed([logId], nowIso);
      this.notify(clinic, { type: "spam_blocked", phone, reason: verdict.reason, hours: verdict.hours });
      return;
    }
    if (verdict.action === "drop") {
      repo.markProcessed([logId], nowIso);
      log.warn("Сообщение отброшено антиспамом", { clinic: clinic.id, phone: maskPhone(phone), reason: verdict.reason });
      if (verdict.warn) {
        const warning = SPAM_WARNINGS[verdict.warn] + (verdict.warn === "overload" && clinic.phone ? ` Телефон: ${clinic.phone}` : "");
        await this.sendBotText(clinic, phone, warning);
      }
      return;
    }

    if (msg.waMessageId && this.deps.transport.markReadAndTyping) {
      this.deps.transport.markReadAndTyping(clinic, msg.waMessageId).catch((err) =>
        log.warn("Не удалось отметить сообщение прочитанным", { error: errorMessage(err) }),
      );
    }

    // 3. Сообщение, досланное WhatsApp спустя много часов после сбоя, — пусть разберётся человек
    const staleHours = settings.staleMessageHours ?? 12;
    if (msg.sentAt && now.diff(msg.sentAt, "hours").hours > staleHours) {
      repo.markProcessed([logId], nowIso);
      this.notify(clinic, { type: "stale_message", phone, text, sentAt: formatDateTimeLongRu(msg.sentAt.setZone(clinic.timezone)) });
      return;
    }

    // 4. Отписка от напоминаний работает всегда, без ИИ
    const command = detectReminderCommand(text);
    if (command) {
      repo.setRemindersOptOut(clinic.id, phone, command === "stop", nowIso);
      repo.markProcessed([logId], nowIso);
      await this.sendBotText(clinic, phone, command === "stop" ? CONSENT_TEXTS.stopped : CONSENT_TEXTS.started);
      return;
    }

    // 5. Согласие на обработку персональных данных
    const consent = await this.consentGate(clinic, phone, { logId, text, replyId: msg.replyId, waMessageId: msg.waMessageId });
    if (consent === "hold") return;

    // 6. Бот на паузе — отвечает администратор
    if (this.forwardIfPaused(clinic, phone, [{ logId, text }])) return;

    // 7. В очередь к ИИ
    const state = this.state(clinic.id, phone);
    state.pending.push({ logId, text, image: msg.image });
    if (msg.waMessageId) state.lastWaMessageId = msg.waMessageId;
    this.schedule(state);
  }

  /** Подхватывает входящие, которые не успели обработать до перезапуска сервера. */
  recoverUnprocessed(maxAgeMinutes = 15): number {
    const since = toUtcIso(this.now().minus({ minutes: maxAgeMinutes }));
    let recovered = 0;
    for (const row of this.deps.repo.unprocessedInbound(since)) {
      const clinic = this.deps.registry.get(row.clinic_id);
      if (!clinic) continue;
      // Сообщения, ждущие согласия пациента, ИИ не отдаём.
      if (!this.hasConsent(clinic, this.deps.repo.getPatient(row.clinic_id, row.phone))) continue;
      if (this.deps.repo.activeBlock(row.clinic_id, row.phone, toUtcIso(this.now()))) continue;
      if (this.forwardIfPaused(clinic, row.phone, [{ logId: row.id, text: row.text }])) continue;
      const state = this.state(row.clinic_id, row.phone);
      if (!state.pending.some((p) => p.logId === row.id)) state.pending.push({ logId: row.id, text: row.text });
      this.schedule(state);
      recovered++;
    }
    if (recovered > 0) log.info(`Восстановлено необработанных сообщений: ${recovered}`);
    return recovered;
  }

  /** Ответ администратора из админ-API. По умолчанию ставит бота в этом чате на паузу. */
  async sendAsAdmin(clinicId: string, phone: string, text: string, opts: { pauseBot?: boolean } = {}): Promise<void> {
    const clinic = this.requireClinic(clinicId);
    const nowIso = toUtcIso(this.now());
    await this.deps.transport.sendText(clinic, phone, text);
    this.deps.repo.ensureConversation(clinic.id, phone, nowIso);
    this.deps.repo.logOutbound({ clinicId, phone, author: "admin", text, createdAtUtc: nowIso });
    const conv = this.deps.repo.getConversation(clinicId, phone);
    if ((opts.pauseBot ?? true) && conv?.mode !== "human") this.pauseBot(clinicId, phone, this.deps.settings.handoffHours, "admin_reply");
  }

  pauseBot(clinicId: string, phone: string, hours: number | null, reason = "manual"): void {
    const now = this.now();
    this.deps.repo.setMode(clinicId, phone, "human", {
      humanUntil: hours === null ? null : toUtcIso(now.plus({ hours })),
      reason,
      nowUtc: toUtcIso(now),
    });
  }

  resumeBot(clinicId: string, phone: string): void {
    this.deps.repo.setMode(clinicId, phone, "bot", { nowUtc: toUtcIso(this.now()) });
  }

  blockNumber(clinicId: string, phone: string, hours: number | null, reason: string, by: string): void {
    const now = this.now();
    this.deps.repo.blockNumber({
      clinicId,
      phone,
      untilUtc: hours === null ? null : toUtcIso(now.plus({ hours })),
      reason,
      by,
      atUtc: toUtcIso(now),
    });
    this.dropPending(clinicId, phone);
    log.warn("Номер заблокирован", { clinic: clinicId, phone: maskPhone(phone), reason, hours });
  }

  unblockNumber(clinicId: string, phone: string): boolean {
    this.spam.forget(clinicId, phone);
    return this.deps.repo.unblockNumber(clinicId, phone);
  }

  /** Ждёт, пока чат обработает все накопленные сообщения (для CLI и тестов). */
  waitForIdle(clinicId: string, phone: string): Promise<void> {
    const state = this.states.get(key(clinicId, phone));
    if (!state || (!state.running && state.pending.length === 0)) return Promise.resolve();
    return new Promise((resolve) => state.idleWaiters.push(resolve));
  }

  /** Плавная остановка: новые ходы не запускаются, текущие дорабатывают (до timeoutMs). */
  async shutdown(timeoutMs = 25_000): Promise<void> {
    this.stopping = true;
    for (const state of this.states.values()) clearTimeout(state.timer);
    const deadline = Date.now() + timeoutMs;
    while ([...this.states.values()].some((s) => s.running) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ---------- согласие ----------

  /** Можно ли передавать сообщения пациента ИИ. Отзыв согласия соблюдается в любом режиме. */
  private hasConsent(clinic: ClinicConfig, patient: Patient | undefined): boolean {
    const status = patient?.consent_status;
    if (status === "withdrawn" || status === "refused") return false;
    if (clinic.privacy.consent_mode !== "explicit") return true;
    return status === "granted" && patient?.consent_version === clinic.privacy.consent_version;
  }

  /**
   * explicit: пока пациент не согласился, его сообщения хранятся у нас и НЕ передаются ИИ.
   * notice: один раз показываем уведомление и продолжаем.
   */
  private async consentGate(
    clinic: ClinicConfig,
    phone: string,
    item: { logId: number; text: string; replyId?: string; waMessageId?: string },
  ): Promise<"proceed" | "hold"> {
    const { repo } = this.deps;
    const mode = clinic.privacy.consent_mode;
    const now = this.now();
    const nowIso = toUtcIso(now);
    const version = clinic.privacy.consent_version;
    const patient = repo.getPatient(clinic.id, phone);
    const status = patient?.consent_status ?? null;
    const declined = status === "refused" || status === "withdrawn";

    // Ответ на наш запрос согласия. После отказа/отзыва согласие возвращается только кнопкой, не случайным «да».
    const answer =
      mode === "explicit" && patient?.consent_prompted_at ? detectConsentAnswer(declined ? "" : item.text, item.replyId) : null;
    if (answer === "yes") {
      const method = item.replyId === CONSENT_YES_ID ? "button" : "text";
      repo.setConsent(clinic.id, phone, { status: "granted", version, method, atUtc: nowIso });
      repo.logConsent({ clinicId: clinic.id, phone, action: "granted", version, method, waMessageId: item.waMessageId, text: item.text, atUtc: nowIso });
      repo.markProcessed([item.logId], nowIso);
      // Отвечаем на вопросы, которые пациент задал до согласия.
      const waiting = repo.unprocessedFor(clinic.id, phone).filter((m) => m.id !== item.logId);
      if (waiting.length === 0) {
        await this.sendBotText(clinic, phone, CONSENT_TEXTS.thanks);
        return "hold";
      }
      const state = this.state(clinic.id, phone);
      for (const m of waiting) if (!state.pending.some((p) => p.logId === m.id)) state.pending.push({ logId: m.id, text: m.text });
      if (item.waMessageId) state.lastWaMessageId = item.waMessageId;
      this.schedule(state);
      return "hold";
    }

    if (answer === "no") {
      repo.setConsent(clinic.id, phone, { status: "refused", version, method: item.replyId === CONSENT_NO_ID ? "button" : "text", atUtc: nowIso });
      repo.logConsent({ clinicId: clinic.id, phone, action: "refused", version, waMessageId: item.waMessageId, text: item.text, atUtc: nowIso });
      const waiting = repo.unprocessedFor(clinic.id, phone);
      repo.markProcessed(
        waiting.map((m) => m.id),
        nowIso,
      );
      await this.sendBotText(clinic, phone, CONSENT_TEXTS.refused(clinic));
      const questions = waiting.filter((m) => m.id !== item.logId).map((m) => m.text);
      this.notify(clinic, {
        type: "handoff",
        phone,
        patientName: patient?.name ?? patient?.wa_profile_name,
        reason: "consent_refused",
        summary: `Пациент не дал согласие на обработку данных ИИ — ответьте ему сами.${questions.length ? ` Его сообщения: ${questions.join(" / ")}` : ""}`,
      });
      return "hold";
    }

    if (declined) {
      // ИИ этому пациенту не отвечает — сообщения получает администратор.
      this.forwardToAdmin(clinic, phone, [{ logId: item.logId, text: item.text }]);
      return "hold";
    }
    if (mode === "off") return "proceed";
    if (status === "granted" && patient?.consent_version === version) return "proceed";

    if (mode === "notice") {
      await this.sendBotText(clinic, phone, noticeText(clinic));
      repo.setConsent(clinic.id, phone, { status: "granted", version, method: "notice", atUtc: nowIso });
      repo.logConsent({ clinicId: clinic.id, phone, action: "notice_shown", version, method: "notice", atUtc: nowIso });
      return "proceed";
    }

    // Ответа ещё нет: сообщение остаётся необработанным (ИИ его не видит), просим согласие не чаще раза в 10 минут.
    const lastPrompt = patient?.consent_prompted_at ? DateTime.fromISO(patient.consent_prompted_at) : null;
    // Отмечаем запрос, только если он реально доставлен, — иначе следующее сообщение попробует снова.
    if ((!lastPrompt || now.diff(lastPrompt, "minutes").minutes >= CONSENT_REPROMPT_MINUTES) && (await this.sendConsentRequest(clinic, phone))) {
      repo.markConsentPrompted(clinic.id, phone, nowIso);
      repo.logConsent({ clinicId: clinic.id, phone, action: "requested", version, atUtc: nowIso });
    }
    return "hold";
  }

  private async sendConsentRequest(clinic: ClinicConfig, phone: string): Promise<boolean> {
    const text = consentRequestText(clinic);
    try {
      if (this.deps.transport.sendButtons) {
        await this.deps.transport.sendButtons(clinic, phone, text, [
          { id: CONSENT_YES_ID, title: "✅ Согласен" },
          { id: CONSENT_NO_ID, title: "Не согласен" },
        ]);
      } else {
        await this.deps.transport.sendText(clinic, phone, `${text}\n\nОтветьте «да» или «нет».`);
      }
      this.deps.repo.logOutbound({ clinicId: clinic.id, phone, author: "bot", text, createdAtUtc: toUtcIso(this.now()) });
      return true;
    } catch (err) {
      log.error("Не удалось отправить запрос согласия", { clinic: clinic.id, phone: maskPhone(phone), error: errorMessage(err) });
      return false;
    }
  }

  // ---------- очередь ----------

  private state(clinicId: string, phone: string): ConversationState {
    const k = key(clinicId, phone);
    let state = this.states.get(k);
    if (!state) {
      state = { clinicId, phone, pending: [], running: false, idleWaiters: [] };
      this.states.set(k, state);
    }
    return state;
  }

  private dropPending(clinicId: string, phone: string): void {
    const state = this.states.get(key(clinicId, phone));
    if (!state) return;
    clearTimeout(state.timer);
    this.deps.repo.markProcessed(
      state.pending.splice(0).map((p) => p.logId),
      toUtcIso(this.now()),
    );
  }

  private schedule(state: ConversationState): void {
    if (this.stopping) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.run(state), this.deps.settings.debounceMs);
  }

  private async run(state: ConversationState): Promise<void> {
    if (state.running || state.pending.length === 0) return;
    state.running = true;
    const batch = state.pending.splice(0);
    try {
      await this.processBatch(state, batch);
    } catch (err) {
      log.error("Сбой обработки сообщений", { clinic: state.clinicId, phone: maskPhone(state.phone), error: errorMessage(err) });
    } finally {
      state.running = false;
      if (state.pending.length > 0 && !this.stopping) {
        this.schedule(state);
      } else {
        const waiters = state.idleWaiters.splice(0);
        waiters.forEach((resolve) => resolve());
        if (state.pending.length === 0) this.states.delete(key(state.clinicId, state.phone));
      }
    }
  }

  private isPaused(conv: Conversation | undefined, nowIso: string): boolean {
    if (!conv || conv.mode !== "human") return false;
    return conv.human_until === null || conv.human_until > nowIso;
  }

  /** Если бот на паузе в этом чате — пересылаем сообщения администратору и не отвечаем. */
  private forwardIfPaused(clinic: ClinicConfig, phone: string, items: Array<{ logId: number; text: string }>): boolean {
    const { repo } = this.deps;
    const nowIso = toUtcIso(this.now());
    const conv = repo.getConversation(clinic.id, phone);
    if (!this.isPaused(conv, nowIso)) {
      if (conv?.mode === "human") repo.setMode(clinic.id, phone, "bot", { nowUtc: nowIso }); // пауза истекла
      return false;
    }
    this.forwardToAdmin(clinic, phone, items);
    return true;
  }

  private forwardToAdmin(clinic: ClinicConfig, phone: string, items: Array<{ logId: number; text: string }>): void {
    const { repo } = this.deps;
    repo.markProcessed(
      items.map((i) => i.logId),
      toUtcIso(this.now()),
    );
    const patient = repo.getPatient(clinic.id, phone);
    for (const item of items) {
      this.notify(clinic, { type: "message_while_paused", phone, patientName: patient?.name ?? patient?.wa_profile_name, text: item.text });
    }
  }

  /** Проверка дневных бюджетов на ИИ. Возвращает true, если тратить больше нельзя. */
  private budgetExceeded(clinic: ClinicConfig, day: string): boolean {
    const { repo, settings } = this.deps;
    const clinicSpent = repo.costForDay(day, clinic.id);
    if (clinicSpent >= clinic.limits.daily_budget_usd) {
      if (this.onceADay.allow(`budget:${clinic.id}:${day}`)) {
        this.notify(clinic, { type: "budget_exceeded", scope: "clinic", spentUsd: clinicSpent, limitUsd: clinic.limits.daily_budget_usd });
      }
      return true;
    }
    const globalLimit = settings.globalDailyBudgetUsd ?? 0;
    if (globalLimit > 0) {
      const totalSpent = repo.costForDay(day);
      if (totalSpent >= globalLimit) {
        if (this.onceADay.allow(`budget:global:${clinic.id}:${day}`)) {
          this.notify(clinic, { type: "budget_exceeded", scope: "global", spentUsd: totalSpent, limitUsd: globalLimit });
        }
        return true;
      }
    }
    return false;
  }

  private async processBatch(state: ConversationState, batch: PendingItem[]): Promise<void> {
    const { repo, settings } = this.deps;
    const clinic = this.requireClinic(state.clinicId);
    const phone = state.phone;

    // Защита в глубину: без согласия ИИ ничего не получает, даже если сообщение как-то попало в очередь.
    const patient = repo.getPatient(clinic.id, phone);
    if (!this.hasConsent(clinic, patient)) {
      if (patient?.consent_status === "refused" || patient?.consent_status === "withdrawn") this.forwardToAdmin(clinic, phone, batch);
      return;
    }
    // За время ожидания диалог могли передать администратору.
    if (this.forwardIfPaused(clinic, phone, batch)) return;

    const now = this.now();
    const nowIso = toUtcIso(now);
    const day = now.toUTC().toISODate();
    const conv = repo.ensureConversation(clinic.id, phone, nowIso);
    const batchIds = new Set(batch.map((b) => b.logId));

    const perHour = settings.maxTurnsPerHour ?? 40;
    const perDay = settings.maxTurnsPerDay ?? 150;
    const turnsHour = repo.countTurnsSince(clinic.id, phone, toUtcIso(now.minus({ hours: 1 })));
    const turnsDay = repo.countTurnsSince(clinic.id, phone, toUtcIso(now.minus({ hours: 24 })));
    if (turnsHour >= perHour || turnsDay >= perDay) {
      log.warn("Слишком много ответов ИИ одному чату — передаём администратору", { clinic: clinic.id, phone: maskPhone(phone) });
      this.handoff(clinic, phone, "other", `Больше ${turnsHour >= perHour ? `${perHour} ответов бота за час` : `${perDay} ответов бота за сутки`} в одном чате — возможен спам. Бот в чате на паузе.`);
      repo.markProcessed([...batchIds], nowIso);
      return;
    }

    if (this.budgetExceeded(clinic, day)) {
      this.forwardToAdmin(clinic, phone, batch);
      if (this.onceADay.allow(`busy:${clinic.id}:${phone}:${day}`)) await this.sendBotText(clinic, phone, CANNED.busy);
      return;
    }

    // «Печатает…» гаснет через 25 секунд — обновляем, пока думаем.
    const typing =
      state.lastWaMessageId && this.deps.transport.markReadAndTyping
        ? setInterval(() => {
            this.deps.transport.markReadAndTyping!(clinic, state.lastWaMessageId!).catch(() => undefined);
          }, 20_000)
        : undefined;

    const guardContext = guardContextFor(clinic, phone, settings.canarySecret ?? "");
    const guarded = (text: string): string => {
      const result = guardReply(text, guardContext);
      if (result.blocked) {
        log.warn("Фильтр безопасности остановил ответ ИИ", { clinic: clinic.id, phone: maskPhone(phone), issues: result.issues });
        repo.audit({ actor: "system", clinicId: clinic.id, action: "output_blocked", target: maskPhone(phone), details: result.issues.join(","), atUtc: toUtcIso(this.now()) });
        this.notify(clinic, { type: "security_alert", phone, issue: result.issues.join(", ") });
      } else if (result.issues.length > 0) {
        log.warn("Фильтр безопасности исправил ответ ИИ", { clinic: clinic.id, phone: maskPhone(phone), issues: result.issues });
      }
      return clinic.privacy.ai_label_each_message ? `🤖 ${result.text}` : result.text;
    };

    try {
      const userContent = await this.buildUserContent(clinic, batch);
      const history = buildHistory(
        repo.recentTurns(clinic.id, phone, settings.historyMaxTurns, toUtcIso(now.minus({ days: settings.historyDays }))),
      );
      const outsideMessages = repo
        .messagesAfter(clinic.id, phone, conv.last_bot_log_id, 15)
        .filter((m) => !batchIds.has(m.id) && m.author !== "bot");
      const contextNote = buildTurnContext({
        clinic,
        now,
        patient: repo.getPatient(clinic.id, phone),
        appointments: repo.patientAppointments(clinic.id, phone, nowIso),
        outsideMessages,
      });

      let handedOff = false;
      const tools: ToolContext = {
        clinic,
        phone,
        repo,
        now: this.now,
        notify: (event) => this.notify(clinic, event),
        requestHandoff: (reason, summary) => {
          handedOff = true;
          this.handoff(clinic, phone, reason, summary);
        },
      };

      const result: RunTurnResult = await this.aiLimiter.run(() =>
        this.deps.agent.runTurn({
          clinic,
          history,
          userContent,
          contextNote,
          tools,
          userKey: `${clinic.id}:${phone}`,
          onInterimText: (text) => this.sendBotText(clinic, phone, guarded(text)),
        }),
      );
      repo.addUsage(clinic.id, day, {
        turns: 1,
        requests: result.usage.requests,
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        costUsd: result.usage.costUsd,
      });

      let canned: string | undefined;
      if (result.stopReason === "refusal") {
        canned = CANNED.refusal;
        if (!handedOff) this.handoff(clinic, phone, "model_refusal", "ИИ отказался отвечать на сообщение пациента — проверьте переписку.");
      } else if (result.stopReason === "max_rounds") {
        canned = CANNED.stuck;
        if (!handedOff) this.handoff(clinic, phone, "other", "ИИ не смог завершить ответ (слишком много шагов). Проверьте переписку.");
      } else if (result.stopReason === "error") {
        canned = CANNED.error;
        this.notify(clinic, { type: "agent_error", phone, error: result.error ?? "неизвестная ошибка" });
      }

      const replies = canned ? [canned] : result.replies.map(guarded);
      for (const reply of replies) await this.sendBotText(clinic, phone, reply);

      // В историю — то, что пациент реально получил (заблокированный текст ИИ туда не попадает).
      const turnMessages: BetaMessageParam[] = canned
        ? [...result.messages, { role: "assistant", content: [{ type: "text", text: canned }] }]
        : replaceFinalTexts(result.messages, replies);
      repo.appendTurn(clinic.id, phone, sanitizeTurnForStorage(turnMessages), nowIso);
    } finally {
      clearInterval(typing);
      const doneIso = toUtcIso(this.now());
      repo.markProcessed([...batchIds], doneIso);
      const lastId = repo.messagesAfter(clinic.id, phone, 0, 1).at(-1)?.id ?? 0;
      repo.setLastBotLogId(clinic.id, phone, lastId);
    }
  }

  private async buildUserContent(clinic: ClinicConfig, batch: PendingItem[]): Promise<string | BetaContentBlockParam[]> {
    const images: BetaContentBlockParam[] = [];
    const texts: string[] = [];
    for (const item of batch) {
      let text = item.text.trim();
      if (item.image && this.deps.transport.downloadMedia) {
        try {
          const media = await this.deps.transport.downloadMedia(clinic, item.image.mediaId);
          const mime = media.mimeType.split(";")[0]!.trim();
          if (CLAUDE_IMAGE_TYPES.has(mime) && media.data.length <= MAX_IMAGE_BYTES) {
            images.push({ type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: media.data.toString("base64") } });
          } else {
            text += " (фото не удалось открыть: неподдерживаемый формат или слишком большой файл)";
          }
        } catch (err) {
          text += " (фото не удалось загрузить)";
          log.warn("Не удалось скачать фото из WhatsApp", { error: errorMessage(err) });
        }
      }
      if (text) texts.push(text);
    }
    const text = texts.join("\n");
    if (images.length === 0) return text || "(пустое сообщение)";
    return [...images, { type: "text", text: text || "[фото без подписи]" }];
  }

  private async sendBotText(clinic: ClinicConfig, phone: string, text: string): Promise<void> {
    for (const chunk of splitMessage(toWhatsAppText(text))) {
      try {
        const sent = await this.deps.transport.sendText(clinic, phone, chunk);
        this.deps.repo.logOutbound({
          clinicId: clinic.id,
          phone,
          author: "bot",
          text: chunk,
          waMessageId: sent.messageId,
          createdAtUtc: toUtcIso(this.now()),
        });
        log.info(`📤 [${clinic.id}] ${maskPhone(phone)}: ${logText(chunk)}`);
      } catch (err) {
        log.error("Не удалось отправить сообщение пациенту", { clinic: clinic.id, phone: maskPhone(phone), error: errorMessage(err) });
        this.notify(clinic, { type: "agent_error", phone, error: `Ответ не доставлен: ${errorMessage(err)}` });
        return;
      }
    }
  }

  private handoff(clinic: ClinicConfig, phone: string, reason: string, summary: string): void {
    this.pauseBot(clinic.id, phone, this.deps.settings.handoffHours, reason);
    const patient = this.deps.repo.getPatient(clinic.id, phone);
    this.notify(clinic, { type: "handoff", phone, patientName: patient?.name ?? patient?.wa_profile_name, reason, summary });
  }

  private notify(clinic: ClinicConfig, event: AdminEvent): void {
    this.deps.notifier.notify(clinic, event).catch((err) => log.warn("Сбой уведомления", { error: errorMessage(err) }));
  }

  private requireClinic(clinicId: string): ClinicConfig {
    const clinic = this.deps.registry.get(clinicId);
    if (!clinic) throw new Error(`Клиника "${clinicId}" не найдена`);
    return clinic;
  }
}

function key(clinicId: string, phone: string): string {
  return `${clinicId}:${phone}`;
}

/** Заменяет тексты последнего ответа ассистента на отфильтрованные (в том же порядке). */
export function replaceFinalTexts(messages: BetaMessageParam[], texts: string[]): BetaMessageParam[] {
  const lastIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastIndex === -1) return messages;
  const last = messages[lastIndex]!;
  if (typeof last.content === "string" || !last.content) return messages;
  let i = 0;
  const content = last.content.map((block) => {
    if (block.type !== "text" || block.text.trim() === "") return block;
    const replacement = texts[i++];
    return replacement === undefined ? block : { ...block, text: replacement };
  });
  return [...messages.slice(0, lastIndex), { ...last, content } as BetaMessageParam, ...messages.slice(lastIndex + 1)];
}

export { SAFE_FALLBACK };
