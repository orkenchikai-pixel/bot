import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { FieldCipher } from "../security/crypto.js";
import { anonymizePhone } from "../security/pii.js";
import type { Database } from "./database.js";

export type AppointmentStatus = "booked" | "confirmed" | "cancelled" | "completed" | "no_show";
export const ACTIVE_STATUSES: AppointmentStatus[] = ["booked", "confirmed"];

export interface Appointment {
  id: number;
  clinic_id: string;
  patient_phone: string;
  patient_name: string;
  doctor_id: string;
  service_id: string;
  start_utc: string;
  end_utc: string;
  status: AppointmentStatus;
  comment: string | null;
  source: string;
  cancel_reason: string | null;
  reminder_status: string | null;
  reminder_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ConsentStatus = "pending" | "granted" | "refused" | "withdrawn";

export interface Patient {
  clinic_id: string;
  phone: string;
  name: string | null;
  wa_profile_name: string | null;
  consent_status: ConsentStatus | null;
  consent_version: string | null;
  consent_method: string | null;
  consent_at: string | null;
  consent_prompted_at: string | null;
  reminders_opt_out: number;
  created_at: string;
  updated_at: string;
}

export type ConversationMode = "bot" | "human";

export interface Conversation {
  clinic_id: string;
  phone: string;
  mode: ConversationMode;
  human_until: string | null;
  handoff_reason: string | null;
  last_inbound_at: string | null;
  last_bot_log_id: number;
  created_at: string;
  updated_at: string;
}

export type LogAuthor = "patient" | "bot" | "admin" | "reminder";

export interface LogEntry {
  id: number;
  clinic_id: string;
  phone: string;
  direction: "in" | "out";
  author: LogAuthor;
  text: string;
  wa_message_id: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface BlockEntry {
  clinic_id: string;
  phone: string;
  until: string | null;
  reason: string;
  created_by: string;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  clinic_id: string | null;
  action: string;
  target: string | null;
  details: string | null;
  ip: string | null;
}

export interface UsageRow {
  clinic_id: string;
  day: string;
  turns: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface PrivacyRequest {
  id: number;
  clinic_id: string;
  phone: string;
  kind: string;
  details: string | null;
  status: "open" | "done";
  created_at: string;
  resolved_at: string | null;
}

export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "busy" | "patient_overlap" | "patient_limit" };

export type RescheduleResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "busy" | "patient_overlap" | "not_found" };

const ACTIVE_SQL = `status IN ('booked', 'confirmed')`;

type Row = Record<string, unknown>;

/**
 * Все запросы к БД в одном месте. Время везде — ISO-строки в UTC. Все значения передаются
 * параметрами (никакой склейки SQL с данными) — защита от SQL-инъекций.
 * Чувствительные поля (тексты, имена, комментарии) шифруются, если задан DATA_ENCRYPTION_KEY.
 */
export class Repo {
  constructor(
    readonly db: Database,
    private readonly cipher: FieldCipher = new FieldCipher(),
  ) {}

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private enc(value: string | null | undefined): string | null {
    return this.cipher.encrypt(value ?? null);
  }

  private dec(value: unknown): string | null {
    return this.cipher.decrypt(typeof value === "string" ? value : null);
  }

  private patientRow(raw: Row | undefined): Patient | undefined {
    if (!raw) return undefined;
    return { ...(raw as unknown as Patient), name: this.dec(raw.name), wa_profile_name: this.dec(raw.wa_profile_name) };
  }

  private appointmentRow(raw: Row | undefined): Appointment | undefined {
    if (!raw) return undefined;
    return {
      ...(raw as unknown as Appointment),
      patient_name: this.dec(raw.patient_name) ?? "",
      comment: this.dec(raw.comment),
      cancel_reason: this.dec(raw.cancel_reason),
    };
  }

  private appointments(rows: Row[]): Appointment[] {
    return rows.map((r) => this.appointmentRow(r)!);
  }

  private logRow(raw: Row): LogEntry {
    return { ...(raw as unknown as LogEntry), text: this.dec(raw.text) ?? "" };
  }

  // ---------- Пациенты ----------

