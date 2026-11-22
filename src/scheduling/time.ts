import { DateTime, Settings } from "luxon";

// Некорректные даты бросают исключение, а не превращаются тихо в Invalid DateTime.
Settings.throwOnInvalid = true;

declare module "luxon" {
  interface TSSettings {
    throwOnInvalid: true;
  }
}

export { DateTime };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  try {
    DateTime.fromISO(value);
    return true;
  } catch {
    return false;
  }
}

export function isHhmm(value: string): boolean {
  return TIME_RE.test(value);
}

/** Дата + время по часам клиники → момент времени. null, если формат неверный. */
export function parseLocalDateTime(date: string, time: string, timezone: string): DateTime | null {
  if (!isIsoDate(date) || !isHhmm(time)) return null;
  try {
    return DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  } catch {
    return null;
  }
}

/** Единый формат хранения моментов в БД — ISO в UTC (сравнивается как строка). */
export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO();
}

export function fromUtcIso(iso: string, timezone: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(timezone);
}

/** «вт, 25 ноября» */
export function formatDayRu(dt: DateTime): string {
  return dt.setLocale("ru").toFormat("ccc, d MMMM");
}

/** «вторник, 25 ноября 2026, 10:00» */
export function formatDateTimeLongRu(dt: DateTime): string {
  return dt.setLocale("ru").toFormat("cccc, d MMMM yyyy, HH:mm");
}

/** «25.11 (вт) в 10:00» */
export function formatShortRu(dt: DateTime): string {
  return `${dt.toFormat("dd.MM")} (${dt.setLocale("ru").toFormat("ccc")}) в ${dt.toFormat("HH:mm")}`;
}
