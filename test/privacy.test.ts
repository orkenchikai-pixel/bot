import { describe, expect, it } from "vitest";
import { executeTool } from "../src/agent/tools.js";
import { CONSENT_NO_ID, CONSENT_YES_ID, detectConsentAnswer, detectReminderCommand } from "../src/privacy/consent.js";
import { runRetention } from "../src/privacy/retention.js";
import { runReminderPass } from "../src/reminders/scheduler.js";
import { DateTime } from "../src/scheduling/time.js";
import { MemoryTransport } from "../src/messaging/transport.js";
import { MONDAY_8AM, setup, testClinic } from "./helpers.js";

const PHONE = "77010000001";
const explicitClinic = () =>
  testClinic({ phone: "+7 700 000 00 00", privacy: { consent_mode: "explicit", policy_url: "https://tes.kz/privacy", operator_name: "ТОО «Тест Дент»", consent_version: "2026-11" } });

describe("распознавание ответов", () => {
  it.each([
    ["да", "yes"],
    ["Согласна!", "yes"],
    ["иә", "yes"],
    ["Нет", "no"],
    ["не согласен", "no"],
    ["да, а сколько стоит чистка?", null],
    ["", null],
  ])("«%s» → %s", (text, expected) => {
    expect(detectConsentAnswer(text)).toBe(expected);
  });

  it("кнопки распознаются по id независимо от текста", () => {
    expect(detectConsentAnswer("что угодно", CONSENT_YES_ID)).toBe("yes");
    expect(detectConsentAnswer("что угодно", CONSENT_NO_ID)).toBe("no");
  });

  it("команды рассылок", () => {
    expect(detectReminderCommand("СТОП")).toBe("stop");
    expect(detectReminderCommand("stop!")).toBe("stop");
    expect(detectReminderCommand("Старт")).toBe("start");
    expect(detectReminderCommand("остановите запись")).toBeNull();
  });
});

