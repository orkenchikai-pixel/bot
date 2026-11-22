/**
 * Очистка входящего текста перед тем, как он попадёт к ИИ.
 *
 * Невидимые символы — известный способ спрятать от человека «инструкции» для ИИ
 * (prompt injection): теги Unicode (ASCII smuggling), символы нулевой ширины,
 * управляющие символы направления текста (Trojan Source). Людям они не нужны — удаляем.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

export interface SanitizeResult {
  text: string;
  truncated: boolean;
  removedInvisible: number;
}

export function sanitizeInbound(input: string, maxChars: number): SanitizeResult {
  let removedInvisible = 0;
  let text = input.normalize("NFC").replace(INVISIBLE, () => {
    removedInvisible++;
    return "";
  });
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{4,}/g, "   ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  let truncated = false;
  if ([...text].length > maxChars) {
    text = `${[...text].slice(0, maxChars).join("")} …[сообщение обрезано]`;
    truncated = true;
  }
  return { text, truncated, removedInvisible };
}

/** Нормализованная форма для поиска повторов (регистр, пробелы, знаки препинания не важны). */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}
