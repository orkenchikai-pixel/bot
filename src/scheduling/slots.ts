import { WEEKDAYS, type ClinicConfig, type Doctor, type Service, type Weekday } from "../clinic/schema.js";
import { DateTime } from "./time.js";

export interface BusyInterval {
  start: DateTime;
  end: DateTime;
}

export type PartOfDay = "any" | "morning" | "afternoon" | "evening";

export interface DoctorDaySlots {
  /** Дата по часам клиники, YYYY-MM-DD */
  date: string;
  doctorId: string;
  /** Время начала по часам клиники, HH:MM */
  times: string[];
}

export type SlotRejectReason = "in_past" | "too_soon" | "too_far" | "day_off" | "outside_hours" | "busy";

export type SlotCheck = { ok: true } | { ok: false; reason: SlotRejectReason; message: string };

const ms = (dt: DateTime) => dt.toMillis();

export function weekdayKey(dt: DateTime): Weekday {
  return WEEKDAYS[dt.weekday - 1]!;
}

/** Рабочие интервалы врача в конкретный день (по часам клиники). */
export function workingIntervals(clinic: ClinicConfig, doctor: Doctor, date: string): BusyInterval[] {
  if (clinic.holidays.includes(date) || doctor.days_off.includes(date)) return [];
  const tz = clinic.timezone;
  const day = DateTime.fromISO(date, { zone: tz });
  const intervals = doctor.schedule[weekdayKey(day)] ?? [];
  return intervals.map(([start, end]) => ({
    start: DateTime.fromISO(`${date}T${start}`, { zone: tz }),
    end: DateTime.fromISO(`${date}T${end}`, { zone: tz }),
  }));
}

/** Самое раннее и самое позднее время, на которое вообще можно записаться сейчас. */
export function bookingWindow(clinic: ClinicConfig, now: DateTime): { earliest: DateTime; latest: DateTime } {
  return {
    earliest: now.plus({ minutes: clinic.booking.min_notice_min }),
    latest: now
      .setZone(clinic.timezone)
      .startOf("day")
      .plus({ days: clinic.booking.horizon_days + 1 }),
  };
}

function overlaps(start: DateTime, end: DateTime, busy: BusyInterval): boolean {
  return ms(start) < ms(busy.end) && ms(end) > ms(busy.start);
}

function matchesPartOfDay(t: DateTime, part: PartOfDay): boolean {
  if (part === "any") return true;
  const minutes = t.hour * 60 + t.minute;
  if (part === "morning") return minutes < 12 * 60;
  if (part === "afternoon") return minutes >= 12 * 60 && minutes < 17 * 60;
  return minutes >= 17 * 60;
}

/** Если слотов слишком много, оставляем равномерно распределённые по дню, а не только первые. */
export function spreadPick<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, 1);
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!);
  }
  return picked;
}

export interface FindSlotsParams {
  clinic: ClinicConfig;
  service: Service;
  doctors: Doctor[];
  /** YYYY-MM-DD по часам клиники, включительно */
  fromDate: string;
  toDate: string;
  now: DateTime;
  busyByDoctor: Map<string, BusyInterval[]>;
  partOfDay?: PartOfDay;
  /** Максимум вариантов на одного врача в один день */
  maxPerDoctorDay?: number;
}

