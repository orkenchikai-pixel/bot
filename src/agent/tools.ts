import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { doctorsForService, findDoctor, findService, type ClinicConfig, type Doctor } from "../clinic/schema.js";
import type { Appointment, Repo } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import type { AdminEvent } from "../notify/notifier.js";
import { bookingWindow, checkSlot, findSlots, type BusyInterval, type DoctorDaySlots } from "../scheduling/slots.js";
import {
  DateTime,
  formatDateTimeLongRu,
  formatDayRu,
  fromUtcIso,
  isIsoDate,
  parseLocalDateTime,
  toUtcIso,
} from "../scheduling/time.js";
import { formatPrice, STATUS_RU } from "./prompt.js";

export interface ToolContext {
  clinic: ClinicConfig;
  /** Номер пациента (wa_id) — все операции только с записями этого номера. */
  phone: string;
  repo: Repo;
  now: () => DateTime;
  /** Отправить уведомление администраторам (не ждём доставки). */
  notify: (event: AdminEvent) => void;
  /** Перевести диалог на живого администратора. */
  requestHandoff: (reason: string, summary: string) => void;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const HANDOFF_REASONS = [
  "patient_request",
  "complaint",
  "medical_urgent",
  "unknown_answer",
  "billing_or_documents",
  "late_change",
  "other",
] as const;

/**
 * Описания инструментов. Массив статичен (одинаков для всех клиник и ходов), чтобы префикс
 * запроса кэшировался. strict: true — Claude гарантированно присылает аргументы по схеме.
 */
export const TOOL_DEFINITIONS: BetaTool[] = [
  {
    name: "find_available_slots",
    description:
      "Ищет свободное время для записи на услугу. Вызывай всегда, прежде чем предложить пациенту конкретное время, и перед переносом записи. " +
      "Можно искать в один день или в диапазоне до 14 дней, у конкретного врача или у всех врачей, выполняющих услугу. " +
      "Если в диапазоне нет свободного времени, в ответе будет ближайшая дата со свободными окнами.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "id услуги из прайс-листа" },
        doctor_id: { type: "string", description: "id врача, если пациент хочет к конкретному врачу" },
        date_from: { type: "string", format: "date", description: "Первая дата поиска (YYYY-MM-DD, по времени клиники)" },
        date_to: {
          type: "string",
          format: "date",
          description: "Последняя дата поиска включительно (YYYY-MM-DD). Не больше 14 дней от date_from. Если не указана — ищем только в date_from",
        },
        part_of_day: {
          type: "string",
          enum: ["any", "morning", "afternoon", "evening"],
          description: "morning — до 12:00, afternoon — 12:00–17:00, evening — с 17:00",
        },
      },
      required: ["service_id", "date_from"],
      additionalProperties: false,
    },
  },
  {
    name: "book_appointment",
    description:
      "Создаёт запись на приём. Вызывай, когда пациент выбрал конкретное время из результатов find_available_slots и согласен, и известно имя пациента. " +
      "Запись оформляется на номер WhatsApp, с которого пишет пациент.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "id услуги" },
        doctor_id: { type: "string", description: "id врача" },
        date: { type: "string", format: "date", description: "Дата приёма, YYYY-MM-DD" },
        time: { type: "string", description: "Время начала по часам клиники, HH:MM (из найденных слотов)" },
        patient_name: { type: "string", description: "Имя (и фамилия, если известна) того, кто придёт на приём" },
        comment: {
          type: "string",
          description: "Комментарий для врача/администратора: жалобы, пожелания, кто записал ребёнка и т.п.",
        },
      },
      required: ["service_id", "doctor_id", "date", "time", "patient_name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_appointments",
    description:
      "Возвращает предстоящие записи пациента, который пишет. Используй, когда пациент спрашивает о своих записях или хочет перенести/отменить запись, " +
      "а нужной записи нет в служебном контексте.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "reschedule_appointment",
    description:
      "Переносит запись пациента на другое время (и при необходимости к другому врачу). Сначала найди свободное время через find_available_slots и согласуй его с пациентом.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "integer", description: "Номер записи" },
        date: { type: "string", format: "date", description: "Новая дата, YYYY-MM-DD" },
        time: { type: "string", description: "Новое время начала, HH:MM" },
        doctor_id: { type: "string", description: "id нового врача, если меняется врач" },
      },
      required: ["appointment_id", "date", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Отменяет запись пациента. Перед отменой уточни, не удобнее ли перенести, и получи явное согласие пациента на отмену.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "integer", description: "Номер записи" },
        reason: { type: "string", description: "Причина отмены со слов пациента, если он её назвал" },
      },
      required: ["appointment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_appointment",
    description: "Отмечает, что пациент подтвердил визит (например, ответил на напоминание «да, приду»).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { appointment_id: { type: "integer", description: "Номер записи" } },
      required: ["appointment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "handoff_to_admin",
    description:
      "Передаёт диалог живому администратору клиники: он получит уведомление с кратким содержанием и ответит в этом же чате, а бот перестанет отвечать здесь. " +
      "Вызывай, когда пациент просит человека, жалуется, спрашивает о том, чего нет в данных клиники, о деньгах, документах или гарантии, " +
      "хочет отменить/перенести запись позже допустимого срока, и при неотложной ситуации.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: [...HANDOFF_REASONS], description: "Причина передачи" },
        summary: {
          type: "string",
          description: "Кратко для администратора: что хочет пациент, что уже выяснено, что ему пообещано",
        },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "privacy_request",
    description:
      "Запросы пациента о его персональных данных: удалить данные, выдать копию данных, отозвать согласие на обработку, отписаться от напоминаний. " +
      "Вызывай, как только пациент об этом попросил, — это его право по закону.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["delete_data", "export_data", "withdraw_consent", "stop_reminders"],
          description: "Что просит пациент",
        },
        details: { type: "string", description: "Подробности со слов пациента, если есть" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
];

// ---------- Проверка входных данных ----------

const optionalString = z.string().nullish();

const schemas = {
  find_available_slots: z.object({
    service_id: z.string(),
    doctor_id: optionalString,
    date_from: z.string(),
    date_to: optionalString,
    part_of_day: z.enum(["any", "morning", "afternoon", "evening"]).nullish(),
  }),
  book_appointment: z.object({
    service_id: z.string(),
    doctor_id: z.string(),
    date: z.string(),
    time: z.string(),
    patient_name: z.string(),
    comment: optionalString,
  }),
  get_my_appointments: z.object({}),
  reschedule_appointment: z.object({
    appointment_id: z.number().int(),
    date: z.string(),
    time: z.string(),
    doctor_id: optionalString,
  }),
  cancel_appointment: z.object({ appointment_id: z.number().int(), reason: optionalString }),
  confirm_appointment: z.object({ appointment_id: z.number().int() }),
  handoff_to_admin: z.object({ reason: z.enum(HANDOFF_REASONS), summary: z.string() }),
  privacy_request: z.object({
    kind: z.enum(["delete_data", "export_data", "withdraw_consent", "stop_reminders"]),
    details: optionalString,
  }),
};

type ToolName = keyof typeof schemas;
type Input<T extends ToolName> = z.infer<(typeof schemas)[T]>;

const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data) });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

