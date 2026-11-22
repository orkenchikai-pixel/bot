import { createHmac, timingSafeEqual } from "node:crypto";

/** Входящее сообщение из вебхука WhatsApp, приведённое к простому виду. */
export interface ParsedInbound {
  /** Phone number ID бизнес-номера — по нему определяем клинику. */
  phoneNumberId: string;
  /** wa_id отправителя. */
  from: string;
  profileName?: string;
  waMessageId: string;
  /** Текст или понятное Claude описание вложения. */
  text: string;
  image?: { mediaId: string; mimeType?: string };
  /** id нажатой кнопки (интерактивные сообщения). */
  replyId?: string;
  /** Время отправки сообщения пациентом, секунды Unix. */
  timestamp?: number;
}

/**
 * Проверка подписи X-Hub-Signature-256: HMAC-SHA256 «сырого» тела запроса с App Secret.
 * Без неё кто угодно мог бы слать фальшивые сообщения от имени пациентов.
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Достаёт из вебхука все входящие сообщения пациентов. Статусы доставки и реакции пропускаем. */
export function parseWebhookPayload(payload: unknown): ParsedInbound[] {
  if (!isObject(payload) || payload.object !== "whatsapp_business_account") return [];
  const result: ParsedInbound[] = [];

  for (const entry of arr(payload.entry)) {
    if (!isObject(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObject(change) || change.field !== "messages" || !isObject(change.value)) continue;
      const value = change.value;
      const phoneNumberId = isObject(value.metadata) ? str(value.metadata.phone_number_id) : undefined;
      if (!phoneNumberId) continue;

      const names = new Map<string, string>();
      for (const contact of arr(value.contacts)) {
        if (!isObject(contact)) continue;
        const waId = str(contact.wa_id);
        const name = isObject(contact.profile) ? str(contact.profile.name) : undefined;
        if (waId && name) names.set(waId, name);
      }

      for (const message of arr(value.messages)) {
        if (!isObject(message)) continue;
        const from = str(message.from);
        const id = str(message.id);
        if (!from || !id) continue;
        // Номер отправителя — только цифры (wa_id); всё остальное считаем подделкой.
        if (!/^\d{5,20}$/.test(from)) continue;
        const content = describeMessage(message);
        if (!content) continue;
        const ts = Number(str(message.timestamp));
        result.push({
          phoneNumberId,
          from,
          profileName: names.get(from)?.slice(0, 100),
          waMessageId: id.slice(0, 200),
          ...content,
          ...(Number.isFinite(ts) && ts > 0 ? { timestamp: ts } : {}),
        });
      }
    }
  }
  return result;
}

function describeMessage(message: Json): { text: string; image?: ParsedInbound["image"]; replyId?: string } | null {
  const type = str(message.type);
  const part = (key: string): Json => (isObject(message[key]) ? (message[key] as Json) : {});

  switch (type) {
    case "text":
      return { text: str(part("text").body) ?? "" };
    case "interactive": {
      const interactive = part("interactive");
      const reply = isObject(interactive.button_reply)
        ? interactive.button_reply
        : isObject(interactive.list_reply)
          ? interactive.list_reply
          : undefined;
      if (!reply) return { text: "[ответ на интерактивное сообщение]" };
      const description = str(reply.description);
      const replyId = str(reply.id);
      return { text: `${str(reply.title) ?? ""}${description ? ` — ${description}` : ""}`, ...(replyId ? { replyId } : {}) };
    }
    case "button": {
      // Нажатие кнопки быстрого ответа в шаблоне (например, «Подтверждаю» в напоминании)
      const payload = str(part("button").payload);
      return { text: str(part("button").text) ?? payload ?? "[нажата кнопка]", ...(payload ? { replyId: payload } : {}) };
    }
    case "image": {
      const image = part("image");
      const caption = str(image.caption);
      const mediaId = str(image.id);
      return {
        text: `[пациент прислал фото]${caption ? ` ${caption}` : ""}`,
        ...(mediaId ? { image: { mediaId, mimeType: str(image.mime_type) } } : {}),
      };
    }
    case "audio":
      return { text: "[голосовое сообщение — прослушать его ты не можешь]" };
    case "video":
      return { text: `[видео — просмотреть его ты не можешь]${str(part("video").caption) ? ` ${str(part("video").caption)}` : ""}` };
    case "document": {
      const doc = part("document");
      return { text: `[файл${str(doc.filename) ? ` «${str(doc.filename)}»` : ""} — открыть его ты не можешь]${str(doc.caption) ? ` ${str(doc.caption)}` : ""}` };
    }
    case "sticker":
      return { text: "[стикер]" };
    case "location": {
      const loc = part("location");
      const label = [str(loc.name), str(loc.address)].filter(Boolean).join(", ");
      return { text: `[геолокация${label ? `: ${label}` : ""}]` };
    }
    case "contacts":
      return { text: "[пациент прислал контакт]" };
    case "reaction":
    case "system":
    case "ephemeral":
      return null;
    default:
      return { text: "[сообщение такого типа не поддерживается — попроси написать текстом]" };
  }
}
