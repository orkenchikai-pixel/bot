import { describe, expect, it } from "vitest";
import { executeTool, type ToolContext } from "../src/agent/tools.js";
import type { AdminEvent } from "../src/notify/notifier.js";
import { DateTime } from "../src/scheduling/time.js";
import { memoryRepo, MONDAY_8AM, testClinic } from "./helpers.js";

function context(overrides: Partial<ToolContext> = {}) {
  const events: AdminEvent[] = [];
  const handoffs: Array<{ reason: string; summary: string }> = [];
  const ctx: ToolContext = {
    clinic: testClinic(),
    phone: "77010000001",
    repo: memoryRepo(),
    now: () => MONDAY_8AM,
    notify: (e) => events.push(e),
    requestHandoff: (reason, summary) => handoffs.push({ reason, summary }),
    ...overrides,
  };
  return { ctx, events, handoffs };
}

const parse = (content: string) => JSON.parse(content) as Record<string, any>;

describe("find_available_slots", () => {
  it("возвращает слоты по врачам", async () => {
    const { ctx } = context();
    const res = await executeTool("find_available_slots", { service_id: "cleaning", date_from: "2026-11-23", date_to: "2026-11-25" }, ctx);
    expect(res.isError).toBeUndefined();
    const data = parse(res.content);
    expect(data.slots.map((s: any) => `${s.date}/${s.doctor_id}`)).toEqual([
      "2026-11-23/ivanova",
      "2026-11-24/ivanova",
      "2026-11-25/petrov",
    ]);
    expect(data.slots[0].day).toBe("пн, 23 ноября");
  });

  it("подсказывает ближайшую дату, если в запрошенный день пусто", async () => {
    const { ctx } = context();
    const res = await executeTool("find_available_slots", { service_id: "consult", date_from: "2026-11-25" }, ctx);
    const data = parse(res.content);
    expect(data.slots).toEqual([]);
    // Среда — врач не работает, 30.11 — его выходной, ближайший приём — вторник 01.12
    expect(data.next_available[0].date).toBe("2026-12-01");
  });

  it("не записывает напрямую на услуги, требующие консультации", async () => {
    const { ctx } = context();
    const res = await executeTool("find_available_slots", { service_id: "implant", date_from: "2026-11-23" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("консультац");
  });

  it("сообщает, если врач не делает услугу", async () => {
    const { ctx } = context();
    const res = await executeTool("find_available_slots", { service_id: "consult", doctor_id: "petrov", date_from: "2026-11-23" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Иванова Анна");
  });
});

describe("book / reschedule / cancel / confirm", () => {
  async function book(ctx: ToolContext, time = "10:00") {
    return executeTool(
      "book_appointment",
      { service_id: "consult", doctor_id: "ivanova", date: "2026-11-23", time, patient_name: "  Айгерим   Сапарова " },
      ctx,
    );
  }

  it("создаёт запись, сохраняет имя и уведомляет администратора", async () => {
    const { ctx, events } = context();
    const res = await book(ctx);
    const data = parse(res.content);
    expect(data).toMatchObject({ status: "booked", patient_name: "Айгерим Сапарова", doctor: "Иванова Анна" });
    expect(data.when).toBe("понедельник, 23 ноября 2026, 10:00");
    expect(ctx.repo.getPatient("test", ctx.phone)?.name).toBe("Айгерим Сапарова");
    expect(events.map((e) => e.type)).toEqual(["appointment_created"]);
    const appt = ctx.repo.getAppointment(data.appointment_id)!;
    expect(appt.start_utc).toBe("2026-11-23T05:00:00.000Z"); // 10:00 Алматы = 05:00 UTC
  });

  it("не записывает на занятое время другого пациента", async () => {
    const { ctx } = context();
    await book(ctx);
    const other = { ...ctx, phone: "77010000002" };
    const res = await book(other);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("занято");
  });

  it("не даёт управлять чужими записями", async () => {
    const { ctx } = context();
    const id = parse((await book(ctx)).content).appointment_id;
    const stranger = { ...ctx, phone: "77019999999" };
    const res = await executeTool("cancel_appointment", { appointment_id: id }, stranger);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("не найдена");
  });

  it("переносит запись на свободное время", async () => {
    const { ctx, events } = context();
    const id = parse((await book(ctx)).content).appointment_id;
    const res = await executeTool("reschedule_appointment", { appointment_id: id, date: "2026-11-23", time: "10:15" }, ctx);
    expect(parse(res.content)).toMatchObject({ action: "rescheduled", appointment_id: id });
    expect(events.map((e) => e.type)).toEqual(["appointment_created", "appointment_rescheduled"]);
  });

  it("поздняя отмена — только через администратора", async () => {
    const { ctx } = context();
    const id = parse((await book(ctx)).content).appointment_id;
    const lateCtx = { ...ctx, now: () => DateTime.fromISO("2026-11-23T08:30", { zone: "Asia/Almaty" }) };
    const res = await executeTool("cancel_appointment", { appointment_id: id }, lateCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("late_change");
  });

  it("отменяет и подтверждает", async () => {
    const { ctx } = context();
    const first = parse((await book(ctx)).content).appointment_id;
    const second = parse((await book(ctx, "11:00")).content).appointment_id;
    expect(parse((await executeTool("confirm_appointment", { appointment_id: first }, ctx)).content).action).toBe("confirmed");
    expect(parse((await executeTool("cancel_appointment", { appointment_id: second, reason: "заболел" }, ctx)).content).action).toBe("cancelled");
    expect(ctx.repo.getAppointment(second)?.cancel_reason).toBe("заболел");
    const mine = parse((await executeTool("get_my_appointments", {}, ctx)).content);
    expect(mine.appointments.map((a: any) => [a.appointment_id, a.status])).toEqual([[first, "подтверждена"]]);
  });

  it("передаёт диалог администратору", async () => {
    const { ctx, handoffs } = context();
    const res = await executeTool("handoff_to_admin", { reason: "complaint", summary: "Недоволен пломбой" }, ctx);
    expect(parse(res.content).status).toBe("handed_off");
    expect(handoffs).toEqual([{ reason: "complaint", summary: "Недоволен пломбой" }]);
  });

  it("возвращает ошибку на некорректные аргументы и неизвестный инструмент", async () => {
    const { ctx } = context();
    expect((await executeTool("book_appointment", { service_id: "consult" }, ctx)).isError).toBe(true);
    expect((await executeTool("drop_database", {}, ctx)).isError).toBe(true);
    const badDate = await executeTool(
      "book_appointment",
      { service_id: "consult", doctor_id: "ivanova", date: "23.11.2026", time: "10:00", patient_name: "Айгерим" },
      ctx,
    );
    expect(badDate.isError).toBe(true);
  });
});