/** Выполняет инструмент. Никогда не бросает исключений — ошибки возвращаются Claude как is_error. */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in schemas)) return fail(`Неизвестный инструмент: ${name}`);
  const toolName = name as ToolName;
  const parsed = schemas[toolName].safeParse(rawInput ?? {});
  if (!parsed.success) return fail(`Некорректные аргументы: ${z.prettifyError(parsed.error)}`);
  try {
    switch (toolName) {
      case "find_available_slots":
        return findAvailableSlots(ctx, parsed.data as Input<"find_available_slots">);
      case "book_appointment":
        return bookAppointment(ctx, parsed.data as Input<"book_appointment">);
      case "get_my_appointments":
        return getMyAppointments(ctx);
      case "reschedule_appointment":
        return rescheduleAppointment(ctx, parsed.data as Input<"reschedule_appointment">);
      case "cancel_appointment":
        return cancelAppointment(ctx, parsed.data as Input<"cancel_appointment">);
      case "confirm_appointment":
        return confirmAppointment(ctx, parsed.data as Input<"confirm_appointment">);
      case "handoff_to_admin":
        return handoffToAdmin(ctx, parsed.data as Input<"handoff_to_admin">);
      case "privacy_request":
        return privacyRequest(ctx, parsed.data as Input<"privacy_request">);
    }
  } catch (err) {
    log.error(`Инструмент ${name} упал`, { clinic: ctx.clinic.id, error: errorMessage(err) });
    return fail("Внутренняя ошибка при выполнении действия. Извинись перед пациентом и передай вопрос администратору.");
  }
}

// ---------- Вспомогательное ----------

