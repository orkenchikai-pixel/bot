import { describe, expect, it } from "vitest";
import { ClinicRegistry } from "../src/clinic/registry.js";
import { MemoryTransport } from "../src/messaging/transport.js";
import { runReminderPass } from "../src/reminders/scheduler.js";
import { DateTime } from "../src/scheduling/time.js";
import { memoryRepo, RecordingNotifier, testClinic } from "./helpers.js";

const PHONE = "77010000001";
// Воскресенье 22.11.2026, 12:00 по Алматы; приём — понедельник 23.11 в 10:00 (через 22 часа).
const NOW = DateTime.fromISO("2026-11-22T12:00", { zone: "Asia/Almaty" });

function setupReminders(clinicOverrides: Record<string, unknown> = {}, lastInboundUtc?: string) {
  const repo = memoryRepo();
  const clinic = testClinic(clinicOverrides);
  const transport = new MemoryTransport();
  const notifier = new RecordingNotifier();
  const created = repo.createAppointment({
    clinicId: "test",
    patientPhone: PHONE,
    patientName: "Айгерим",
    doctorId: "ivanova",
    serviceId: "consult",
    startUtc: "2026-11-23T05:00:00.000Z",
    endUtc: "2026-11-23T05:30:00.000Z",
    nowUtc: "2026-11-19T00:00:00.000Z",
    maxActivePerPatient: 3,
  });
  if (!created.ok) throw new Error("не удалось создать запись");
  repo.ensureConversation("test", PHONE, "2026-11-19T00:00:00.000Z");
  if (lastInboundUtc) repo.touchInbound("test", PHONE, lastInboundUtc);
  const deps = { repo, registry: new ClinicRegistry([clinic]), transport, notifier, now: () => NOW };
  return { repo, transport, notifier, deps, id: created.appointment.id };
}

describe("напоминания о визите", () => {
  it("внутри 24-часового окна отправляет обычное сообщение", async () => {
    const t = setupReminders({}, "2026-11-22T05:00:00.000Z");
    expect(await runReminderPass(t.deps)).toEqual({ sent: 1, skipped: 0 });
    expect(t.transport.messagesTo(PHONE)[0]).toContain("Напоминаем о записи в «Тест Дент»");
    expect(t.transport.messagesTo(PHONE)[0]).toContain("пн, 23 ноября в 10:00");
    expect(t.repo.getAppointment(t.id)?.reminder_status).toBe("sent_text");
    expect(t.repo.recentMessages("test", PHONE).at(-1)?.author).toBe("reminder");
    // Повторно не напоминает
    expect(await runReminderPass(t.deps)).toEqual({ sent: 0, skipped: 0 });
  });

  it("вне окна использует утверждённый шаблон", async () => {
    const t = setupReminders({ reminders: { template_name: "appointment_reminder" } }, "2026-11-19T00:00:00.000Z");
    await runReminderPass(t.deps);
    expect(t.transport.messagesTo(PHONE)[0]).toBe(
      "[шаблон appointment_reminder] Айгерим | пн, 23 ноября | 10:00 | Иванова Анна | Тест Дент",
    );
    expect(t.repo.getAppointment(t.id)?.reminder_status).toBe("sent_template");
  });

  it("без шаблона вне окна — не пишет пациенту, а предупреждает администратора", async () => {
    const t = setupReminders();
    expect(await runReminderPass(t.deps)).toEqual({ sent: 0, skipped: 1 });
    expect(t.transport.sent).toEqual([]);
    expect(t.notifier.events.map((e) => e.type)).toEqual(["reminder_not_sent"]);
    expect(t.repo.getAppointment(t.id)?.reminder_status).toBe("skipped_no_template");
  });

  it("не напоминает, если до приёма больше hours_before", async () => {
    const t = setupReminders({ reminders: { hours_before: 12 } }, "2026-11-22T05:00:00.000Z");
    expect(await runReminderPass(t.deps)).toEqual({ sent: 0, skipped: 0 });
  });
});
