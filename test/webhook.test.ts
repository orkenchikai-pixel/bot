import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { splitMessage, toWhatsAppText } from "../src/whatsapp/format.js";
import { parseWebhookPayload, verifySignature } from "../src/whatsapp/webhook.js";

function payload(messages: unknown[], contacts: unknown[] = [{ profile: { name: "Айгерим" }, wa_id: "77010000001" }]) {
  return {
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
              contacts,
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("verifySignature", () => {
  const secret = "app-secret";
  const body = Buffer.from(JSON.stringify(payload([])));
  const sign = (b: Buffer) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;

  it("принимает правильную подпись", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });

  it("отклоняет неверную или отсутствующую подпись", () => {
    expect(verifySignature(body, sign(Buffer.from("other")), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=abc", secret)).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  it("разбирает текст, кнопки, фото и голосовые", () => {
    const result = parseWebhookPayload(
      payload([
        { from: "77010000001", id: "wamid.1", timestamp: "1", type: "text", text: { body: "Здравствуйте" } },
        { from: "77010000001", id: "wamid.2", timestamp: "1", type: "button", button: { text: "Подтверждаю", payload: "CONFIRM" } },
        {
          from: "77010000001",
          id: "wamid.3",
          timestamp: "1",
          type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "slot1", title: "Вт 10:00", description: "Иванова" } },
        },
        { from: "77010000001", id: "wamid.4", timestamp: "1", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "Вот снимок" } },
        { from: "77010000001", id: "wamid.5", timestamp: "1", type: "audio", audio: { id: "MEDIA2", voice: true } },
        { from: "77010000001", id: "wamid.6", timestamp: "1", type: "reaction", reaction: { emoji: "👍", message_id: "x" } },
      ]),
    );
    expect(result.map((r) => r.text)).toEqual([
      "Здравствуйте",
      "Подтверждаю",
      "Вт 10:00 — Иванова",
      "[пациент прислал фото] Вот снимок",
      "[голосовое сообщение — прослушать его ты не можешь]",
    ]);
    expect(result[0]).toMatchObject({ phoneNumberId: "PN1", from: "77010000001", profileName: "Айгерим", waMessageId: "wamid.1" });
    expect(result[3]?.image).toEqual({ mediaId: "MEDIA1", mimeType: "image/jpeg" });
  });

  it("игнорирует статусы доставки и чужие объекты", () => {
    const statusOnly = payload([]);
    (statusOnly.entry[0]!.changes[0]!.value as Record<string, unknown>).statuses = [{ id: "wamid.1", status: "delivered" }];
    expect(parseWebhookPayload(statusOnly)).toEqual([]);
    expect(parseWebhookPayload({ object: "page", entry: [] })).toEqual([]);
    expect(parseWebhookPayload(null)).toEqual([]);
  });
});

describe("форматирование для WhatsApp", () => {
  it("переводит Markdown в разметку WhatsApp", () => {
    expect(toWhatsAppText("## Цены\n**Чистка** — 25 000 ₸\n- пункт\n[сайт](https://example.com)")).toBe(
      "*Цены*\n*Чистка* — 25 000 ₸\n• пункт\nсайт: https://example.com",
    );
  });

  it("делит длинный текст на части", () => {
    const paragraph = "а".repeat(30);
    const parts = splitMessage(Array(10).fill(paragraph).join("\n\n"), 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join("").replace(/\n/g, "")).toBe("а".repeat(300));
    expect(splitMessage("б".repeat(250), 100)).toEqual(["б".repeat(100), "б".repeat(100), "б".repeat(50)]);
  });
});