function toBusy(appointments: Appointment[], excludeId?: number): BusyInterval[] {
  return appointments
    .filter((a) => a.id !== excludeId)
    .map((a) => ({ start: DateTime.fromISO(a.start_utc), end: DateTime.fromISO(a.end_utc) }));
}

function doctorName(clinic: ClinicConfig, id: string): string {
  return findDoctor(clinic, id)?.name ?? id;
}

function serviceName(clinic: ClinicConfig, id: string): string {
  return findService(clinic, id)?.name ?? id;
}

/** Занятость врачей за период [from, to] (даты по часам клиники, включительно). */
function busyByDoctor(
  ctx: ToolContext,
  doctors: Doctor[],
  from: DateTime,
  to: DateTime,
  excludeAppointmentId?: number,
): Map<string, BusyInterval[]> {
  const rows = ctx.repo.busyIntervals(
    ctx.clinic.id,
    doctors.map((d) => d.id),
    toUtcIso(from.startOf("day")),
    toUtcIso(to.endOf("day")),
  );
  const map = new Map<string, BusyInterval[]>();
  for (const row of rows) {
    if (row.id === excludeAppointmentId) continue;
    const list = map.get(row.doctor_id) ?? [];
    list.push(...toBusy([row]));
    map.set(row.doctor_id, list);
  }
  return map;
}

/** Ищет врача для записи/переноса и проверяет, что он выполняет услугу. */
function resolveDoctorForService(clinic: ClinicConfig, serviceId: string, doctorId: string): Doctor | string {
  const doctor = findDoctor(clinic, doctorId);
  if (!doctor || !doctor.active) return `Врач с id "${doctorId}" не найден.`;
  const capable = doctorsForService(clinic, serviceId);
  if (!capable.some((d) => d.id === doctor.id)) {
    const names = capable.map((d) => d.name).join(", ");
    return `${doctor.name} не выполняет услугу «${serviceName(clinic, serviceId)}». Эту услугу выполняют: ${names || "сейчас никто"}.`;
  }
  return doctor;
}

const MAX_TIMES_IN_RESULT = 48;

/** Защита от злоупотреблений: не больше N записей/отмен/переносов с одного номера за сутки. */
function changeLimitError(ctx: ToolContext): ToolOutcome | null {
  const since = toUtcIso(ctx.now().minus({ hours: 24 }));
  const limit = ctx.clinic.booking.max_changes_per_day;
  if (ctx.repo.countBookingEvents(ctx.clinic.id, ctx.phone, since) >= limit) {
    return fail(
      `За сутки с этого номера уже ${limit} изменений записей — больше через чат нельзя. ` +
        `Передай диалог администратору (handoff_to_admin, reason "other").`,
    );
  }
  return null;
}

// ---------- Инструменты ----------