describe("явное согласие (explicit)", () => {
  it("до согласия ИИ ничего не получает; после «Согласен» отвечает на исходный вопрос", async () => {
    const t = setup({ clinic: explicitClinic() });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Сколько стоит чистка?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    const request = t.transport.sent.at(-1)!;
    expect(request.text).toContain("ИИ-помощник клиники «Тест Дент»");
    expect(request.text).toContain("https://tes.kz/privacy");
    expect(request.text).toContain("ТОО «Тест Дент»");
    expect(request.buttons?.map((b) => b.id)).toEqual([CONSENT_YES_ID, CONSENT_NO_ID]);

    // Пишет ещё раз, не ответив, — повторно не спамим запросом согласия
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "И отбеливание тоже" });
    expect(t.transport.sent).toHaveLength(1);

    t.claude.reply([{ type: "text", text: "Чистка — 25 000 ₸, отбеливание уточню." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "✅ Согласен", replyId: CONSENT_YES_ID });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(1);
    expect(t.claude.requests[0]!.messages[0]!.content).toBe("Сколько стоит чистка?\nИ отбеливание тоже");
    expect(t.transport.messagesTo(PHONE).at(-1)).toBe("Чистка — 25 000 ₸, отбеливание уточню.");

    const patient = t.repo.getPatient("test", PHONE)!;
    expect(patient).toMatchObject({ consent_status: "granted", consent_version: "2026-11", consent_method: "button" });
    expect(t.repo.consentLog("test", PHONE).map((r) => r.action)).toEqual(["requested", "granted"]);
  });

  it("отказ: ИИ не обрабатывает, вопросы уходят администратору, случайное «да» не возвращает ИИ", async () => {
    const t = setup({ clinic: explicitClinic() });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Хочу записаться" });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Нет" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    expect(t.transport.messagesTo(PHONE).at(-1)).toContain("ИИ-помощник не будет обрабатывать");
    expect(t.notifier.events).toMatchObject([{ type: "handoff", reason: "consent_refused" }]);

    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "да" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    expect(t.notifier.events.at(-1)).toMatchObject({ type: "message_while_paused", text: "да" });
    expect(t.repo.getPatient("test", PHONE)?.consent_status).toBe("refused");
  });

  it("новая версия политики — согласие спрашивается заново", async () => {
    const t = setup({ clinic: explicitClinic() });
    t.repo.touchPatient("test", PHONE, undefined, "2026-11-01T00:00:00.000Z");
    t.repo.setConsent("test", PHONE, { status: "granted", version: "2026-01", method: "button", atUtc: "2026-11-01T00:00:00.000Z" });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Здравствуйте" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    expect(t.transport.sent.at(-1)?.buttons).toBeDefined();
  });

  it("после перезапуска сервера сообщения без согласия не уходят ИИ", async () => {
    const t = setup({ clinic: explicitClinic() });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Вопрос до согласия" });
    expect(t.dispatcher.recoverUnprocessed()).toBe(0);
    expect(t.claude.requests).toHaveLength(0);
  });

  it("отзыв согласия через ИИ: дальше сообщения получает администратор", async () => {
    const t = setup({ clinic: explicitClinic() });
    t.repo.touchPatient("test", PHONE, undefined, "2026-11-01T00:00:00.000Z");
    t.repo.setConsent("test", PHONE, { status: "granted", version: "2026-11", method: "button", atUtc: "2026-11-01T00:00:00.000Z" });
    t.claude
      .reply([{ type: "tool_use", name: "privacy_request", input: { kind: "withdraw_consent" } }])
      .reply([{ type: "text", text: "Готово, согласие отозвано. Дальше вам ответит администратор." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Отзываю согласие на обработку данных" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.repo.getPatient("test", PHONE)?.consent_status).toBe("withdrawn");
    expect(t.repo.listPrivacyRequests("test")).toMatchObject([{ kind: "withdraw_consent", status: "open" }]);

    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "А можно на завтра?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(2); // новых запросов к ИИ нет
    expect(t.notifier.events.map((e) => e.type)).toEqual(["privacy_request", "message_while_paused"]);
  });
});

describe("уведомление (notice)", () => {
  it("показывается один раз, затем отвечает ИИ", async () => {
    const t = setup({ clinic: testClinic({ privacy: { consent_mode: "notice", policy_url: "https://tes.kz/privacy" } }) });
    t.claude.reply([{ type: "text", text: "Здравствуйте! Чем помочь?" }]).reply([{ type: "text", text: "Чистка — 25 000 ₸" }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Привет" });
    await t.dispatcher.waitForIdle("test", PHONE);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Сколько стоит чистка?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    const sent = t.transport.messagesTo(PHONE);
    expect(sent[0]).toContain("Вам отвечает ИИ-помощник");
    expect(sent.slice(1)).toEqual(["Здравствуйте! Чем помочь?", "Чистка — 25 000 ₸"]);
    expect(t.repo.consentLog("test", PHONE).map((r) => r.action)).toEqual(["notice_shown"]);
  });
});

describe("отписка от напоминаний", () => {
  it("«СТОП» работает без ИИ и отключает напоминания", async () => {
    const t = setup();
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "СТОП" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    expect(t.transport.messagesTo(PHONE)[0]).toContain("больше не будут приходить");
    expect(t.repo.getPatient("test", PHONE)?.reminders_opt_out).toBe(1);

    t.repo.createAppointment({
      clinicId: "test",
      patientPhone: PHONE,
      patientName: "Айгерим",
      doctorId: "ivanova",
      serviceId: "consult",
      startUtc: "2026-11-24T04:00:00.000Z",
      endUtc: "2026-11-24T04:30:00.000Z",
      nowUtc: "2026-11-20T00:00:00.000Z",
      maxActivePerPatient: 3,
    });
    const transport = new MemoryTransport();
    const result = await runReminderPass({ repo: t.repo, registry: t.registry, transport, notifier: t.notifier, now: () => MONDAY_8AM });
    expect(result.sent).toBe(0);
    expect(transport.sent).toEqual([]);

    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "старт" });
    expect(t.repo.getPatient("test", PHONE)?.reminders_opt_out).toBe(0);
  });
});

describe("хранение данных", () => {
  it("тексты, имена и история в базе зашифрованы, приложение видит их открытыми", async () => {
    const t = setup({ cipherKey: "test-encryption-key-123" });
    t.claude.reply([{ type: "text", text: "Сочувствую, давайте запишем вас к врачу." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, profileName: "Айгерим", text: "Болит зуб мудрости" });
    await t.dispatcher.waitForIdle("test", PHONE);
    t.repo.setPatientName("test", PHONE, "Айгерим Сапарова", "2026-11-23T03:00:00.000Z");

    const raw = (sql: string) => t.repo.db.prepare(sql).all() as Array<Record<string, string>>;
    const messages = raw("SELECT text FROM message_log");
    expect(messages.every((m) => m.text!.startsWith("enc:v1:"))).toBe(true);
    expect(JSON.stringify(raw("SELECT * FROM message_log"))).not.toContain("Болит");
    expect(JSON.stringify(raw("SELECT * FROM turns"))).not.toContain("Болит");
    expect(JSON.stringify(raw("SELECT * FROM patients"))).not.toContain("Айгерим");

    expect(t.repo.recentMessages("test", PHONE).map((m) => m.text)).toContain("Болит зуб мудрости");
    expect(t.repo.getPatient("test", PHONE)?.name).toBe("Айгерим Сапарова");
    expect(JSON.stringify(t.repo.recentTurns("test", PHONE, 5, "2026-01-01T00:00:00.000Z"))).toContain("Болит зуб мудрости");
  });

  it("выгрузка и удаление данных пациента", async () => {
    const t = setup({ cipherKey: "test-encryption-key-123" });
    t.claude.reply([{ type: "tool_use", name: "book_appointment", input: { service_id: "consult", doctor_id: "ivanova", date: "2026-11-30", time: "10:00", patient_name: "Айгерим" } }]);
    // 30.11 у врача выходной — запишем на вторник 24.11 вторым ответом
    t.claude.reply([{ type: "tool_use", name: "book_appointment", input: { service_id: "consult", doctor_id: "ivanova", date: "2026-11-24", time: "10:00", patient_name: "Айгерим" } }]);
    t.claude.reply([{ type: "text", text: "Записала на вторник в 10:00." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Запишите меня" });
    await t.dispatcher.waitForIdle("test", PHONE);

    const exported = t.repo.exportPatient("test", PHONE);
    expect(exported.appointments).toHaveLength(1);
    expect(exported.messages.map((m) => m.text)).toContain("Запишите меня");

    const result = t.repo.erasePatient("test", PHONE, "2026-11-23T03:30:00.000Z");
    expect(result.messages).toBeGreaterThan(0);
    const after = t.repo.exportPatient("test", PHONE);
    expect(after.patient).toBeNull();
    expect(after.messages).toEqual([]);
    expect(after.appointments).toEqual([]);
    const anonymized = t.repo.db.prepare("SELECT patient_phone, status FROM appointments").all() as Array<{ patient_phone: string; status: string }>;
    expect(anonymized[0]).toMatchObject({ status: "cancelled" });
    expect(anonymized[0]!.patient_phone.startsWith("anon:")).toBe(true);
  });

  it("автоочистка удаляет старую переписку и обезличивает старые записи", () => {
    const t = setup();
    t.repo.logInbound({ clinicId: "test", phone: PHONE, text: "старое", createdAtUtc: "2025-01-01T00:00:00.000Z" });
    t.repo.logInbound({ clinicId: "test", phone: PHONE, text: "новое", createdAtUtc: "2026-11-20T00:00:00.000Z" });
    t.repo.createAppointment({
      clinicId: "test",
      patientPhone: PHONE,
      patientName: "Айгерим",
      doctorId: "ivanova",
      serviceId: "consult",
      startUtc: "2022-01-10T04:00:00.000Z",
      endUtc: "2022-01-10T04:30:00.000Z",
      nowUtc: "2022-01-01T00:00:00.000Z",
      maxActivePerPatient: 3,
    });
    const result = runRetention(t.repo, { messagesDays: 180, appointmentsDays: 1095, auditDays: 1095 }, DateTime.fromISO("2026-11-23T00:00:00Z"));
    expect(result).toMatchObject({ messages: 1, appointments: 1 });
    expect(t.repo.recentMessages("test", PHONE).map((m) => m.text)).toEqual(["новое"]);
    const row = t.repo.db.prepare("SELECT patient_phone FROM appointments").get() as { patient_phone: string };
    expect(row.patient_phone.startsWith("anon:")).toBe(true);
  });

  it("запрос на удаление данных через ИИ создаёт задачу администратору", async () => {
    const t = setup();
    const ctx = { clinic: t.clinic, phone: PHONE, repo: t.repo, now: t.now, notify: (e: unknown) => events.push(e), requestHandoff: () => undefined };
    const events: unknown[] = [];
    t.repo.touchPatient("test", PHONE, "Aigerim", "2026-11-23T03:00:00.000Z");
    const res = await executeTool("privacy_request", { kind: "delete_data", details: "удалите всё" }, ctx);
    expect(JSON.parse(res.content).status).toBe("accepted");
    expect(t.repo.listPrivacyRequests("test", "open")).toMatchObject([{ kind: "delete_data", details: "удалите всё" }]);
    expect(events).toMatchObject([{ type: "privacy_request", kind: "delete_data" }]);
  });
});

describe("надёжность запроса согласия", () => {
  it("если запрос согласия не доставлен, следующее сообщение пробует снова", async () => {
    const t = setup({ clinic: explicitClinic() });
    let fail = true;
    const original = t.transport.sendButtons.bind(t.transport);
    t.transport.sendButtons = async (...args: Parameters<typeof original>) => {
      if (fail) throw new Error("WhatsApp недоступен");
      return original(...args);
    };
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Здравствуйте" });
    expect(t.repo.getPatient("test", PHONE)?.consent_prompted_at).toBeNull();
    fail = false;
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Алло" });
    expect(t.transport.sent.at(-1)?.buttons).toBeDefined();
    expect(t.repo.getPatient("test", PHONE)?.consent_prompted_at).not.toBeNull();
  });
});
