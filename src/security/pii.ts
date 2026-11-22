import { createHash } from "node:crypto";

/** «77011234567» → «7701*****67»: в логах достаточно, чтобы отличать чаты, но не раскрывать номер. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 4)}${"*".repeat(digits.length - 6)}${digits.slice(-2)}`;
}

/** Тексты сообщений попадают в логи только при LOG_MESSAGE_TEXT=true (для отладки). */
export function logText(text: string, max = 200): string {
  if (process.env.LOG_MESSAGE_TEXT === "true") return text.slice(0, max);
  return `[${text.length} симв.]`;
}

/** Необратимый идентификатор вместо номера — для обезличенных записей и журналов. */
export function anonymizePhone(phone: string): string {
  return `anon:${createHash("sha256").update(`dental-crm-agent:${phone}`).digest("hex").slice(0, 16)}`;
}
