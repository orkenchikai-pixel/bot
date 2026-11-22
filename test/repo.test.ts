import { describe, expect, it } from "vitest";
import { memoryRepo } from "./helpers.js";

const base = {
  clinicId: "test",
  patientPhone: "77010000001",
  patientName: "Айгерим",
  doctorId: "ivanova",
  serviceId: "consult",
  nowUtc: "2026-11-23T03:00:00.000Z",
  maxActivePerPatient: 2,
};

describe("Repo: записи", () => {
  it("не даёт записать двух пациентов к одному врачу на пересекающееся время", () => {
    const repo = memoryRepo();
    const first = repo.createAppointment({ ...base, startUtc: "2026-11-23T05:00:00.000Z", endUtc: "2026-11-23T05:30:00.000Z" });
    expect(first.ok).toBe(true);
    const clash = repo.createAppointment({
      ...base,
      patientPhone: "77010000002",
      startUtc: "2026-11-23T05:15:00.000Z",
      endUtc: "2026-11-23T05:45:00.000Z",
    });
    expect(clash).toEqual({ ok: false, reason: "busy" });
    const adjacent = repo.createAppointment({
      ...base,
      patientPhone: "77010000002",
      startUtc: "2026-11-23T05:30:00.000Z",
      endUtc: "2026-11-23T06:00:00.000Z",
    });
    expect(adjacent.ok).toBe(true);
  });

  it("отменённая запись освобождает время", () => {
    const repo = memoryRepo();
    const first = repo.createAppointment({ ...base, startUtc: "2026-11-23T05:00:00.000Z", endUtc: "2026-11-23T05:30:00.000Z" });
    if (!first.ok) throw new Error("ожидали успешную запись");
    repo.setAppointmentStatus(first.appointment.id, "cancelled", base.nowUtc, "тест");
    const again = repo.createAppointment({
      ...base,
      patientPhone: "77010000002",
      startUtc: "2026-11-23T05:00:00.000Z",
      endUtc: "2026-11-23T05:30:00.000Z",
    });
    expect(again.ok).toBe(true);
  });

  it("не даёт пациенту две записи на одно время и больше лимита активных", () => {
    const repo = memoryRepo();
    repo.createAppointment({ ...base, startUtc: "2026-11-23T05:00:00.000Z", endUtc: "2026-11-23T05:30:00.000Z" });
    const overlap = repo.createAppointment({
      ...base,
      doctorId: "petrov",
      startUtc: "2026-11-23T05:00:00.000Z",
      endUtc: "2026-11-23T06:00:00.000Z",
    });
    expect(overlap).toEqual({ ok: false, reason: "patient_overlap" });
    repo.createAppointment({ ...base, startUtc: "2026-11-24T05:00:00.000Z", endUtc: "2026-11-24T05:30:00.000Z" });
    const third = repo.createAppointment({ ...base, startUtc: "2026-11-25T05:00:00.000Z", endUtc: "2026-11-25T05:30:00.000Z" });
    expect(third).toEqual({ ok: false, reason: "patient_limit" });
  });

  it("перенос не конфликтует сам с собой и сбрасывает подтверждение", () => {
    const repo = memoryRepo();
    const created = repo.createAppointment({ ...base, startUtc: "2026-11-23T05:00:00.000Z", endUtc: "2026-11-23T05:30:00.000Z" });
    if (!created.ok) throw new Error("ожидали успешную запись");
    repo.setAppointmentStatus(created.appointment.id, "confirmed", base.nowUtc);
    const moved = repo.rescheduleAppointment(created.appointment.id, {
      doctorId: "ivanova",
      startUtc: "2026-11-23T05:15:00.000Z",
      endUtc: "2026-11-23T05:45:00.000Z",
      nowUtc: base.nowUtc,
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.appointment.start_utc).toBe("2026-11-23T05:15:00.000Z");
      expect(moved.appointment.status).toBe("booked");
    }
  });

  it("выбирает кандидатов на напоминание", () => {
    const repo = memoryRepo();
    const created = repo.createAppointment({ ...base, startUtc: "2026-11-24T05:00:00.000Z", endUtc: "2026-11-24T05:30:00.000Z" });
    if (!created.ok) throw new Error("ожидали успешную запись");
    const found = repo.appointmentsForReminder("2026-11-23T08:00:00.000Z", "2026-11-24T08:00:00.000Z", "2026-11-23T07:00:00.000Z");
    expect(found.map((a) => a.id)).toEqual([created.appointment.id]);
    repo.setReminderStatus(created.appointment.id, "sent_text", "2026-11-23T08:00:00.000Z");
    expect(repo.appointmentsForReminder("2026-11-23T08:00:00.000Z", "2026-11-24T08:00:00.000Z", "2026-11-23T07:00:00.000Z")).toEqual([]);
  });
});

describe("Repo: журнал сообщений", () => {
  it("повторный вебхук с тем же wa_message_id игнорируется", () => {
    const repo = memoryRepo();
    const input = { clinicId: "test", phone: "77010000001", text: "Здравствуйте", waMessageId: "wamid.1", createdAtUtc: base.nowUtc };
    expect(repo.logInbound(input)).toBeTypeOf("number");
    expect(repo.logInbound(input)).toBeNull();
    // Без wa_message_id (CLI, симулятор) дубликатов не бывает
    expect(repo.logInbound({ ...input, waMessageId: undefined })).toBeTypeOf("number");
    expect(repo.logInbound({ ...input, waMessageId: undefined })).toBeTypeOf("number");
  });

  it("находит необработанные входящие", () => {
    const repo = memoryRepo();
    const id = repo.logInbound({ clinicId: "test", phone: "77010000001", text: "Привет", createdAtUtc: base.nowUtc })!;
    expect(repo.unprocessedInbound("2026-11-23T00:00:00.000Z").map((m) => m.id)).toEqual([id]);
    repo.markProcessed([id], base.nowUtc);
    expect(repo.unprocessedInbound("2026-11-23T00:00:00.000Z")).toEqual([]);
  });
});