function findAvailableSlots(ctx: ToolContext, input: Input<"find_available_slots">): ToolOutcome {
  const { clinic } = ctx;
  const tz = clinic.timezone;
  const service = findService(clinic, input.service_id);
  if (!service) return fail(`Услуга с id "${input.service_id}" не найдена. Возьми id из прайс-листа.`);
  if (!service.bookable) {
    return fail(`На «${service.name}» не записываем напрямую — сначала нужна консультация. Предложи пациенту консультацию.`);
  }

  let doctors = doctorsForService(clinic, service.id);
  if (input.doctor_id) {
    const doctor = resolveDoctorForService(clinic, service.id, input.doctor_id);
    if (typeof doctor === "string") return fail(doctor);
    doctors = [doctor];
  }
  if (doctors.length === 0) return fail(`Сейчас нет врача для услуги «${service.name}» — передай вопрос администратору.`);

  const dateTo = input.date_to ?? input.date_from;
  if (!isIsoDate(input.date_from) || !isIsoDate(dateTo)) return fail("Даты должны быть в формате YYYY-MM-DD.");

  const now = ctx.now();
  const today = now.setZone(tz).startOf("day");
  let from = DateTime.fromISO(input.date_from, { zone: tz });
  let to = DateTime.fromISO(dateTo, { zone: tz });
  if (to.toMillis() < from.toMillis()) [from, to] = [to, from];
  if (to.toMillis() < today.toMillis()) {
    return fail(`Эти даты уже прошли. Сегодня ${today.toISODate()} (${formatDayRu(today)}).`);
  }
  if (from.toMillis() < today.toMillis()) from = today;
  if (to.diff(from, "days").days > 13) to = from.plus({ days: 13 });

  const { latest } = bookingWindow(clinic, now);
  const search = (rangeFrom: DateTime, rangeTo: DateTime): DoctorDaySlots[] =>
    findSlots({
      clinic,
      service,
      doctors,
      fromDate: rangeFrom.toISODate(),
      toDate: rangeTo.toISODate(),
      now,
      busyByDoctor: busyByDoctor(ctx, doctors, rangeFrom, rangeTo),
      partOfDay: input.part_of_day ?? "any",
      maxPerDoctorDay: 8,
    });

  const describe = (slots: DoctorDaySlots[]) =>
    slots.map((s) => ({
      date: s.date,
      day: formatDayRu(DateTime.fromISO(s.date, { zone: tz })),
      doctor_id: s.doctorId,
      doctor: doctorName(clinic, s.doctorId),
      times: s.times,
    }));

  const found = search(from, to);
  const serviceInfo = { id: service.id, name: service.name, duration_min: service.duration_min };

  if (found.length > 0) {
    let total = 0;
    const limited: DoctorDaySlots[] = [];
    for (const day of found) {
      if (total >= MAX_TIMES_IN_RESULT) break;
      limited.push(day);
      total += day.times.length;
    }
    return ok({
      service: serviceInfo,
      slots: describe(limited),
      ...(limited.length < found.length ? { truncated: "Показаны не все дни — есть свободное время и позже." } : {}),
    });
  }

  // В запрошенном диапазоне пусто — ищем ближайший день со свободным временем до конца горизонта записи.
  let cursor = to.plus({ days: 1 });
  while (cursor.toMillis() < latest.toMillis()) {
    const windowEnd = cursor.plus({ days: 6 });
    const ahead = search(cursor, windowEnd);
    if (ahead.length > 0) {
      const firstDate = ahead[0]!.date;
      return ok({
        service: serviceInfo,
        slots: [],
        message: "В запрошенные даты свободного времени нет.",
        next_available: describe(ahead.filter((s) => s.date === firstDate)),
      });
    }
    cursor = windowEnd.plus({ days: 1 });
  }
  return ok({
    service: serviceInfo,
    slots: [],
    message: `Свободного времени нет на ближайшие ${clinic.booking.horizon_days} дней. Предложи передать вопрос администратору (возможна запись в лист ожидания).`,
  });
}

function bookAppointment(ctx: ToolContext, input: Input<"book_appointment">): ToolOutcome {
  const { clinic } = ctx;
  const service = findService(clinic, input.service_id);
  if (!service) return fail(`Услуга с id "${input.service_id}" не найдена.`);
  if (!service.bookable) return fail(`На «${service.name}» не записываем напрямую — предложи консультацию.`);
  const doctor = resolveDoctorForService(clinic, service.id, input.doctor_id);
  if (typeof doctor === "string") return fail(doctor);

  const limited = changeLimitError(ctx);
  if (limited) return limited;

  const patientName = input.patient_name.trim().replace(/\s+/g, " ");
  if (patientName.length < 2 || patientName.length > 100) return fail("Укажи имя пациента (2–100 символов).");

  const start = parseLocalDateTime(input.date, input.time, clinic.timezone);
  if (!start) return fail("Дата должна быть в формате YYYY-MM-DD, время — HH:MM.");
  const end = start.plus({ minutes: service.duration_min });
  const now = ctx.now();

  const busy = busyByDoctor(ctx, [doctor], start, start).get(doctor.id) ?? [];
  const check = checkSlot({ clinic, doctor, service, start, now, busy });
  if (!check.ok) return fail(`${check.message} Найди другое время через find_available_slots.`);

  const nowIso = toUtcIso(now);
  const result = ctx.repo.createAppointment({
    clinicId: clinic.id,
    patientPhone: ctx.phone,
    patientName,
    doctorId: doctor.id,
    serviceId: service.id,
    startUtc: toUtcIso(start),
    endUtc: toUtcIso(end),
    comment: input.comment?.trim() || null,
    source: "whatsapp-bot",
    nowUtc: nowIso,
    maxActivePerPatient: clinic.booking.max_active_per_patient,
  });
  if (!result.ok) {
    const messages = {
      busy: "Это время только что заняли. Найди другое время через find_available_slots.",
      patient_overlap: "У пациента уже есть запись, которая пересекается с этим временем.",
      patient_limit: `У пациента уже ${clinic.booking.max_active_per_patient} активные записи — больше через бота нельзя. Предложи перенести одну из них или передай администратору.`,
    } as const;
    return fail(messages[result.reason]);
  }

  if (!ctx.repo.getPatient(clinic.id, ctx.phone)?.name) ctx.repo.setPatientName(clinic.id, ctx.phone, patientName, nowIso);
  ctx.repo.logBookingEvent(clinic.id, ctx.phone, "created", nowIso);
  ctx.notify({ type: "appointment_created", appointment: result.appointment });

  return ok({
    status: "booked",
    appointment_id: result.appointment.id,
    patient_name: patientName,
    service: service.name,
    price: formatPrice(service, clinic.currency),
    doctor: doctor.name,
    when: formatDateTimeLongRu(start),
    duration_min: service.duration_min,
    address: clinic.address,
  });
}