export function findSlots(p: FindSlotsParams): DoctorDaySlots[] {
  const tz = p.clinic.timezone;
  const step = p.clinic.booking.slot_step_min;
  const { earliest, latest } = bookingWindow(p.clinic, p.now);
  const today = p.now.setZone(tz).startOf("day");

  let day = DateTime.fromISO(p.fromDate, { zone: tz }).startOf("day");
  if (ms(day) < ms(today)) day = today;
  const lastDay = DateTime.fromISO(p.toDate, { zone: tz }).startOf("day");

  const result: DoctorDaySlots[] = [];
  for (; ms(day) <= ms(lastDay) && ms(day) < ms(latest); day = day.plus({ days: 1 })) {
    const date = day.toISODate();
    for (const doctor of p.doctors) {
      const busy = p.busyByDoctor.get(doctor.id) ?? [];
      const times: string[] = [];
      for (const work of workingIntervals(p.clinic, doctor, date)) {
        for (
          let start = work.start;
          ms(start.plus({ minutes: p.service.duration_min })) <= ms(work.end);
          start = start.plus({ minutes: step })
        ) {
          const end = start.plus({ minutes: p.service.duration_min });
          if (ms(start) < ms(earliest) || ms(end) > ms(latest)) continue;
          if (!matchesPartOfDay(start, p.partOfDay ?? "any")) continue;
          if (busy.some((b) => overlaps(start, end, b))) continue;
          times.push(start.toFormat("HH:mm"));
        }
      }
      if (times.length > 0) {
        result.push({
          date,
          doctorId: doctor.id,
          times: p.maxPerDoctorDay ? spreadPick(times, p.maxPerDoctorDay) : times,
        });
      }
    }
  }
  return result;
}

export interface CheckSlotParams {
  clinic: ClinicConfig;
  doctor: Doctor;
  service: Service;
  start: DateTime;
  now: DateTime;
  busy: BusyInterval[];
}

/** Можно ли записать к врачу на конкретное время. Используется при записи и переносе. */
export function checkSlot(p: CheckSlotParams): SlotCheck {
  const start = p.start.setZone(p.clinic.timezone);
  const end = start.plus({ minutes: p.service.duration_min });
  const { earliest, latest } = bookingWindow(p.clinic, p.now);

  if (ms(start) < ms(p.now)) return { ok: false, reason: "in_past", message: "Это время уже прошло." };
  if (ms(start) < ms(earliest)) {
    return {
      ok: false,
      reason: "too_soon",
      message: `Записаться можно не раньше чем за ${p.clinic.booking.min_notice_min} мин до приёма.`,
    };
  }
  if (ms(end) > ms(latest)) {
    return {
      ok: false,
      reason: "too_far",
      message: `Запись открыта только на ${p.clinic.booking.horizon_days} дней вперёд.`,
    };
  }
  const date = start.toISODate();
  const intervals = workingIntervals(p.clinic, p.doctor, date);
  if (intervals.length === 0) {
    return { ok: false, reason: "day_off", message: "В этот день врач не принимает." };
  }
  const insideWorkingHours = intervals.some((w) => ms(start) >= ms(w.start) && ms(end) <= ms(w.end));
  if (!insideWorkingHours) {
    return {
      ok: false,
      reason: "outside_hours",
      message: "Приём не помещается в рабочее время врача (с учётом длительности услуги).",
    };
  }
  if (p.busy.some((b) => overlaps(start, end, b))) {
    return { ok: false, reason: "busy", message: "Это время уже занято." };
  }
  return { ok: true };
}

/** Краткое описание недельного графика врача: «пн–пт 09:00–14:00, 15:00–19:00; сб 10:00–15:00». */
export function describeSchedule(doctor: Doctor): string {
  const names: Record<Weekday, string> = { mon: "пн", tue: "вт", wed: "ср", thu: "чт", fri: "пт", sat: "сб", sun: "вс" };
  // Группируем дни с одинаковыми часами (в порядке недели).
  const groups = new Map<string, number[]>();
  WEEKDAYS.forEach((day, index) => {
    const text = (doctor.schedule[day] ?? []).map(([s, e]) => `${s}–${e}`).join(", ");
    if (!text) return;
    groups.set(text, [...(groups.get(text) ?? []), index]);
  });
  if (groups.size === 0) return "нет приёмных дней";

  const label = (days: number[]): string => {
    const runs: number[][] = [];
    for (const d of days) {
      const run = runs.at(-1);
      if (run && run.at(-1) === d - 1) run.push(d);
      else runs.push([d]);
    }
    return runs
      .map((run) => {
        const first = names[WEEKDAYS[run[0]!]!];
        const last = names[WEEKDAYS[run.at(-1)!]!];
        if (run.length === 1) return first;
        return run.length === 2 ? `${first}, ${last}` : `${first}–${last}`;
      })
      .join(", ");
  };
  return [...groups].map(([text, days]) => `${label(days)} ${text}`).join("; ");
}
