import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, productionProblems } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { formatAdminEvent, Notifier, type AdminEvent } from "../src/notify/notifier.js";
import { backupDatabase } from "../src/ops/backup.js";
import { WhatsAppApiError, WhatsAppCloudClient } from "../src/whatsapp/client.js";
import { testClinic } from "./helpers.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clinic = testClinic();

describe("WhatsApp Cloud API клиент", () => {
  it("отправляет текст с токеном и правильным телом", async () => {
    const f = fakeFetch(() => json({ messages: [{ id: "wamid.out1" }] }));
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "TOKEN", fetchImpl: f.impl });
    const res = await client.sendText(clinic, "77010000001", "Здравствуйте!");
    expect(res.messageId).toBe("wamid.out1");
    expect(f.calls[0]!.url).toBe("https://graph.facebook.com/v27.0/PN1/messages");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "77010000001",
      type: "text",
      text: { preview_url: false, body: "Здравствуйте!" },
    });
  });

  it("берёт токен клиники из её переменной окружения", async () => {
    const f = fakeFetch(() => json({}));
    const own = testClinic({ whatsapp: { phone_number_id: "PN9", access_token_env: "WA_TOKEN_TEST" } });
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "DEFAULT", fetchImpl: f.impl, env: { WA_TOKEN_TEST: "CLINIC_TOKEN" } });
    await client.markReadAndTyping(own, "wamid.in1");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer CLINIC_TOKEN");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.in1",
      typing_indicator: { type: "text" },
    });
    await expect(new WhatsAppCloudClient({ apiVersion: "v27.0", fetchImpl: f.impl, env: {} }).sendText(own, "1", "x")).rejects.toThrow(/WA_TOKEN_TEST/);
  });

  it("кнопки: до 3 штук, заголовок до 20 символов, длинный текст — отдельным сообщением", async () => {
    const f = fakeFetch(() => json({ messages: [{ id: "x" }] }));
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: f.impl });
    await client.sendButtons(clinic, "7701", "а".repeat(1500), [
      { id: "a", title: "Очень длинное название кнопки" },
      { id: "b", title: "Два" },
      { id: "c", title: "Три" },
      { id: "d", title: "Четыре" },
    ]);
    expect(f.calls).toHaveLength(2);
    const interactive = JSON.parse(String(f.calls[1]!.init.body)).interactive;
    expect(interactive.body.text).toBe("Выберите вариант:");
    expect(interactive.action.buttons).toHaveLength(3);
    expect(interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });

  it("шаблон напоминания", async () => {
    const f = fakeFetch(() => json({ messages: [{ id: "x" }] }));
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: f.impl });
    await client.sendTemplate(clinic, "7701", { name: "appointment_reminder", language: "ru", bodyParams: ["Айгерим", "пн, 23 ноября"] });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.template).toEqual({
      name: "appointment_reminder",
      language: { code: "ru" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Айгерим" }, { type: "text", text: "пн, 23 ноября" }] }],
    });
  });

  it("понятно объясняет ошибку 24-часового окна", async () => {
    const f = fakeFetch(() => json({ error: { code: 131047, message: "Re-engagement message" } }, 400));
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: f.impl });
    const error = await client.sendText(clinic, "7701", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect(String((error as Error).message)).toContain("больше 24 часов");
  });

  it("скачивание фото: только с серверов Meta и с ограничением размера", async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const ok = fakeFetch((url) =>
      url.includes("graph.facebook.com")
        ? json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "image/jpeg", file_size: 4 })
        : new Response(image, { status: 200 }),
    );
    const client = new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: ok.impl });
    const media = await client.downloadMedia(clinic, "MEDIA1");
    expect(media).toEqual({ data: image, mimeType: "image/jpeg" });

    const evil = fakeFetch(() => json({ url: "https://attacker.example/steal", mime_type: "image/jpeg" }));
    await expect(new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: evil.impl }).downloadMedia(clinic, "MEDIA1")).rejects.toThrow(
      /не на сервер Meta/,
    );
    expect(evil.calls).toHaveLength(1); // токен на чужой сервер не ушёл

    const huge = fakeFetch(() => json({ url: "https://lookaside.fbsbx.com/x", mime_type: "image/jpeg", file_size: 50 * 1024 * 1024 }));
    await expect(new WhatsAppCloudClient({ apiVersion: "v27.0", defaultAccessToken: "T", fetchImpl: huge.impl }).downloadMedia(clinic, "M")).rejects.toThrow(/большое/);
    await expect(client.downloadMedia(clinic, "../../etc/passwd")).rejects.toThrow(/media id/);
  });
});