function describeAppointment(clinic: ClinicConfig, a: Appointment) {
  return {
    appointment_id: a.id,
    when: formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone)),
    service: serviceName(clinic, a.service_id),
    service_id: a.service_id,
    doctor: doctorName(clinic, a.doctor_id),
    doctor_id: a.doctor_id,
    patient_name: a.patient_name,
    status: STATUS_RU[a.status] ?? a.status,
  };
}

function getMyAppointments(ctx: ToolContext): ToolOutcome {
  const list = ctx.repo.patientAppointments(ctx.clinic.id, ctx.phone, toUtcIso(ctx.now()));
  if (list.length === 0) return ok({ appointments: [], message: "Предстоящих записей нет." });
  return ok({ appointments: list.map((a) => describeAppointment(ctx.clinic, a)) });
}

/** Находит активную будущую запись именно этого пациента. */
function loadOwnAppointment(ctx: ToolContext, id: number): Appointment | ToolOutcome {
  const appt = ctx.repo.getAppointment(id);
  if (!appt || appt.clinic_id !== ctx.clinic.id || appt.patient_phone !== ctx.phone) {
    return fail(`Запись №${id} не найдена среди записей этого пациента. Посмотри записи через get_my_appointments.`);
  }
  if (appt.status !== "booked" && appt.status !== "confirmed") {
    return fail(`Запись №${id} уже ${STATUS_RU[appt.status] ?? appt.status}.`);
  }
  if (DateTime.fromISO(appt.start_utc).toMillis() <= ctx.now().toMillis()) return fail(`Запись №${id} уже в прошлом.`);
  return appt;
}

function deadlineError(ctx: ToolContext, appt: Appointment, action: string): ToolOutcome | null {
  const hoursLeft = DateTime.fromISO(appt.start_utc).diff(ctx.now(), "hours").hours;
  const deadline = ctx.clinic.booking.change_deadline_hours;
  if (hoursLeft < deadline) {
    return fail(
      `До приёма меньше ${deadline} ч — по правилам клиники ${action} так поздно можно только через администратора. ` +
        `Передай диалог администратору (handoff_to_admin, reason "late_change").`,
    );
  }
  return null;
}

function rescheduleAppointment(ctx: ToolContext, input: Input<"reschedule_appointment">): ToolOutcome {
  const { clinic } = ctx;
  const appt = loadOwnAppointment(ctx, input.appointment_id);
  if (!("id" in appt)) return appt;
  const late = deadlineError(ctx, appt, "перенести запись");
  if (late) return late;
  const limited = changeLimitError(ctx);
  if (limited) return limited;

  const service = findService(clinic, appt.service_id);
  if (!service) return fail("Услуга из этой записи больше не предоставляется. Передай вопрос администратору.");
  const doctor = resolveDoctorForService(clinic, service.id, input.doctor_id ?? appt.doctor_id);
  if (typeof doctor === "string") return fail(doctor);

  const start = parseLocalDateTime(input.date, input.time, clinic.timezone);
  if (!start) return fail("Дата должна быть в формате YYYY-MM-DD, время — HH:MM.");
  const end = start.plus({ minutes: service.duration_min });
  const now = ctx.now();

  // Сама переносимая запись не должна «занимать» время сама у себя.
  const busy = busyByDoctor(ctx, [doctor], start, start, appt.id).get(doctor.id) ?? [];
  const check = checkSlot({ clinic, doctor, service, start, now, busy });
  if (!check.ok) return fail(`${check.message} Найди другое время через find_available_slots.`);

  const result = ctx.repo.rescheduleAppointment(appt.id, {
    doctorId: doctor.id,
    startUtc: toUtcIso(start),
    endUtc: toUtcIso(end),
    nowUtc: toUtcIso(now),
  });
  if (!result.ok) {
    const messages = {
      busy: "Это время только что заняли. Найди другое время через find_available_slots.",
      patient_overlap: "У пациента уже есть другая запись на это время.",
      not_found: "Запись не найдена.",
    } as const;
    return fail(messages[result.reason]);
  }
  ctx.repo.logBookingEvent(clinic.id, ctx.phone, "rescheduled", toUtcIso(now));
  ctx.notify({ type: "appointment_rescheduled", appointment: result.appointment, previousStartUtc: appt.start_utc });
  return ok({ action: "rescheduled", ...describeAppointment(clinic, result.appointment) });
}

