import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "../src/billing/usage.js";
import { setup, testClinic } from "./helpers.js";

describe("оценка стоимости", () => {
  it("считает по тарифу модели, включая кэш", () => {
    // Opus 5.5: $4 вход, $20 выход, $0.20 чтение кэша, $5 запись в кэш за 1 млн токенов
    expect(estimateCostUsd("claude-opus-5-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(4);
    expect(estimateCostUsd("claude-opus-5-5", { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(25.2);
  });

  it("неизвестную модель считает по завышенному тарифу (бюджет сработает раньше)", () => {
    expect(priceFor("claude-unknown-9").input).toBeGreaterThanOrEqual(priceFor("claude-fable-5-2").input);
    expect(priceFor("claude-sonnet-5-5-20990101").input).toBe(2);
  });
});

describe("дневной бюджет", () => {
  it("расход записывается по клинике и дню", async () => {
    const t = setup();
    t.claude.reply([{ type: "text", text: "Здравствуйте!" }]);
    await t.dispatcher.handleInbound({ clinicId: "test", phone: "77010000001", text: "Привет" });
    await t.dispatcher.waitForIdle("test", "77010000001");
    const [row] = t.repo.usageRange("test", "2026-11-23", "2026-11-23");
    expect(row).toMatchObject({ turns: 1, requests: 1, input_tokens: 100, output_tokens: 20 });
    expect(row!.cost_usd).toBeCloseTo((100 * 4 + 20 * 20) / 1_000_000);
  });

  it("при превышении бюджета клиники ИИ не вызывается, пациент получает одно сообщение, админ — одно уведомление", async () => {
    const t = setup({ clinic: testClinic({ privacy: { consent_mode: "off" }, limits: { daily_budget_usd: 1 } }) });
    t.repo.addUsage("test", "2026-11-23", { turns: 50, requests: 80, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 });
    for (const text of ["Привет", "Алло?", "Ответьте"]) {
      await t.dispatcher.handleInbound({ clinicId: "test", phone: "77010000001", text });
      await t.dispatcher.waitForIdle("test", "77010000001");
    }
    expect(t.claude.requests).toHaveLength(0);
    expect(t.transport.messagesTo("77010000001")).toHaveLength(1);
    const types = t.notifier.events.map((e) => e.type);
    expect(types.filter((x) => x === "budget_exceeded")).toHaveLength(1);
    expect(types.filter((x) => x === "message_while_paused")).toHaveLength(3);
  });

  it("общий бюджет сервиса тоже соблюдается", async () => {
    const t = setup({ settings: { globalDailyBudgetUsd: 5 } });
    t.repo.addUsage("other-clinic", "2026-11-23", { turns: 1, requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 6 });
    await t.dispatcher.handleInbound({ clinicId: "test", phone: "77010000001", text: "Привет" });
    await t.dispatcher.waitForIdle("test", "77010000001");
    expect(t.claude.requests).toHaveLength(0);
    expect(t.notifier.events.find((e) => e.type === "budget_exceeded")).toMatchObject({ scope: "global" });
  });
});

describe("нагрузка", () => {
  it("одновременно к ИИ идёт не больше AI_MAX_CONCURRENT запросов", async () => {
    const t = setup({ aiConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const original = t.claude.beta.messages.create;
    t.claude.beta.messages.create = async (params) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return original(params);
    };
    const phones = Array.from({ length: 6 }, (_, i) => `7701000010${i}`);
    for (const _ of phones) t.claude.reply([{ type: "text", text: "Здравствуйте!" }]);
    await Promise.all(phones.map((phone) => t.dispatcher.handleInbound({ clinicId: "test", phone, text: "Привет" })));
    await Promise.all(phones.map((phone) => t.dispatcher.waitForIdle("test", phone)));
    expect(peak).toBe(2);
    expect(phones.every((p) => t.transport.messagesTo(p).length === 1)).toBe(true);
  });

  it("гонка за один слот: двое пациентов одновременно — запишется только один", async () => {
    const t = setup();
    const booking = (name: string) => [
      { type: "tool_use" as const, name: "book_appointment", input: { service_id: "consult", doctor_id: "ivanova", date: "2026-11-23", time: "10:00", patient_name: name } },
    ];
    t.claude.reply(booking("Первый")).reply(booking("Второй")).reply([{ type: "text", text: "ответ 1" }]).reply([{ type: "text", text: "ответ 2" }]);
    await Promise.all([
      t.dispatcher.handleInbound({ clinicId: "test", phone: "77010000201", text: "Запишите на 10:00" }),
      t.dispatcher.handleInbound({ clinicId: "test", phone: "77010000202", text: "Запишите на 10:00" }),
    ]);
    await Promise.all([t.dispatcher.waitForIdle("test", "77010000201"), t.dispatcher.waitForIdle("test", "77010000202")]);
    const booked = t.repo.listAppointments("test", "2026-11-23T00:00:00.000Z", "2026-11-24T00:00:00.000Z");
    expect(booked).toHaveLength(1);
  });
});
