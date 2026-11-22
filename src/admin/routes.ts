import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { STATUS_RU } from "../agent/prompt.js";
import type { ClinicRegistry } from "../clinic/registry.js";
import { findDoctor, findService, type ClinicConfig } from "../clinic/schema.js";
import type { Appointment, AppointmentStatus, Repo } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import type { Dispatcher } from "../messaging/dispatcher.js";
import { DateTime, formatDateTimeLongRu, fromUtcIso, isIsoDate, toUtcIso } from "../scheduling/time.js";
import { maskPhone } from "../security/pii.js";
import { SlidingWindowCounter } from "../security/ratelimit.js";

export interface AdminDeps {
  /** Токен суперадминистратора (владельца сервиса) — доступ ко всем клиникам. */
  adminToken?: string;
  clinicsDir: string;
  registry: ClinicRegistry;
  repo: Repo;
  dispatcher: Dispatcher;
  runReminders: () => Promise<{ sent: number; skipped: number }>;
  runBackup?: () => string;
  /** Неудачных попыток входа с одного IP за 15 минут до временной блокировки. */
  maxFailedLogins?: number;
  clientIp: (c: Context) => string;
}

type Principal = { kind: "super" } | { kind: "clinic"; clinicId: string };
type Env = { Variables: { principal: Principal; ip: string } };

const sha256 = (text: string) => createHash("sha256").update(text).digest();

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentAppointment(clinic: ClinicConfig, a: Appointment) {
  return {
    ...a,
    when: formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone)),
    doctor_name: findDoctor(clinic, a.doctor_id)?.name ?? a.doctor_id,
    service_name: findService(clinic, a.service_id)?.name ?? a.service_id,
    status_ru: STATUS_RU[a.status] ?? a.status,
  };
}

const PHONE_RE = /^\d{5,20}$/;
const StatusBody = z.object({ status: z.enum(["booked", "confirmed", "cancelled", "completed", "no_show"]) });
const SendBody = z.object({ text: z.string().trim().min(1).max(4000), pause_bot: z.boolean().optional() });
const PauseBody = z.object({ hours: z.number().positive().max(24 * 365).nullable().optional() });
const BlockBody = z.object({ hours: z.number().positive().max(24 * 365).nullable().optional(), reason: z.string().max(200).optional() });

/**
 * REST API для владельца сервиса и администраторов клиник.
 * Авторизация: Authorization: Bearer <токен>. Токен суперадмина (ADMIN_TOKEN) видит все клиники,
 * токен клиники (admin.token_sha256 в её файле) — только свою. Все действия с данными пациентов
 * пишутся в журнал аудита.
 */
