import type { ClinicConfig } from "../clinic/schema.js";

export const CONSENT_YES_ID = "consent_yes";
export const CONSENT_NO_ID = "consent_no";

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,!?;:"'«»()✅❌👍👎\s]+/g, " ")
    .trim();

// Только короткие однозначные ответы: «да, а сколько стоит?» согласием не считаем — пусть нажмут кнопку.
const YES = new Set([
  "да", "согласен", "согласна", "согласны", "даю согласие", "я согласен", "я согласна", "ок", "ok", "okay", "yes", "agree",
  "иә", "ия", "келісемін", "ha", "xa", "roziman", "+",
]);
const NO = new Set([
  "нет", "не согласен", "не согласна", "не согласны", "против", "отказываюсь", "no", "disagree", "жоқ", "келіспеймін", "yoq", "yo'q",
]);

export function detectConsentAnswer(text: string, replyId?: string): "yes" | "no" | null {
  if (replyId === CONSENT_YES_ID) return "yes";
  if (replyId === CONSENT_NO_ID) return "no";
  const n = normalize(text);
  if (n.length === 0 || n.length > 30) return null;
  if (YES.has(n)) return "yes";
  if (NO.has(n)) return "no";
  return null;
}

/** Команды для рассылок (требование WhatsApp: пациент должен легко отказаться от сообщений бизнеса). */
export function detectReminderCommand(text: string): "stop" | "start" | null {
  const n = normalize(text);
  if (["стоп", "stop", "отписаться", "отписка", "unsubscribe", "тоқтату"].includes(n)) return "stop";
  if (["старт", "start", "подписаться", "subscribe"].includes(n)) return "start";
  return null;
}

/** Просьба о согласии: кто обрабатывает, какие данные, кому передаются, где политика, как отказаться. */
export function consentRequestText(clinic: ClinicConfig): string {
  if (clinic.privacy.consent_text) return clinic.privacy.consent_text;
  const operator = clinic.privacy.operator_name ?? `клиника «${clinic.name}»`;
  const lines = [
    `Здравствуйте! Вам отвечает ИИ-помощник клиники «${clinic.name}».`,
    "",
    `Чтобы ответить на ваши вопросы и записать вас на приём, нам нужно ваше согласие на обработку персональных данных — номера телефона, имени и сведений о здоровье, которые вы напишете. Оператор данных — ${operator}. Для работы помощника переписка передаётся сервисам WhatsApp (Meta) и Anthropic (ИИ).`,
  ];
  if (clinic.privacy.policy_url) lines.push(`Политика обработки данных: ${clinic.privacy.policy_url}`);
  lines.push(
    "",
    `Нажмите «Согласен» или ответьте «да». Если не согласны — нажмите «Не согласен»: вам ответит администратор без участия ИИ${clinic.phone ? `, или позвоните ${clinic.phone}` : ""}. Согласие можно отозвать в любой момент, написав «отзываю согласие».`,
  );
  return lines.join("\n");
}

/** Режим notice: короткое уведомление в начале диалога вместо явного согласия. */
export function noticeText(clinic: ClinicConfig): string {
  const policy = clinic.privacy.policy_url ? ` Политика обработки данных: ${clinic.privacy.policy_url}` : "";
  return `Здравствуйте! Вам отвечает ИИ-помощник клиники «${clinic.name}». Продолжая переписку, вы соглашаетесь на обработку ваших данных для записи и ответов на вопросы; переписка передаётся сервисам WhatsApp (Meta) и Anthropic (ИИ).${policy} Чтобы позвать администратора, напишите «администратор».`;
}

export const CONSENT_TEXTS = {
  thanks: "Спасибо! Чем могу помочь? Могу рассказать об услугах и ценах или записать вас на приём.",
  refused: (clinic: ClinicConfig) =>
    `Понятно, ИИ-помощник не будет обрабатывать ваши сообщения. Администратор ответит вам здесь в рабочее время${clinic.phone ? ` или позвоните: ${clinic.phone}` : ""}.`,
  stopped: "Готово: напоминания и уведомления от клиники больше не будут приходить. Чтобы снова получать их, напишите «СТАРТ».",
  started: "Готово: вы снова будете получать напоминания о визитах. Чтобы отписаться, напишите «СТОП».",
};