function cancelAppointment(ctx: ToolContext, input: Input<"cancel_appointment">): ToolOutcome {
  const appt = loadOwnAppointment(ctx, input.appointment_id);
  if (!("id" in appt)) return appt;
  const late = deadlineError(ctx, appt, "отменить запись");
  if (late) return late;
  const limited = changeLimitError(ctx);
  if (limited) return limited;

  const updated = ctx.repo.setAppointmentStatus(
    appt.id,
    "cancelled",
    toUtcIso(ctx.now()),
    input.reason?.trim() || "отменено пациентом в WhatsApp",
  )!;
  ctx.repo.logBookingEvent(ctx.clinic.id, ctx.phone, "cancelled", toUtcIso(ctx.now()));
  ctx.notify({ type: "appointment_cancelled", appointment: updated });
  return ok({ action: "cancelled", ...describeAppointment(ctx.clinic, updated) });
}

function confirmAppointment(ctx: ToolContext, input: Input<"confirm_appointment">): ToolOutcome {
  const appt = loadOwnAppointment(ctx, input.appointment_id);
  if (!("id" in appt)) return appt;
  if (appt.status === "confirmed") return ok({ action: "already_confirmed", ...describeAppointment(ctx.clinic, appt) });
  const updated = ctx.repo.setAppointmentStatus(appt.id, "confirmed", toUtcIso(ctx.now()))!;
  ctx.notify({ type: "appointment_confirmed", appointment: updated });
  return ok({ action: "confirmed", ...describeAppointment(ctx.clinic, updated) });
}

function handoffToAdmin(ctx: ToolContext, input: Input<"handoff_to_admin">): ToolOutcome {
  ctx.requestHandoff(input.reason, input.summary.trim().slice(0, 1500) || "без описания");
  return ok({
    status: "handed_off",
    note: "Администратор получил уведомление и ответит пациенту в этом чате. Коротко сообщи об этом пациенту (с учётом часов работы клиники).",
  });
}

function privacyRequest(ctx: ToolContext, input: Input<"privacy_request">): ToolOutcome {
  const { clinic, phone, repo } = ctx;
  const nowIso = toUtcIso(ctx.now());
  const details = input.details?.trim().slice(0, 1000) || null;
  const patient = repo.getPatient(clinic.id, phone);
  const patientName = patient?.name ?? patient?.wa_profile_name ?? null;

  if (input.kind === "stop_reminders") {
    repo.setRemindersOptOut(clinic.id, phone, true, nowIso);
    return ok({ status: "done", note: "Напоминания отключены. Скажи пациенту, что снова включить их можно словом «СТАРТ»." });
  }

  repo.createPrivacyRequest({ clinicId: clinic.id, phone, kind: input.kind, details, atUtc: nowIso });
  ctx.notify({ type: "privacy_request", phone, patientName, kind: input.kind, details });

  if (input.kind === "withdraw_consent") {
    repo.setConsent(clinic.id, phone, { status: "withdrawn", version: clinic.privacy.consent_version, method: "chat", atUtc: nowIso });
    repo.logConsent({ clinicId: clinic.id, phone, action: "withdrawn", version: clinic.privacy.consent_version, method: "chat", text: details, atUtc: nowIso });
    return ok({
      status: "done",
      note: "Согласие отозвано: ИИ больше не будет обрабатывать сообщения этого пациента, дальше ему ответит администратор. Коротко подтверди это пациенту.",
    });
  }
  return ok({
    status: "accepted",
    note:
      input.kind === "delete_data"
        ? "Запрос на удаление данных передан администратору. Скажи пациенту, что запрос принят и клиника сообщит, когда данные будут удалены."
        : "Запрос на копию данных передан администратору. Скажи пациенту, что запрос принят и клиника пришлёт данные.",
  });
}
