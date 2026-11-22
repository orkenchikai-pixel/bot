import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createSimulatorRoutes } from "../src/simulator/simulator.js";
import { MONDAY_8AM, setup } from "./helpers.js";

const SECRET = "app-secret";

function build() {
  const t = setup();
  const app = createApp({
    registry: t.registry,
    dispatcher: t.dispatcher,
    whatsapp: { verifyToken: "verify-me", appSecret: SECRET },
    admin: {
      adminToken: "admin-token",
      clinicsDir: "./clinics",
      registry: t.registry,
      repo: t.repo,
      dispatcher: t.dispatcher,
      runReminders: async () => ({ sent: 0, skipped: 0 }),
    },
    simulator: createSimulatorRoutes({
      registry: t.registry,
      agent: t.agent,
      dbPath: ":memory:",
      settings: { debounceMs: 0, handoffHours: 12, historyMaxTurns: 20, historyDays: 14 },
    }),
  });
  return { ...t, app };
}

function webhookBody(text: string, id = "wamid.1", timestamp = String(Math.floor(MONDAY_8AM.toSeconds()))) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "77000000000", phone_number_id: "PN1" },
              contacts: [{ profile: { name: "Айгерим" }, wa_id: "77010000001" }],
              messages: [{ from: "77010000001", id, timestamp, type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("HTTP: вебхук WhatsApp", () => {
  it("подтверждает вебхук по verify token", async () => {
    const { app } = build();
    const ok = await app.request("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await ok.text()).toBe("42");
    const bad = await app.request("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  it("отклоняет неподписанные запросы и обрабатывает подписанные", async () => {
    const t = build();
    const body = webhookBody("Сколько стоит чистка?");
    const unsigned = await t.app.request("/webhook/whatsapp", { method: "POST", body });
    expect(unsigned.status).toBe(401);

    t.claude.reply([{ type: "text", text: "Профессиональная чистка — 25 000 ₸." }]);
    const res = await t.app.request("/webhook/whatsapp", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": sign(body), "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    await t.dispatcher.waitForIdle("test", "77010000001");
    expect(t.transport.messagesTo("77010000001")).toEqual(["Профессиональная чистка — 25 000 ₸."]);
    expect(t.repo.getPatient("test", "77010000001")?.wa_profile_name).toBe("Айгерим");
  });
});

describe("HTTP: админ-API", () => {
  it("требует токен и отдаёт записи и переписку", async () => {
    const t = build();
    expect((await t.app.request("/admin/clinics")).status).toBe(401);
    const auth = { headers: { Authorization: "Bearer admin-token" } };
    const clinics = await (await t.app.request("/admin/clinics", auth)).json();
    expect(clinics).toMatchObject([{ id: "test", phone_number_id: "PN1" }]);

    t.repo.createAppointment({
      clinicId: "test",
      patientPhone: "77010000001",
      patientName: "Айгерим",
      doctorId: "ivanova",
      serviceId: "consult",
      startUtc: "2026-11-24T04:00:00.000Z",
      endUtc: "2026-11-24T04:30:00.000Z",
      nowUtc: "2026-11-23T00:00:00.000Z",
      maxActivePerPatient: 3,
    });
    const list = await (await t.app.request("/admin/appointments?clinic=test&from=2026-11-23&to=2026-11-30", auth)).json();
    expect(list).toMatchObject([{ patient_name: "Айгерим", doctor_name: "Иванова Анна", when: "вторник, 24 ноября 2026, 09:00" }]);

    const sent = await t.app.request("/admin/conversations/test/77010000001/send", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Здравствуйте! Это администратор." }),
    });
    expect(sent.status).toBe(200);
    expect(t.transport.messagesTo("77010000001")).toEqual(["Здравствуйте! Это администратор."]);
    // После ответа администратора бот в этом чате на паузе
    expect(t.repo.getConversation("test", "77010000001")?.mode).toBe("human");
    const resumed = await t.app.request("/admin/conversations/test/77010000001/resume", { method: "POST", ...auth });
    expect(resumed.status).toBe(200);
    expect(t.repo.getConversation("test", "77010000001")?.mode).toBe("bot");
  });
});

describe("HTTP: веб-симулятор", () => {
  it("отвечает как бот и показывает записи и уведомления", async () => {
    const t = build();
    t.claude
      .reply([
        {
          type: "tool_use",
          name: "book_appointment",
          input: { service_id: "consult", doctor_id: "ivanova", date: "2026-11-23", time: "10:00", patient_name: "Айгерим" },
        },
      ])
      .reply([{ type: "text", text: "Записала вас на 10:00!" }]);
    const res = await t.app.request("/simulator/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: "test", phone: "79990000001", text: "Запишите на 10:00, я Айгерим" }),
    });
    const data = (await res.json()) as { replies: Array<{ text: string }>; appointments: unknown[]; notifications: string[]; paused: boolean };
    expect(data.replies.map((r) => r.text)).toEqual(["Записала вас на 10:00!"]);
    expect(data.appointments).toHaveLength(1);
    expect(data.notifications[0]).toContain("Новая запись");
    expect(data.paused).toBe(false);
    // Запись из симулятора не попала в рабочую базу
    expect(t.repo.patientAppointments("test", "79990000001", "2026-01-01T00:00:00.000Z")).toEqual([]);
  });
});
