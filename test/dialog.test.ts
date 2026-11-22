import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";
import { DateTime } from "../src/scheduling/time.js";
import { setup } from "./helpers.js";

const PHONE = "77010000001";

function hasThinking(messages: BetaMessageParam[]): boolean {
  return messages.some((m) => typeof m.content !== "string" && m.content?.some((b) => b.type === "thinking"));
}

describe("полный диалог: пациент → агент → инструменты → ответ", () => {
  it("записывает пациента за два хода и хранит историю без thinking-блоков", async () => {
    const t = setup();
    t.claude
      .reply([
        { type: "thinking" },
        { type: "tool_use", name: "find_available_slots", input: { service_id: "consult", date_from: "2026-11-23", part_of_day: "morning" } },
      ])
      .reply([{ type: "thinking" }, { type: "text", text: "Айгерим, есть **09:00**, 10:00 и 11:00 у Ивановой Анны. Какое удобнее?" }])
      .reply([
        {
          type: "tool_use",
          name: "book_appointment",
          input: { service_id: "consult", doctor_id: "ivanova", date: "2026-11-23", time: "10:00", patient_name: "Айгерим" },
        },
      ])
      .reply([{ type: "text", text: "Готово! Ждём вас в понедельник в 10:00." }]);

    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, profileName: "Aigerim", text: "Хочу на консультацию сегодня утром, я Айгерим", waMessageId: "w1" });
    await t.dispatcher.waitForIdle("test", PHONE);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "давайте в 10", waMessageId: "w2" });
    await t.dispatcher.waitForIdle("test", PHONE);

    // Ответы пациенту, Markdown превращён в разметку WhatsApp
    expect(t.transport.messagesTo(PHONE)).toEqual([
      "Айгерим, есть *09:00*, 10:00 и 11:00 у Ивановой Анны. Какое удобнее?",
      "Готово! Ждём вас в понедельник в 10:00.",
    ]);

    // Запись создана, администратор уведомлён
    const appts = t.repo.patientAppointments("test", PHONE, "2026-11-01T00:00:00.000Z");
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ doctor_id: "ivanova", service_id: "consult", patient_name: "Айгерим", status: "booked" });
    expect(t.notifier.events.map((e) => e.type)).toEqual(["appointment_created"]);

    // Первый запрос: кэш системного промпта, статичные инструменты, fallbacks, контекст отдельным system-сообщением
    const first = t.claude.requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.tools).toEqual(TOOL_DEFINITIONS);
    expect(first.system).toMatchObject([{ type: "text", cache_control: { type: "ephemeral" } }]);
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.thinking).toEqual({ type: "adaptive" });
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first.fallbacks).toBe("default");
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect(first.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(String(first.messages[1]!.content)).toContain("понедельник, 23 ноября 2026, 08:00");
    expect(String(first.messages[1]!.content)).toContain("«Aigerim»");

    // Внутри хода thinking-блоки возвращаются в API как есть
    const second = t.claude.requests[1]!;
    expect(hasThinking(second.messages)).toBe(true);
    const toolResult = second.messages.at(-1)!;
    expect(toolResult.role).toBe("user");
    expect(JSON.stringify(toolResult.content)).toContain("09:00");

    // Следующий ход: история без thinking-блоков, затем новое сообщение и свежий контекст
    const third = t.claude.requests[2]!;
    expect(hasThinking(third.messages)).toBe(false);
    expect(third.messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "assistant", "user", "system"]);
    expect(third.messages.at(-2)!.content).toBe("давайте в 10");
    // Системный промпт не меняется между ходами — значит, кэшируется
    expect(third.system).toEqual(first.system);
  });

  it("склеивает несколько сообщений подряд в один ход (debounce)", async () => {
    const t = setup({ debounceMs: 30 });
    t.claude.reply([{ type: "text", text: "Здравствуйте! Чем помочь?" }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Здравствуйте" });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Сколько стоит чистка?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(1);
    expect(t.claude.requests[0]!.messages[0]!.content).toBe("Здравствуйте\nСколько стоит чистка?");
  });

  it("повтор вебхука не вызывает второй ответ", async () => {
    const t = setup();
    t.claude.reply([{ type: "text", text: "Здравствуйте!" }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Привет", waMessageId: "same" });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Привет", waMessageId: "same" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(1);
    expect(t.transport.messagesTo(PHONE)).toHaveLength(1);
  });

  it("после передачи администратору бот молчит и пересылает сообщения, а по таймеру возвращается", async () => {
    const t = setup();
    t.claude
      .reply([{ type: "tool_use", name: "handoff_to_admin", input: { reason: "complaint", summary: "Жалоба на пломбу" } }])
      .reply([{ type: "text", text: "Передала ваш вопрос администратору, он скоро ответит здесь." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "У меня выпала пломба, я недоволен" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.repo.getConversation("test", PHONE)?.mode).toBe("human");

    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Алло?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(2); // новых запросов к Claude нет
    expect(t.transport.messagesTo(PHONE)).toHaveLength(1);
    expect(t.notifier.events.map((e) => e.type)).toEqual(["handoff", "message_while_paused"]);

    // Через 12 часов пауза истекает
    t.setNow(t.now().plus({ hours: 13 }));
    t.claude.reply([{ type: "text", text: "Снова на связи! Чем помочь?" }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Есть кто?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.transport.messagesTo(PHONE).at(-1)).toBe("Снова на связи! Чем помочь?");
    // Бот видит, что писал пациент, пока был на паузе
    expect(String(t.claude.requests.at(-1)!.messages.at(-1)!.content)).toContain("Алло?");
  });

  it("показывает боту ответ администратора и записи пациента в служебном контексте", async () => {
    const t = setup();
    await t.dispatcher.sendAsAdmin("test", PHONE, "Добрый день! Это Алия, администратор.", { pauseBot: false });
    t.repo.createAppointment({
      clinicId: "test",
      patientPhone: PHONE,
      patientName: "Айгерим",
      doctorId: "ivanova",
      serviceId: "cleaning",
      startUtc: "2026-11-24T04:00:00.000Z",
      endUtc: "2026-11-24T05:00:00.000Z",
      nowUtc: "2026-11-20T00:00:00.000Z",
      maxActivePerPatient: 3,
    });
    t.claude.reply([{ type: "text", text: "Да, вы записаны на вторник в 09:00." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Я записана?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    const context = String(t.claude.requests[0]!.messages.at(-1)!.content);
    expect(context).toContain("администратор клиники] Добрый день! Это Алия");
    expect(context).toContain("24.11 (вт) в 09:00, Чистка, врач Иванова Анна");
  });

  it("при отказе модели отвечает вежливо и зовёт администратора", async () => {
    const t = setup();
    t.claude.reply([], "refusal");
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "…" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.transport.messagesTo(PHONE)[0]).toContain("передано администратору");
    expect(t.repo.getConversation("test", PHONE)?.mode).toBe("human");
    // История остаётся валидной для API: служебное system-сообщение стоит перед ответом ассистента
    const stored = t.repo.recentTurns("test", PHONE, 10, "2026-01-01T00:00:00.000Z")[0]!;
    expect(stored.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
  });

  it("при ошибке API извиняется и уведомляет администратора", async () => {
    const t = setup();
    t.claude.fail(new Error("overloaded"));
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Здравствуйте" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.transport.messagesTo(PHONE)[0]).toContain("техническая заминка");
    expect(t.notifier.events).toMatchObject([{ type: "agent_error", error: "overloaded" }]);
  });

  it("не зацикливается: после лимита шагов отдаёт диалог администратору", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.claude.reply([{ type: "tool_use", name: "get_my_appointments", input: {} }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Мои записи?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.remaining).toBe(0);
    expect(t.transport.messagesTo(PHONE)[0]).toContain("передан администратору");
    expect(t.repo.getConversation("test", PHONE)?.mode).toBe("human");
  });

  it("при спаме ставит бота на паузу и не тратит токены", async () => {
    const t = setup();
    for (let i = 0; i < 40; i++) t.repo.appendTurn("test", PHONE, [{ role: "user", content: `сообщение ${i}` }], "2026-11-23T02:30:00.000Z");
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "ещё одно" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.claude.requests).toHaveLength(0);
    expect(t.repo.getConversation("test", PHONE)?.mode).toBe("human");
    expect(t.notifier.events.map((e) => e.type)).toEqual(["handoff"]);
  });

  it("текст перед вызовом инструмента отправляется сразу", async () => {
    const t = setup();
    t.claude
      .reply([
        { type: "text", text: "Минутку, проверю расписание." },
        { type: "tool_use", name: "find_available_slots", input: { service_id: "cleaning", date_from: "2026-11-25" } },
      ])
      .reply([{ type: "text", text: "В среду свободно с 10:00." }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: PHONE, text: "Чистка в среду?" });
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.transport.messagesTo(PHONE)).toEqual(["Минутку, проверю расписание.", "В среду свободно с 10:00."]);
  });

  it("восстанавливает необработанные сообщения после перезапуска", async () => {
    const t = setup();
    t.repo.ensureConversation("test", PHONE, "2026-11-23T02:59:00.000Z");
    t.repo.logInbound({ clinicId: "test", phone: PHONE, text: "Вы работаете в субботу?", createdAtUtc: "2026-11-23T02:58:00.000Z" });
    t.claude.reply([{ type: "text", text: "В субботу не работаем." }]);
    expect(t.dispatcher.recoverUnprocessed()).toBe(1);
    await t.dispatcher.waitForIdle("test", PHONE);
    expect(t.transport.messagesTo(PHONE)).toEqual(["В субботу не работаем."]);
    expect(t.repo.unprocessedInbound("2026-11-01T00:00:00.000Z")).toEqual([]);
  });

  it("на моделях без mid-conversation system кладёт контекст в сообщение пациента", async () => {
    const t = setup();
    const { DentalAgent } = await import("../src/agent/agent.js");
    const agent = new DentalAgent(t.claude, { model: "claude-sonnet-5", effort: "low", maxTokens: 8000, fallbacks: "default", maxToolRounds: 3 });
    t.claude.reply([{ type: "text", text: "Здравствуйте!" }]);
    await agent.runTurn({
      clinic: t.clinic,
      history: [],
      userContent: "Привет",
      contextNote: "Служебный контекст",
      tools: { clinic: t.clinic, phone: PHONE, repo: t.repo, now: () => DateTime.utc(), notify: () => undefined, requestHandoff: () => undefined },
    });
    const req = t.claude.requests[0]!;
    expect(req.messages).toHaveLength(1);
    expect(JSON.stringify(req.messages[0]!.content)).toContain("<context>");
    expect(req.fallbacks).toBeUndefined(); // для claude-sonnet-5 серверных fallbacks нет
  });
});