  touchPatient(clinicId: string, phone: string, waProfileName: string | undefined, nowUtc: string): void {
    this.db
      .prepare(
        `INSERT INTO patients (clinic_id, phone, wa_profile_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (clinic_id, phone) DO UPDATE SET
           wa_profile_name = COALESCE(excluded.wa_profile_name, wa_profile_name),
           updated_at = excluded.updated_at`,
      )
      .run(clinicId, phone, this.enc(waProfileName), nowUtc, nowUtc);
  }

  setPatientName(clinicId: string, phone: string, name: string, nowUtc: string): void {
    this.db
      .prepare(
        `INSERT INTO patients (clinic_id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (clinic_id, phone) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(clinicId, phone, this.enc(name), nowUtc, nowUtc);
  }

  getPatient(clinicId: string, phone: string): Patient | undefined {
    return this.patientRow(this.db.prepare(`SELECT * FROM patients WHERE clinic_id = ? AND phone = ?`).get(clinicId, phone) as Row | undefined);
  }

  /** Есть ли у нас уже переписка с этим номером (для лимита новых чатов). */
  isKnownPatient(clinicId: string, phone: string): boolean {
    return this.db.prepare(`SELECT 1 FROM patients WHERE clinic_id = ? AND phone = ?`).get(clinicId, phone) !== undefined;
  }

  setConsent(
    clinicId: string,
    phone: string,
    input: { status: ConsentStatus; version: string | null; method: string | null; atUtc: string },
  ): void {
    this.db
      .prepare(
        `UPDATE patients SET consent_status = ?, consent_version = ?, consent_method = ?, consent_at = ?, updated_at = ?
         WHERE clinic_id = ? AND phone = ?`,
      )
      .run(input.status, input.version, input.method, input.atUtc, input.atUtc, clinicId, phone);
  }

  markConsentPrompted(clinicId: string, phone: string, atUtc: string): void {
    this.db
      .prepare(`UPDATE patients SET consent_prompted_at = ?, consent_status = COALESCE(consent_status, 'pending') WHERE clinic_id = ? AND phone = ?`)
      .run(atUtc, clinicId, phone);
  }

  logConsent(input: {
    clinicId: string;
    phone: string;
    action: "requested" | "granted" | "refused" | "withdrawn" | "notice_shown";
    version?: string | null;
    method?: string | null;
    waMessageId?: string | null;
    text?: string | null;
    atUtc: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO consent_log (clinic_id, phone, action, version, method, wa_message_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.clinicId, input.phone, input.action, input.version ?? null, input.method ?? null, input.waMessageId ?? null, this.enc(input.text), input.atUtc);
  }

  consentLog(clinicId: string, phone: string): Array<Row & { text: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM consent_log WHERE clinic_id = ? AND phone = ? ORDER BY id`).all(clinicId, phone) as Row[];
    return rows.map((r) => ({ ...r, text: this.dec(r.text) }));
  }

  setRemindersOptOut(clinicId: string, phone: string, optOut: boolean, nowUtc: string): void {
    this.db
      .prepare(`UPDATE patients SET reminders_opt_out = ?, updated_at = ? WHERE clinic_id = ? AND phone = ?`)
      .run(optOut ? 1 : 0, nowUtc, clinicId, phone);
  }

  // ---------- Записи ----------

  getAppointment(id: number): Appointment | undefined {
    return this.appointmentRow(this.db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id) as Row | undefined);
  }

  /** Занятые интервалы врачей в диапазоне (для поиска свободного времени). */
  busyIntervals(clinicId: string, doctorIds: string[], fromUtc: string, toUtc: string): Appointment[] {
    if (doctorIds.length === 0) return [];
    const placeholders = doctorIds.map(() => "?").join(", ");
    return this.appointments(
      this.db
        .prepare(
          `SELECT * FROM appointments
           WHERE clinic_id = ? AND doctor_id IN (${placeholders}) AND ${ACTIVE_SQL}
             AND start_utc < ? AND end_utc > ?
           ORDER BY start_utc`,
        )
        .all(clinicId, ...doctorIds, toUtc, fromUtc) as Row[],
    );
  }

