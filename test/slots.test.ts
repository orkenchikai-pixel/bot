import { describe, expect, it } from "vitest";
import { checkSlot, describeSchedule, findSlots, spreadPick, type BusyInterval } from "../src/scheduling/slots.js";
import { DateTime } from "../src/scheduling/time.js";
import { MONDAY_8AM, testClinic } from "./helpers.js";

const clinic = testClinic();
const consult = clinic.services.find((s) => s.id === "consult")!;
const cleaning = clinic.services.find((s) => s.id === "cleaning")!;
const ivanova = clinic.doctors.find((d) => d.id === "ivanova")!;
const tz = clinic.timezone;
const at = (iso: string) => DateTime.fromISO(iso, { zone: tz });

function slots(params: Partial<Parameters<typeof findSlots>[0]> = {}) {
  return findSlots({
    clinic,
    service: consult,
    doctors: [ivanova],
    fromDate: "2026-11-23",
    toDate: "2026-11-23",
    now: MONDAY_8AM,
    busyByDoctor: new Map(),
    ...params,
  });
}

describe("findSlots", () => {
  it("строит сетку по рабочим интервалам с учётом перерыва", () => {
    const [day] = slots();
    expect(day?.date).toBe("2026-11-23");
    expect(day?.times).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "13:00", "13:30", "14:00", "14:30"]);
  });

  it("длинная услуга должна целиком помещаться в интервал", () => {
    const [day] = slots({ service: cleaning });
    expect(day?.times).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "13:00", "13:30", "14:00"]);
  });

  it("не предлагает время раньше чем через min_notice_min", () => {
    const [day] = slots({ now: at("2026-11-23T09:10") });
    expect(day?.times[0]).toBe("10:30");
  });

  it("исключает занятое время", () => {
    const busy: BusyInterval[] = [{ start: at("2026-11-23T10:00"), end: at("2026-11-23T11:00") }];
    const [day] = slots({ busyByDoctor: new Map([["ivanova", busy]]) });
    expect(day?.times).not.toContain("10:00");
    expect(day?.times).not.toContain("10:30");
    expect(day?.times).toContain("09:30");
    expect(day?.times).toContain("11:00");
  });

  it("пропускает выходные врача, праздники клиники и нерабочие дни недели", () => {
    const result = slots({ fromDate: "2026-11-23", toDate: "2026-12-16" });
    const dates = result.map((d) => d.date);
    expect(dates).toContain("2026-11-24"); // вторник
    expect(dates).not.toContain("2026-11-25"); // среда — врач не работает
    expect(dates).not.toContain("2026-11-30"); // личный выходной врача
    expect(dates).not.toContain("2026-12-16"); // праздник клиники
  });

  it("фильтрует по времени суток", () => {
    const [day] = slots({ partOfDay: "afternoon" });
    expect(day?.times).toEqual(["13:00", "13:30", "14:00", "14:30"]);
  });

  it("не выходит за горизонт записи", () => {
    const result = slots({ fromDate: "2026-11-23", toDate: "2027-02-01" });
    const last = result.at(-1)!.date;
    expect(last <= "2026-12-23").toBe(true);
  });

  it("ограничивает число вариантов, распределяя их по дню", () => {
    const [day] = slots({ maxPerDoctorDay: 3 });
    expect(day?.times).toEqual(["09:00", "11:30", "14:30"]);
  });
});

describe("checkSlot", () => {
  const base = { clinic, doctor: ivanova, service: consult, now: MONDAY_8AM, busy: [] as BusyInterval[] };

  it("принимает свободное время в рабочие часы", () => {
    expect(checkSlot({ ...base, start: at("2026-11-23T10:00") })).toEqual({ ok: true });
  });

  it.each([
    ["2026-11-23T07:00", "in_past"],
    ["2026-11-23T08:30", "too_soon"],
    ["2027-01-15T10:00", "too_far"],
    ["2026-11-25T10:00", "day_off"],
    ["2026-11-23T11:45", "outside_hours"],
    ["2026-11-23T12:00", "outside_hours"],
  ])("отклоняет %s (%s)", (iso, reason) => {
    const result = checkSlot({ ...base, start: at(iso) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("отклоняет пересечение с другой записью", () => {
    const busy = [{ start: at("2026-11-23T10:15"), end: at("2026-11-23T10:45") }];
    const result = checkSlot({ ...base, busy, start: at("2026-11-23T10:00") });
    expect(result).toMatchObject({ ok: false, reason: "busy" });
  });
});

describe("вспомогательные функции", () => {
  it("spreadPick выбирает равномерно", () => {
    expect(spreadPick([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
    expect(spreadPick([1, 2], 5)).toEqual([1, 2]);
  });

  it("describeSchedule группирует одинаковые дни", () => {
    expect(describeSchedule(ivanova)).toBe("пн 09:00–12:00, 13:00–15:00; вт 09:00–12:00");
    const fiveDays = { ...ivanova, schedule: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], fri: [["09:00", "18:00"]] } } as typeof ivanova;
    expect(describeSchedule(fiveDays)).toBe("пн–ср, пт 09:00–18:00");
  });
});