describe("уведомления администраторам", () => {
  it("отправляет в Telegram и на вебхук CRM", async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const notifier = new Notifier({ telegramBotToken: "BOT", fetchImpl: f.impl });
    const withChannels = testClinic({ notifications: { telegram_chat_ids: ["-100123"], webhook_url: "https://crm.example.com/hook" } });
    await notifier.notify(withChannels, { type: "handoff", phone: "77010000001", patientName: "Айгерим", reason: "complaint", summary: "Недовольна" });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.telegram.org/botBOT/sendMessage", "https://crm.example.com/hook"]);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ chat_id: "-100123" });
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({ clinic_id: "test", event: "handoff" });
  });

  it("ошибка доставки уведомления не ломает работу", async () => {
    const notifier = new Notifier({ telegramBotToken: "BOT", fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch });
    await expect(notifier.notify(testClinic({ notifications: { telegram_chat_ids: ["1"] } }), { type: "agent_error", phone: "7701", error: "x" })).resolves.toBeUndefined();
  });

  it("все типы событий форматируются", () => {
    const appointment = {
      id: 1, clinic_id: "test", patient_phone: "77010000001", patient_name: "Айгерим", doctor_id: "ivanova", service_id: "consult",
      start_utc: "2026-11-24T04:00:00.000Z", end_utc: "2026-11-24T04:30:00.000Z", status: "booked" as const, comment: "болит", source: "whatsapp",
      cancel_reason: null, reminder_status: null, reminder_at: null, created_at: "", updated_at: "",
    };
    const events: AdminEvent[] = [
      { type: "appointment_created", appointment },
      { type: "appointment_rescheduled", appointment, previousStartUtc: "2026-11-23T04:00:00.000Z" },
      { type: "appointment_cancelled", appointment },
      { type: "appointment_confirmed", appointment },
      { type: "handoff", phone: "7701", reason: "medical_urgent", summary: "отёк" },
      { type: "message_while_paused", phone: "7701", text: "алло" },
      { type: "agent_error", phone: "7701", error: "timeout" },
      { type: "reminder_not_sent", appointment, reason: "нет шаблона" },
      { type: "privacy_request", phone: "7701", kind: "delete_data" },
      { type: "security_alert", phone: "7701", issue: "canary_leak" },
      { type: "spam_blocked", phone: "7701", reason: "hour_limit", hours: 24 },
      { type: "budget_exceeded", scope: "clinic", spentUsd: 15.2, limitUsd: 15 },
      { type: "stale_message", phone: "7701", text: "старое", sentAt: "вчера" },
    ];
    for (const event of events) expect(formatAdminEvent(clinic, event)).toContain("Тест Дент");
    expect(formatAdminEvent(clinic, events[0]!)).toContain("вторник, 24 ноября 2026, 09:00");
  });
});

describe("эксплуатация", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dental-backup-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("резервная копия базы создаётся и старые копии удаляются", async () => {
    const db = openDatabase(path.join(dir, "app.db"));
    db.exec("INSERT INTO patients (clinic_id, phone, created_at, updated_at) VALUES ('c', '7701', 'x', 'x')");
    const first = backupDatabase(db, path.join(dir, "backups"), 2);
    expect(existsSync(first)).toBe(true);
    const restored = openDatabase(first);
    expect((restored.prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }).n).toBe(1);
    restored.close();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1100)); // имена файлов — с точностью до секунды
      backupDatabase(db, path.join(dir, "backups"), 2);
    }
    expect(readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db"))).toHaveLength(2);
    db.close();
  }, 15_000);

  it("production не запустится без секретов и с плейсхолдерами", () => {
    const config = loadConfig({ ADMIN_TOKEN: "short" });
    const { errors } = productionProblems(config, [testClinic({ whatsapp: { phone_number_id: "REPLACE_ME" } })], {});
    expect(errors.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    expect(errors.join("\n")).toMatch(/WHATSAPP_APP_SECRET/);
    expect(errors.join("\n")).toMatch(/ADMIN_TOKEN/);
    expect(errors.join("\n")).toMatch(/DATA_ENCRYPTION_KEY/);
    expect(errors.join("\n")).toMatch(/phone_number_id/);

    const good = loadConfig({
      WHATSAPP_APP_SECRET: "s",
      WHATSAPP_VERIFY_TOKEN: "verify-token-1234567",
      WHATSAPP_ACCESS_TOKEN: "t",
      ADMIN_TOKEN: "a".repeat(40),
      DATA_ENCRYPTION_KEY: "k".repeat(32),
      CANARY_SECRET: "c",
    });
    const ok = productionProblems(good, [testClinic({ privacy: { consent_mode: "explicit", policy_url: "https://x.kz/p" } })], { ANTHROPIC_API_KEY: "sk" });
    expect(ok).toEqual({ errors: [], warnings: [] });
  });
});
