import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { buildHistory, sanitizeTurnForStorage } from "../src/agent/history.js";

describe("sanitizeTurnForStorage", () => {
  it("убирает thinking/fallback-блоки, но сохраняет текст и пары tool_use/tool_result", () => {
    const turn = [
      { role: "user", content: "Хочу записаться" },
      { role: "system", content: "Служебный контекст" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig1" },
          { type: "tool_use", id: "t1", name: "find_available_slots", input: { service_id: "consult" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      {
        role: "assistant",
        content: [
          { type: "fallback", from: { model: "a" }, to: { model: "b" } },
          { type: "thinking", thinking: "", signature: "sig2" },
          { type: "text", text: "Есть время в 10:00" },
        ],
      },
    ] as unknown as BetaMessageParam[];

    expect(sanitizeTurnForStorage(turn)).toEqual([
      { role: "user", content: "Хочу записаться" },
      { role: "system", content: "Служебный контекст" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "find_available_slots", input: { service_id: "consult" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "Есть время в 10:00" }] },
    ]);
  });

  it("убирает пустой ответ и system-сообщение, после которого нет ответа ассистента", () => {
    const turn = [
      { role: "user", content: "Спасибо" },
      { role: "system", content: "Служебный контекст" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "  " }] },
    ] as unknown as BetaMessageParam[];
    expect(sanitizeTurnForStorage(turn)).toEqual([{ role: "user", content: "Спасибо" }]);
  });

  it("выбрасывает tool_use без результата (например, ответ оборвался по max_tokens)", () => {
    const turn = [
      { role: "user", content: "Запишите меня" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Секунду" },
          { type: "tool_use", id: "t9", name: "book_appointment", input: {} },
        ],
      },
    ] as unknown as BetaMessageParam[];
    expect(sanitizeTurnForStorage(turn)).toEqual([
      { role: "user", content: "Запишите меня" },
      { role: "assistant", content: [{ type: "text", text: "Секунду" }] },
    ]);
  });

  it("заменяет фото текстовой пометкой", () => {
    const turn = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
          { type: "text", text: "Что с зубом?" },
        ],
      },
    ] as unknown as BetaMessageParam[];
    expect(sanitizeTurnForStorage(turn)).toEqual([
      { role: "user", content: [{ type: "text", text: "[фото от пациента]" }, { type: "text", text: "Что с зубом?" }] },
    ]);
  });
});

describe("buildHistory", () => {
  it("склеивает ходы и начинает историю с сообщения пользователя", () => {
    const history = buildHistory([
      [{ role: "assistant", content: "сирота" } as BetaMessageParam],
      [
        { role: "user", content: "Привет" },
        { role: "assistant", content: [{ type: "text", text: "Здравствуйте!" }] },
      ],
    ]);
    expect(history[0]).toEqual({ role: "user", content: "Привет" });
    expect(history).toHaveLength(2);
  });
});