  createAppointment(input: {
    clinicId: string;
    patientPhone: string;
    patientName: string;
    doctorId: string;
    serviceId: string;
    startUtc: string;
    endUtc: string;
    comment?: string | null;
    source?: string;
    nowUtc: string;
    maxActivePerPatient: number;
  }): CreateAppointmentResult {
    return this.tx((): CreateAppointmentResult => {
      if (this.hasDoctorOverlap(input.clinicId, input.doctorId, input.startUtc, input.endUtc)) {
        return { ok: false, reason: "busy" };
      }
      if (this.hasPatientOverlap(input.clinicId, input.patientPhone, input.startUtc, input.endUtc)) {
        return { ok: false, reason: "patient_overlap" };
      }
      const { count } = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM appointments
           WHERE clinic_id = ? AND patient_phone = ? AND ${ACTIVE_SQL} AND start_utc > ?`,
        )
        .get(input.clinicId, input.patientPhone, input.nowUtc) as { count: number };
      if (count >= input.maxActivePerPatient) return { ok: false, reason: "patient_limit" };

      const info = this.db
        .prepare(
          `INSERT INTO appointments
             (clinic_id, patient_phone, patient_name, doctor_id, service_id, start_utc, end_utc,
              status, comment, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)`,
        )
        .run(
          input.clinicId,
          input.patientPhone,
          this.enc(input.patientName),
          input.doctorId,
          input.serviceId,
          input.startUtc,
          input.endUtc,
          this.enc(input.comment),
          input.source ?? "whatsapp",
          input.nowUtc,
          input.nowUtc,
        );
      return { ok: true, appointment: this.getAppointment(Number(info.lastInsertRowid))! };
    });
  }

  rescheduleAppointment(
    id: number,
    input: { doctorId: string; startUtc: string; endUtc: string; nowUtc: string },
  ): RescheduleResult {
    return this.tx((): RescheduleResult => {
      const current = this.getAppointment(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (this.hasDoctorOverlap(current.clinic_id, input.doctorId, input.startUtc, input.endUtc, id)) {
        return { ok: false, reason: "busy" };
      }
      if (this.hasPatientOverlap(current.clinic_id, current.patient_phone, input.startUtc, input.endUtc, id)) {
        return { ok: false, reason: "patient_overlap" };
      }
      // После переноса подтверждение и напоминание начинаются заново.
      this.db
        .prepare(
          `UPDATE appointments
           SET doctor_id = ?, start_utc = ?, end_utc = ?, status = 'booked',
               reminder_status = NULL, reminder_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.doctorId, input.startUtc, input.endUtc, input.nowUtc, id);
      return { ok: true, appointment: this.getAppointment(id)! };
    });
  }

  setAppointmentStatus(id: number, status: AppointmentStatus, nowUtc: string, cancelReason?: string): Appointment | undefined {
    this.db
      .prepare(`UPDATE appointments SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = ? WHERE id = ?`)
      .run(status, this.enc(cancelReason), nowUtc, id);
    return this.getAppointment(id);
  }

  /** Активные записи пациента, начиная с момента fromUtc. */
  patientAppointments(clinicId: string, phone: string, fromUtc: string): Appointment[] {
    return this.appointments(
      this.db
        .prepare(
          `SELECT * FROM appointments
           WHERE clinic_id = ? AND patient_phone = ? AND ${ACTIVE_SQL} AND start_utc >= ?
           ORDER BY start_utc`,
        )
        .all(clinicId, phone, fromUtc) as Row[],
    );
  }

  listAppointments(clinicId: string, fromUtc: string, toUtc: string): Appointment[] {
    return this.appointments(
      this.db
        .prepare(`SELECT * FROM appointments WHERE clinic_id = ? AND start_utc >= ? AND start_utc < ? ORDER BY start_utc`)
        .all(clinicId, fromUtc, toUtc) as Row[],
    );
  }

  /** Кандидаты на напоминание: активные, без отметки о напоминании, начало в (fromUtc, toUtc]. */
  appointmentsForReminder(fromUtc: string, toUtc: string, createdBeforeUtc: string): Appointment[] {
    return this.appointments(
      this.db
        .prepare(
          `SELECT * FROM appointments
           WHERE ${ACTIVE_SQL} AND reminder_status IS NULL
             AND start_utc > ? AND start_utc <= ? AND created_at <= ?
           ORDER BY start_utc`,
        )
        .all(fromUtc, toUtc, createdBeforeUtc) as Row[],
    );
  }

  setReminderStatus(id: number, status: string, atUtc: string): void {
    this.db.prepare(`UPDATE appointments SET reminder_status = ?, reminder_at = ? WHERE id = ?`).run(status, atUtc, id);
  }

  logBookingEvent(clinicId: string, phone: string, kind: "created" | "cancelled" | "rescheduled", atUtc: string): void {
    this.db.prepare(`INSERT INTO booking_events (clinic_id, phone, kind, created_at) VALUES (?, ?, ?, ?)`).run(clinicId, phone, kind, atUtc);
  }

  countBookingEvents(clinicId: string, phone: string, sinceUtc: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM booking_events WHERE clinic_id = ? AND phone = ? AND created_at >= ?`)
        .get(clinicId, phone, sinceUtc) as { count: number }
    ).count;
  }

  private hasDoctorOverlap(clinicId: string, doctorId: string, startUtc: string, endUtc: string, excludeId = -1): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM appointments
           WHERE clinic_id = ? AND doctor_id = ? AND ${ACTIVE_SQL} AND start_utc < ? AND end_utc > ? AND id != ?
           LIMIT 1`,
        )
        .get(clinicId, doctorId, endUtc, startUtc, excludeId) !== undefined
    );
  }

  private hasPatientOverlap(clinicId: string, phone: string, startUtc: string, endUtc: string, excludeId = -1): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM appointments
           WHERE clinic_id = ? AND patient_phone = ? AND ${ACTIVE_SQL} AND start_utc < ? AND end_utc > ? AND id != ?
           LIMIT 1`,
        )
        .get(clinicId, phone, endUtc, startUtc, excludeId) !== undefined
    );
  }

  // ---------- Диалоги ----------

  getConversation(clinicId: string, phone: string): Conversation | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE clinic_id = ? AND phone = ?`).get(clinicId, phone) as
      | Conversation
      | undefined;
  }

  ensureConversation(clinicId: string, phone: string, nowUtc: string): Conversation {
    this.db
      .prepare(
        `INSERT INTO conversations (clinic_id, phone, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (clinic_id, phone) DO NOTHING`,
      )
      .run(clinicId, phone, nowUtc, nowUtc);
    return this.getConversation(clinicId, phone)!;
  }

  touchInbound(clinicId: string, phone: string, atUtc: string): void {
    this.db
      .prepare(`UPDATE conversations SET last_inbound_at = ?, updated_at = ? WHERE clinic_id = ? AND phone = ?`)
      .run(atUtc, atUtc, clinicId, phone);
  }

  setMode(
    clinicId: string,
    phone: string,
    mode: ConversationMode,
    opts: { humanUntil?: string | null; reason?: string | null; nowUtc: string },
  ): void {
    this.ensureConversation(clinicId, phone, opts.nowUtc);
    this.db
      .prepare(
        `UPDATE conversations SET mode = ?, human_until = ?, handoff_reason = ?, updated_at = ?
         WHERE clinic_id = ? AND phone = ?`,
      )
      .run(mode, opts.humanUntil ?? null, opts.reason ?? null, opts.nowUtc, clinicId, phone);
  }

  setLastBotLogId(clinicId: string, phone: string, logId: number): void {
    this.db
      .prepare(`UPDATE conversations SET last_bot_log_id = MAX(last_bot_log_id, ?) WHERE clinic_id = ? AND phone = ?`)
      .run(logId, clinicId, phone);
  }

  listConversations(clinicId: string, mode?: ConversationMode, limit = 50): Array<Conversation & { last_text: string | null }> {
    const where = mode ? `AND c.mode = ?` : "";
    const params: string[] = mode ? [clinicId, mode] : [clinicId];
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT text FROM message_log m WHERE m.clinic_id = c.clinic_id AND m.phone = c.phone
                      ORDER BY m.id DESC LIMIT 1) AS last_text
         FROM conversations c WHERE c.clinic_id = ? ${where}
         ORDER BY c.updated_at DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
      )
      .all(...params) as Row[];
    return rows.map((r) => ({ ...(r as unknown as Conversation), last_text: this.dec(r.last_text) }));
  }

  // ---------- История для Claude ----------

  appendTurn(clinicId: string, phone: string, messages: BetaMessageParam[], createdAtUtc: string): void {
    if (messages.length === 0) return;
    this.db
      .prepare(`INSERT INTO turns (clinic_id, phone, messages_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(clinicId, phone, this.enc(JSON.stringify(messages)), createdAtUtc);
  }

  /** Последние ходы диалога (в хронологическом порядке), не старше sinceUtc. */
  recentTurns(clinicId: string, phone: string, maxTurns: number, sinceUtc: string): BetaMessageParam[][] {
    const rows = this.db
      .prepare(
        `SELECT messages_json FROM turns
         WHERE clinic_id = ? AND phone = ? AND created_at >= ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(clinicId, phone, sinceUtc, maxTurns) as Array<{ messages_json: string }>;
    return rows.reverse().map((r) => JSON.parse(this.dec(r.messages_json) ?? "[]") as BetaMessageParam[]);
  }

  countTurnsSince(clinicId: string, phone: string, sinceUtc: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM turns WHERE clinic_id = ? AND phone = ? AND created_at >= ?`)
      .get(clinicId, phone, sinceUtc) as { count: number };
    return row.count;
  }

  clearHistory(clinicId: string, phone: string): void {
    this.db.prepare(`DELETE FROM turns WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone);
  }

  // ---------- Журнал переписки ----------

  /** Возвращает id записи или null, если сообщение с таким wa_message_id уже было (повтор вебхука). */
  logInbound(input: { clinicId: string; phone: string; text: string; waMessageId?: string; createdAtUtc: string }): number | null {
    const info = this.db
      .prepare(
        `INSERT INTO message_log (clinic_id, phone, direction, author, text, wa_message_id, created_at)
         VALUES (?, ?, 'in', 'patient', ?, ?, ?)
         ON CONFLICT (wa_message_id) DO NOTHING`,
      )
      .run(input.clinicId, input.phone, this.enc(input.text), input.waMessageId ?? null, input.createdAtUtc);
    return info.changes > 0 ? Number(info.lastInsertRowid) : null;
  }

  logOutbound(input: {
    clinicId: string;
    phone: string;
    author: Exclude<LogAuthor, "patient">;
    text: string;
    waMessageId?: string;
    createdAtUtc: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO message_log (clinic_id, phone, direction, author, text, wa_message_id, processed_at, created_at)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
      )
      .run(input.clinicId, input.phone, input.author, this.enc(input.text), input.waMessageId ?? null, input.createdAtUtc, input.createdAtUtc);
    return Number(info.lastInsertRowid);
  }

  markProcessed(ids: number[], atUtc: string): void {
    const stmt = this.db.prepare(`UPDATE message_log SET processed_at = ? WHERE id = ? AND processed_at IS NULL`);
    for (const id of ids) stmt.run(atUtc, id);
  }

  /** Входящие, которые не успели обработать (например, сервер перезапустили во время ответа). */
  unprocessedInbound(sinceUtc: string): LogEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM message_log WHERE direction = 'in' AND processed_at IS NULL AND created_at >= ? ORDER BY id`)
        .all(sinceUtc) as Row[]
    ).map((r) => this.logRow(r));
  }

  /** Необработанные входящие одного чата (ждут согласия пациента). */
  unprocessedFor(clinicId: string, phone: string): LogEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM message_log WHERE clinic_id = ? AND phone = ? AND direction = 'in' AND processed_at IS NULL ORDER BY id`)
        .all(clinicId, phone) as Row[]
    ).map((r) => this.logRow(r));
  }

  messagesAfter(clinicId: string, phone: string, afterId: number, limit = 20): LogEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM message_log WHERE clinic_id = ? AND phone = ? AND id > ? ORDER BY id DESC LIMIT ?`)
        .all(clinicId, phone, afterId, limit) as Row[]
    )
      .reverse()
      .map((r) => this.logRow(r));
  }

  recentMessages(clinicId: string, phone: string, limit = 100): LogEntry[] {
    return this.messagesAfter(clinicId, phone, 0, limit);
  }

  // ---------- Блок-лист ----------

  blockNumber(input: { clinicId: string; phone: string; untilUtc: string | null; reason: string; by: string; atUtc: string }): void {
    this.db
      .prepare(
        `INSERT INTO blocked_numbers (clinic_id, phone, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (clinic_id, phone) DO UPDATE SET until = excluded.until, reason = excluded.reason,
           created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(input.clinicId, input.phone, input.untilUtc, input.reason, input.by, input.atUtc);
  }

  unblockNumber(clinicId: string, phone: string): boolean {
    return this.db.prepare(`DELETE FROM blocked_numbers WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone).changes > 0;
  }

  activeBlock(clinicId: string, phone: string, nowUtc: string): BlockEntry | undefined {
    return this.db
      .prepare(`SELECT * FROM blocked_numbers WHERE clinic_id = ? AND phone = ? AND (until IS NULL OR until > ?)`)
      .get(clinicId, phone, nowUtc) as BlockEntry | undefined;
  }

  listBlocks(clinicId: string, nowUtc: string): BlockEntry[] {
    return this.db
      .prepare(`SELECT * FROM blocked_numbers WHERE clinic_id = ? AND (until IS NULL OR until > ?) ORDER BY created_at DESC`)
      .all(clinicId, nowUtc) as unknown as BlockEntry[];
  }

  // ---------- Аудит ----------

  audit(input: { actor: string; clinicId?: string | null; action: string; target?: string | null; details?: string | null; ip?: string | null; atUtc: string }): void {
    this.db
      .prepare(`INSERT INTO audit_log (at, actor, clinic_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.atUtc, input.actor, input.clinicId ?? null, input.action, input.target ?? null, this.enc(input.details), input.ip ?? null);
  }

  auditLog(clinicId: string | null, limit = 200): AuditEntry[] {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = (
      clinicId
        ? this.db.prepare(`SELECT * FROM audit_log WHERE clinic_id = ? ORDER BY id DESC LIMIT ?`).all(clinicId, capped)
        : this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(capped)
    ) as Row[];
    return rows.map((r) => ({ ...(r as unknown as AuditEntry), details: this.dec(r.details) }));
  }

  // ---------- Учёт расходов на ИИ ----------

  addUsage(
    clinicId: string,
    day: string,
    usage: { turns: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (clinic_id, day, turns, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (clinic_id, day) DO UPDATE SET
           turns = turns + excluded.turns,
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(clinicId, day, usage.turns, usage.requests, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.costUsd);
  }

  /** Расход за день: по клинике или по всем клиникам вместе. */
  costForDay(day: string, clinicId?: string): number {
    const row = (
      clinicId
        ? this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_daily WHERE day = ? AND clinic_id = ?`).get(day, clinicId)
        : this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM usage_daily WHERE day = ?`).get(day)
    ) as { cost: number };
    return row.cost;
  }

  usageRange(clinicId: string | null, fromDay: string, toDay: string): UsageRow[] {
    return (
      clinicId
        ? this.db.prepare(`SELECT * FROM usage_daily WHERE clinic_id = ? AND day >= ? AND day <= ? ORDER BY day`).all(clinicId, fromDay, toDay)
        : this.db.prepare(`SELECT * FROM usage_daily WHERE day >= ? AND day <= ? ORDER BY day, clinic_id`).all(fromDay, toDay)
    ) as unknown as UsageRow[];
  }

  // ---------- Запросы пациентов о данных ----------

  createPrivacyRequest(input: { clinicId: string; phone: string; kind: string; details?: string | null; atUtc: string }): number {
    const info = this.db
      .prepare(`INSERT INTO privacy_requests (clinic_id, phone, kind, details, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.clinicId, input.phone, input.kind, this.enc(input.details), input.atUtc);
    return Number(info.lastInsertRowid);
  }

  listPrivacyRequests(clinicId: string, status?: "open" | "done"): PrivacyRequest[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM privacy_requests WHERE clinic_id = ? AND status = ? ORDER BY id DESC`).all(clinicId, status)
        : this.db.prepare(`SELECT * FROM privacy_requests WHERE clinic_id = ? ORDER BY id DESC`).all(clinicId)
    ) as Row[];
    return rows.map((r) => ({ ...(r as unknown as PrivacyRequest), details: this.dec(r.details) }));
  }

  // ---------- Права пациента: выгрузка и удаление ----------

  /** Все данные пациента в одном объекте (право на доступ к своим данным). */
  exportPatient(clinicId: string, phone: string) {
    return {
      patient: this.getPatient(clinicId, phone) ?? null,
      conversation: this.getConversation(clinicId, phone) ?? null,
      appointments: this.appointments(
        this.db.prepare(`SELECT * FROM appointments WHERE clinic_id = ? AND patient_phone = ? ORDER BY start_utc`).all(clinicId, phone) as Row[],
      ),
      messages: (
        this.db.prepare(`SELECT * FROM message_log WHERE clinic_id = ? AND phone = ? ORDER BY id`).all(clinicId, phone) as Row[]
      ).map((r) => this.logRow(r)),
      consent_log: this.consentLog(clinicId, phone),
      privacy_requests: this.listPrivacyRequests(clinicId).filter((r) => r.phone === phone),
    };
  }

  /**
   * Удаление данных пациента по его запросу: переписка, история ИИ и карточка удаляются,
   * будущие записи отменяются, прошлые обезличиваются (статистика клиники сохраняется без личных данных).
   * Журнал согласий обезличивается, но остаётся — как доказательство законности прошлой обработки.
   */
  erasePatient(clinicId: string, phone: string, nowUtc: string): { messages: number; turns: number; appointments: number } {
    const anon = anonymizePhone(phone);
    return this.tx(() => {
      this.db
        .prepare(
          `UPDATE appointments SET status = 'cancelled', updated_at = ?
           WHERE clinic_id = ? AND patient_phone = ? AND ${ACTIVE_SQL} AND start_utc > ?`,
        )
        .run(nowUtc, clinicId, phone, nowUtc);
      const appointments = this.db
        .prepare(
          `UPDATE appointments SET patient_phone = ?, patient_name = ?, comment = NULL, cancel_reason = NULL, updated_at = ?
           WHERE clinic_id = ? AND patient_phone = ?`,
        )
        .run(anon, this.enc("данные удалены"), nowUtc, clinicId, phone).changes;
      const messages = this.db.prepare(`DELETE FROM message_log WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone).changes;
      const turns = this.db.prepare(`DELETE FROM turns WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone).changes;
      this.db.prepare(`DELETE FROM conversations WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone);
      this.db.prepare(`DELETE FROM patients WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone);
      this.db.prepare(`DELETE FROM booking_events WHERE clinic_id = ? AND phone = ?`).run(clinicId, phone);
      this.db.prepare(`UPDATE consent_log SET phone = ?, text = NULL WHERE clinic_id = ? AND phone = ?`).run(anon, clinicId, phone);
      this.db
        .prepare(`UPDATE privacy_requests SET phone = ?, details = NULL, status = 'done', resolved_at = ? WHERE clinic_id = ? AND phone = ?`)
        .run(anon, nowUtc, clinicId, phone);
      return { messages: Number(messages), turns: Number(turns), appointments: Number(appointments) };
    });
  }

  /** Автоочистка по срокам хранения. */
  purgeOldData(input: { messagesBeforeUtc: string; appointmentsBeforeUtc: string; auditBeforeUtc: string; nowUtc: string }): {
    messages: number;
    turns: number;
    appointments: number;
    audit: number;
    blocks: number;
  } {
    return this.tx(() => {
      const messages = this.db.prepare(`DELETE FROM message_log WHERE created_at < ?`).run(input.messagesBeforeUtc).changes;
      const turns = this.db.prepare(`DELETE FROM turns WHERE created_at < ?`).run(input.messagesBeforeUtc).changes;
      this.db.prepare(`DELETE FROM booking_events WHERE created_at < ?`).run(input.messagesBeforeUtc);
      const old = this.db
        .prepare(`SELECT id, patient_phone FROM appointments WHERE start_utc < ? AND patient_phone NOT LIKE 'anon:%'`)
        .all(input.appointmentsBeforeUtc) as Array<{ id: number; patient_phone: string }>;
      const anonymize = this.db.prepare(
        `UPDATE appointments SET patient_phone = ?, patient_name = ?, comment = NULL, cancel_reason = NULL WHERE id = ?`,
      );
      for (const row of old) anonymize.run(anonymizePhone(row.patient_phone), this.enc("обезличено"), row.id);
      const audit = this.db.prepare(`DELETE FROM audit_log WHERE at < ?`).run(input.auditBeforeUtc).changes;
      // Согласия действующих пациентов храним, пока есть пациент; удаляем только обезличенные (после удаления данных).
      this.db.prepare(`DELETE FROM consent_log WHERE created_at < ? AND phone LIKE 'anon:%'`).run(input.auditBeforeUtc);
      const blocks = this.db.prepare(`DELETE FROM blocked_numbers WHERE until IS NOT NULL AND until <= ?`).run(input.nowUtc).changes;
      return { messages: Number(messages), turns: Number(turns), appointments: old.length, audit: Number(audit), blocks: Number(blocks) };
    });
  }
}
