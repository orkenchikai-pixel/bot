import { createHmac } from "node:crypto";

/**
 * Последний рубеж перед отправкой ответа пациенту. Даже если ИИ удалось «уговорить»
 * (prompt injection), фильтр не пропустит:
 *  - утечку системного промпта (канареечная метка, дословные куски инструкций);
 *  - просьбы прислать данные карты, CVV, коды из SMS, пароли (фишинг);
 *  - ссылки на сайты, которых нет в настройках клиники;
 *  - чужие номера телефонов;
 *  - служебные id из промпта.
 */
export interface GuardContext {
  /** Домены, на которые разрешено давать ссылки (сайт, карта, политика клиники). */
  allowedHosts: string[];
  /** Номера (только цифры), которые можно называть: телефон клиники и самого пациента. */
  allowedPhones: string[];
  canary: string;
  /** Характерные строки инструкций из системного промпта. */
  instructionLines: string[];
}

export interface GuardResult {
  text: string;
  blocked: boolean;
  issues: string[];
}

export const SAFE_FALLBACK =
  "Извините, на это сообщение я ответить не могу. Если нужно, я передам ваш вопрос администратору клиники.";

export const MAX_REPLY_CHARS = 3500;

// В JS \b и \w понимают только латиницу, поэтому границы слов задаём через \p{L} (флаг u).
const SENSITIVE_REQUEST = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?<!не\s)(?<!не\s\s)(пришлите|присылайте|отправьте|сообщите|скиньте|напишите|укажите|введите|продиктуйте|назовите|send|provide|enter|share)(?![\p{L}\p{N}])[^.!?\n]{0,50}` +
    String.raw`(cvv|cvc|код\p{L}*\s+из\s+(смс|sms)|смс[- ]?код|sms[- ]?code|парол|password|пин[- ]?код|pin[- ]?code|номер\p{L}*\s+(вашей\s+|банковской\s+)?карт|данные\s+(вашей\s+|банковской\s+)?карт|card\s+number|срок\s+действия\s+карт)`,
  "iu",
);

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
const PHONE_CANDIDATE_RE = /\+?\d[\d\s\-()]{8,}\d/g;
const INTERNAL_ID_RE = /\s*\[(?:id|appointment_id|service_id|doctor_id)\s*:\s*[^\]]*\]/gi;

export function guardReply(text: string, ctx: GuardContext): GuardResult {
  if (ctx.canary && text.includes(ctx.canary)) return { text: SAFE_FALLBACK, blocked: true, issues: ["canary_leak"] };
  const leakedLines = ctx.instructionLines.filter((line) => text.includes(line)).length;
  if (leakedLines >= 2) return { text: SAFE_FALLBACK, blocked: true, issues: ["instructions_leak"] };
  if (SENSITIVE_REQUEST.test(text)) return { text: SAFE_FALLBACK, blocked: true, issues: ["sensitive_data_request"] };

  const issues: string[] = [];
  let out = text.replace(INTERNAL_ID_RE, () => {
    issues.push("internal_id");
    return "";
  });

  out = out.replace(URL_RE, (match) => {
    const trailing = match.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (isAllowedUrl(url, ctx.allowedHosts)) return match;
    issues.push("foreign_link");
    return `[ссылка удалена]${trailing}`;
  });

  out = out.replace(PHONE_CANDIDATE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    const isPhone = (match.startsWith("+") && digits.length >= 10 && digits.length <= 15) || (digits.length === 11 && /^[78]/.test(digits));
    if (!isPhone) return match;
    const allowed = ctx.allowedPhones.some((p) => p === digits || (p.length >= 10 && digits.slice(-10) === p.slice(-10)));
    if (allowed) return match;
    issues.push("foreign_phone");
    return "[номер скрыт]";
  });

  if (out.length > MAX_REPLY_CHARS) {
    out = `${out.slice(0, MAX_REPLY_CHARS)}…`;
    issues.push("too_long");
  }
  return { text: out.trim() || SAFE_FALLBACK, blocked: false, issues };
}

export function isAllowedUrl(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url.startsWith("www.") ? `https://${url}` : url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Хост из URL без «www.». */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Канареечная метка клиники: стабильна между перезапусками (кэш промпта не сбрасывается), но не угадывается без секрета. */
export function canaryFor(clinicId: string, secret: string): string {
  return `CNRY-${createHmac("sha256", secret).update(clinicId).digest("hex").slice(0, 12)}`;
}

/** Строки инструкций, по которым узнаём дословную утечку промпта. */
export function extractInstructionLines(instructions: string): string[] {
  return instructions
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-•]|\d+\.)\s*/, "").trim())
    .filter((line) => line.length >= 60);
}
