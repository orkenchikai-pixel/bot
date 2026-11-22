import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { DentalAgent } from "../agent/agent.js";
import { STATUS_RU } from "../agent/prompt.js";
import type { ClinicRegistry } from "../clinic/registry.js";
import { findDoctor, findService, type ClinicConfig } from "../clinic/schema.js";
import { openDatabase } from "../db/database.js";
import { Repo } from "../db/repo.js";
import { Dispatcher, type DispatcherSettings } from "../messaging/dispatcher.js";
import { MemoryTransport } from "../messaging/transport.js";
import { formatAdminEvent, Notifier, type AdminEvent } from "../notify/notifier.js";
import type { FieldCipher } from "../security/crypto.js";
import { DateTime, formatDateTimeLongRu, fromUtcIso, toUtcIso } from "../scheduling/time.js";
import { SIMULATOR_HTML } from "./page.js";

/** Вместо Telegram складывает уведомления администратору в память, чтобы показать их в симуляторе. */
class CollectingNotifier extends Notifier {
  readonly events: Array<{ clinicId: string; phone: string; text: string }> = [];

  override async notify(clinic: ClinicConfig, event: AdminEvent): Promise<void> {
    const phone = "appointment" in event ? event.appointment.patient_phone : "phone" in event ? event.phone : "";
    this.events.push({ clinicId: clinic.id, phone, text: formatAdminEvent(clinic, event) });
  }
}

export interface SimulatorDeps {
  registry: ClinicRegistry;
  agent: DentalAgent;
  dbPath: string;
  adminToken?: string;
  settings: DispatcherSettings;
  cipher?: FieldCipher;
}

const SendBody = z.object({
  clinicId: z.string(),
  phone: z.string().regex(/^\d{5,15}$/, "номер — только цифры"),
  text: z.string().min(1).max(4000),
  name: z.string().max(100).optional(),
  replyId: z.string().max(100).optional(),
});
const ConvBody = z.object({ clinicId: z.string(), phone: z.string().regex(/^\d{5,15}$/) });

/**
 * Веб-симулятор чата: тот же агент и та же логика, но без WhatsApp и в отдельной базе
 * (записи из симулятора не занимают реальное время врачей). Удобно для демонстрации клинике.
 */
export function createSimulatorRoutes(deps: SimulatorDeps): Hono {
  const repo = new Repo(openDatabase(deps.dbPath), deps.cipher);
  const transport = new MemoryTransport();
  const notifier = new CollectingNotifier();
  const dispatcher = new Dispatcher({
    repo,
    registry: deps.registry,
    agent: deps.agent,
    transport,
    notifier,
    settings: { ...deps.settings, debounceMs: 0 },
  });

  const app = new Hono();
  // Ключ передаётся заголовком (страница берёт его из #key=… в адресе — фрагмент не уходит на сервер и в логи).
  app.use("/api/*", async (c, next) => {
    if (deps.adminToken) {
      const key = Buffer.from(c.req.header("x-simulator-key") ?? "");
      const expected = Buffer.from(deps.adminToken);
      if (key.length !== expected.length || !timingSafeEqual(key, expected)) return c.json({ error: "Откройте симулятор по ссылке вида /simulator#key=ADMIN_TOKEN" }, 401);
    }
    await next();
  });

  const appointmentsOf = (clinic: ClinicConfig, phone: string) =>
    repo.patientAppointments(clinic.id, phone, toUtcIso(DateTime.utc())).map((a) => ({
      id: a.id,
      when: formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone)),
      service: findService(clinic, a.service_id)?.name ?? a.service_id,
      doctor: findDoctor(clinic, a.doctor_id)?.name ?? a.doctor_id,
      patient: a.patient_name,
      status: STATUS_RU[a.status] ?? a.status,
    }));

  const isPaused = (clinicId: string, phone: string) => {
    const conv = repo.getConversation(clinicId, phone);
    return conv?.mode === "human" && (conv.human_until === null || conv.human_until > toUtcIso(DateTime.utc()));
  };

  app.get("/", (c) => {
    // nonce из заголовка Content-Security-Policy: браузер выполнит только наши встроенные скрипт и стили.
    const nonce = c.get("secureHeadersNonce") ?? "";
    return c.html(SIMULATOR_HTML.replace("<style>", `<style nonce="${nonce}">`).replace("<script>", `<script nonce="${nonce}">`));
  });

  app.get("/api/clinics", (c) => c.json(deps.registry.list().map((cl) => ({ id: cl.id, name: cl.name, assistant: cl.assistant.name }))));

  app.post("/api/send", async (c) => {
    const parsed = SendBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { clinicId, phone, text, name, replyId } = parsed.data;
    const clinic = deps.registry.get(clinicId);
    if (!clinic) return c.json({ error: "клиника не найдена" }, 404);

    const sentBefore = transport.sent.length;
    const eventsBefore = notifier.events.length;
    await dispatcher.handleInbound({ clinicId, phone, text, profileName: name || undefined, replyId });
    await dispatcher.waitForIdle(clinicId, phone);

    return c.json({
      replies: transport.sent
        .slice(sentBefore)
        .filter((m) => m.to === phone && m.clinicId === clinicId)
        .map((m) => ({ text: m.text, buttons: m.buttons ?? [] })),
      notifications: notifier.events.slice(eventsBefore).filter((e) => e.phone === phone && e.clinicId === clinicId).map((e) => e.text),
      paused: isPaused(clinicId, phone),
      appointments: appointmentsOf(clinic, phone),
    });
  });

  app.post("/api/reset", async (c) => {
    const parsed = ConvBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { clinicId, phone } = parsed.data;
    // Сброс = полное удаление тестового «пациента» (переписка, согласие, записи) — как по запросу на удаление данных.
    repo.erasePatient(clinicId, phone, toUtcIso(DateTime.utc()));
    dispatcher.unblockNumber(clinicId, phone);
    return c.json({ ok: true });
  });

  app.post("/api/resume", async (c) => {
    const parsed = ConvBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    dispatcher.resumeBot(parsed.data.clinicId, parsed.data.phone);
    return c.json({ ok: true });
  });

  return app;
}