export function createAdminRoutes(deps: AdminDeps): Hono<Env> {
  const admin = new Hono<Env>();
  const failures = new SlidingWindowCounter(15 * 60_000);
  const maxFailures = deps.maxFailedLogins ?? 10;

  const resolve = (token: string): Principal | null => {
    if (!token) return null;
    if (deps.adminToken && safeEqual(Buffer.from(token), Buffer.from(deps.adminToken))) return { kind: "super" };
    const digest = sha256(token);
    for (const clinic of deps.registry.list()) {
      const expected = clinic.admin.token_sha256;
      if (expected && safeEqual(digest, Buffer.from(expected, "hex"))) return { kind: "clinic", clinicId: clinic.id };
    }
    return null;
  };

  admin.use("*", async (c, next) => {
    const anyToken = Boolean(deps.adminToken) || deps.registry.list().some((cl) => cl.admin.token_sha256);
    if (!anyToken) return c.json({ error: "Админ-API выключен: задайте ADMIN_TOKEN или токен клиники" }, 404);
    const ip = deps.clientIp(c);
    if (failures.count(ip) >= maxFailures) {
      c.header("Retry-After", "900");
      return c.json({ error: "Слишком много неудачных попыток входа. Повторите через 15 минут." }, 429);
    }
    const header = c.req.header("authorization") ?? "";
    const principal = resolve(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    if (!principal) {
      failures.hit(ip);
      log.warn("Неудачная попытка входа в админ-API", { ip, path: c.req.path });
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("principal", principal);
    c.set("ip", ip);
    await next();
  });

  const actor = (p: Principal) => (p.kind === "super" ? "super-admin" : `clinic-admin:${p.clinicId}`);
  const canAccess = (p: Principal, clinicId: string) => p.kind === "super" || p.clinicId === clinicId;

  /** Клиника из параметра запроса, если она существует и доступна этому токену. */
  const clinicFor = (c: Context<Env>, id: string | undefined): ClinicConfig | Response => {
    const clinic = id ? deps.registry.get(id) : undefined;
    if (!clinic) return c.json({ error: "клиника не найдена (параметр clinic)" }, 404);
    if (!canAccess(c.get("principal"), clinic.id)) return c.json({ error: "нет доступа к этой клинике" }, 403);
    return clinic;
  };
  const phoneFor = (c: Context<Env>): string | Response => {
    const phone = c.req.param("phone") ?? "";
    return PHONE_RE.test(phone) ? phone : c.json({ error: "номер — только цифры" }, 400);
  };
  const audit = (c: Context<Env>, clinicId: string | null, action: string, target?: string, details?: string) => {
    deps.repo.audit({
      actor: actor(c.get("principal")),
      clinicId,
      action,
      target: target ? maskPhone(target) : null,
      details: details ?? null,
      ip: c.get("ip"),
      atUtc: toUtcIso(DateTime.utc()),
    });
  };
  const superOnly = (c: Context<Env>): Response | null =>
    c.get("principal").kind === "super" ? null : c.json({ error: "доступно только владельцу сервиса" }, 403);

  admin.get("/clinics", (c) => {
    const p = c.get("principal");
    return c.json(
      deps.registry
        .list()
        .filter((cl) => canAccess(p, cl.id))
        .map((cl) => ({ id: cl.id, name: cl.name, phone_number_id: cl.whatsapp.phone_number_id, services: cl.services.length, doctors: cl.doctors.length })),
    );
  });

  admin.post("/clinics/reload", async (c) => {
    const denied = superOnly(c);
    if (denied) return denied;
    try {
      const clinics = await deps.registry.reloadFromDir(deps.clinicsDir);
      audit(c, null, "reload_clinics");
      return c.json({ ok: true, clinics: clinics.map((cl) => cl.id) });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 400);
    }
  });

  admin.get("/appointments", (c) => {
    const clinic = clinicFor(c, c.req.query("clinic"));
    if (clinic instanceof Response) return clinic;
    const today = DateTime.now().setZone(clinic.timezone).startOf("day");
    const fromQ = c.req.query("from");
    const toQ = c.req.query("to");
    const from = fromQ && isIsoDate(fromQ) ? DateTime.fromISO(fromQ, { zone: clinic.timezone }) : today;
    const to = toQ && isIsoDate(toQ) ? DateTime.fromISO(toQ, { zone: clinic.timezone }) : from.plus({ days: 7 });
    const list = deps.repo.listAppointments(clinic.id, toUtcIso(from), toUtcIso(to.endOf("day")));
    return c.json(list.map((a) => presentAppointment(clinic, a)));
  });

  admin.post("/appointments/:id/status", async (c) => {
    const parsed = StatusBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const appt = deps.repo.getAppointment(Number(c.req.param("id")));
    const clinic = appt ? clinicFor(c, appt.clinic_id) : c.json({ error: "запись не найдена" }, 404);
    if (clinic instanceof Response) return clinic;
    const updated = deps.repo.setAppointmentStatus(appt!.id, parsed.data.status as AppointmentStatus, toUtcIso(DateTime.utc()), "изменено администратором");
    audit(c, clinic.id, "appointment_status", appt!.patient_phone, `№${appt!.id} → ${parsed.data.status}`);
    return c.json(presentAppointment(clinic, updated!));
  });

  admin.get("/conversations", (c) => {
    const clinic = clinicFor(c, c.req.query("clinic"));
    if (clinic instanceof Response) return clinic;
    const mode = c.req.query("mode");
    return c.json(deps.repo.listConversations(clinic.id, mode === "human" || mode === "bot" ? mode : undefined));
  });

  admin.get("/conversations/:clinic/:phone", (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    audit(c, clinic.id, "view_conversation", phone);
    return c.json({
      conversation: deps.repo.getConversation(clinic.id, phone) ?? null,
      patient: deps.repo.getPatient(clinic.id, phone) ?? null,
      appointments: deps.repo.patientAppointments(clinic.id, phone, toUtcIso(DateTime.utc())).map((a) => presentAppointment(clinic, a)),
      messages: deps.repo.recentMessages(clinic.id, phone, 100),
    });
  });

  admin.post("/conversations/:clinic/:phone/send", async (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    const parsed = SendBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    try {
      await deps.dispatcher.sendAsAdmin(clinic.id, phone, parsed.data.text, { pauseBot: parsed.data.pause_bot });
      audit(c, clinic.id, "send_message", phone);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 502);
    }
  });

  admin.post("/conversations/:clinic/:phone/pause", async (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    const parsed = PauseBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    deps.dispatcher.pauseBot(clinic.id, phone, parsed.data.hours ?? null);
    audit(c, clinic.id, "pause_bot", phone);
    return c.json({ ok: true });
  });

  admin.post("/conversations/:clinic/:phone/resume", (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    deps.dispatcher.resumeBot(clinic.id, phone);
    audit(c, clinic.id, "resume_bot", phone);
    return c.json({ ok: true });
  });

  // ---------- Права пациента ----------

  admin.get("/patients/:clinic/:phone/export", (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    audit(c, clinic.id, "export_patient", phone);
    c.header("Content-Disposition", `attachment; filename="patient-${clinic.id}-${phone}.json"`);
    return c.json({ exported_at: toUtcIso(DateTime.utc()), clinic: clinic.name, ...deps.repo.exportPatient(clinic.id, phone) });
  });

  admin.delete("/patients/:clinic/:phone", (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    // Защита от случайного удаления: номер нужно повторить в параметре confirm.
    if (c.req.query("confirm") !== phone) return c.json({ error: "для удаления добавьте ?confirm=<тот же номер>" }, 400);
    const result = deps.repo.erasePatient(clinic.id, phone, toUtcIso(DateTime.utc()));
    audit(c, clinic.id, "erase_patient", phone, JSON.stringify(result));
    return c.json({ ok: true, ...result });
  });

  admin.get("/privacy-requests", (c) => {
    const clinic = clinicFor(c, c.req.query("clinic"));
    if (clinic instanceof Response) return clinic;
    const status = c.req.query("status");
    return c.json(deps.repo.listPrivacyRequests(clinic.id, status === "open" || status === "done" ? status : undefined));
  });

  // ---------- Блок-лист ----------

  admin.get("/blocklist", (c) => {
    const clinic = clinicFor(c, c.req.query("clinic"));
    if (clinic instanceof Response) return clinic;
    return c.json(deps.repo.listBlocks(clinic.id, toUtcIso(DateTime.utc())));
  });

  admin.post("/blocklist/:clinic/:phone", async (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    const parsed = BlockBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    deps.dispatcher.blockNumber(clinic.id, phone, parsed.data.hours ?? null, parsed.data.reason ?? "заблокирован администратором", actor(c.get("principal")));
    audit(c, clinic.id, "block_number", phone, parsed.data.reason);
    return c.json({ ok: true });
  });

  admin.delete("/blocklist/:clinic/:phone", (c) => {
    const clinic = clinicFor(c, c.req.param("clinic"));
    if (clinic instanceof Response) return clinic;
    const phone = phoneFor(c);
    if (phone instanceof Response) return phone;
    const removed = deps.dispatcher.unblockNumber(clinic.id, phone);
    audit(c, clinic.id, "unblock_number", phone);
    return c.json({ ok: true, removed });
  });

  // ---------- Расходы, аудит, обслуживание ----------

  admin.get("/usage", (c) => {
    const p = c.get("principal");
    const clinicId = c.req.query("clinic") ?? (p.kind === "clinic" ? p.clinicId : undefined);
    if (clinicId && !canAccess(p, clinicId)) return c.json({ error: "нет доступа к этой клинике" }, 403);
    if (!clinicId && p.kind !== "super") return c.json({ error: "укажите ?clinic=" }, 400);
    const today = DateTime.utc().toISODate();
    const from = c.req.query("from") ?? DateTime.utc().minus({ days: 30 }).toISODate();
    const to = c.req.query("to") ?? today;
    if (!isIsoDate(from) || !isIsoDate(to)) return c.json({ error: "даты в формате YYYY-MM-DD" }, 400);
    const rows = deps.repo.usageRange(clinicId ?? null, from, to);
    const total = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    return c.json({ from, to, total_cost_usd: Math.round(total * 10000) / 10000, days: rows });
  });

  admin.get("/audit", (c) => {
    const p = c.get("principal");
    const clinicId = c.req.query("clinic") ?? (p.kind === "clinic" ? p.clinicId : null);
    if (clinicId && !canAccess(p, clinicId)) return c.json({ error: "нет доступа к этой клинике" }, 403);
    if (!clinicId && p.kind !== "super") return c.json({ error: "укажите ?clinic=" }, 400);
    return c.json(deps.repo.auditLog(clinicId, Number(c.req.query("limit") ?? 200)));
  });

  admin.post("/reminders/run", async (c) => {
    const denied = superOnly(c);
    if (denied) return denied;
    audit(c, null, "run_reminders");
    return c.json(await deps.runReminders());
  });

  admin.post("/backup", (c) => {
    const denied = superOnly(c);
    if (denied) return denied;
    if (!deps.runBackup) return c.json({ error: "резервное копирование не настроено" }, 400);
    try {
      const file = deps.runBackup();
      audit(c, null, "backup");
      return c.json({ ok: true, file: file.split(/[\\/]/).pop() });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  return admin;
}
