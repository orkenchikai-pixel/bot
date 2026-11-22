import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { guardContextFor } from "../src/agent/safety.js";
import { executeTool } from "../src/agent/tools.js";
import { detectConsentAnswer } from "../src/privacy/consent.js";
import { FieldCipher } from "../src/security/crypto.js";
import { guardReply } from "../src/security/output-guard.js";
import { sanitizeInbound } from "../src/security/sanitize.js";
import { findSlots, type BusyInterval } from "../src/scheduling/slots.js";
import { DateTime } from "../src/scheduling/time.js";
import { splitMessage, toWhatsAppText } from "../src/whatsapp/format.js";
import { parseWebhookPayload } from "../src/whatsapp/webhook.js";
import { memoryRepo, MONDAY_8AM, testClinic } from "./helpers.js";

/**
 * Property-based тесты: вместо пары примеров fast-check генерирует сотни случайных входов
 * и проверяет, что инварианты не нарушаются никогда.
 */
const clinic = testClinic();
const consult = clinic.services.find((s) => s.id === "consult")!;
const ivanova = clinic.doctors.find((d) => d.id === "ivanova")!;

describe("свойства расчёта слотов", () => {
  it("слот никогда не пересекается с занятым временем и всегда внутри рабочих часов", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ startMin: fc.integer({ min: 0, max: 14 * 24 * 60 }), length: fc.integer({ min: 15, max: 180 }) }), { maxLength: 15 }),
        fc.integer({ min: 0, max: 13 }),
        (busySpecs, dayOffset) => {
          const base = DateTime.fromISO("2026-11-23T00:00", { zone: clinic.timezone });
          const busy: BusyInterval[] = busySpecs.map((b) => ({ start: base.plus({ minutes: b.startMin }), end: base.plus({ minutes: b.startMin + b.length }) }));
          const day = base.plus({ days: dayOffset }).toISODate();
          const result = findSlots({ clinic, service: consult, doctors: [ivanova], fromDate: day, toDate: day, now: MONDAY_8AM, busyByDoctor: new Map([["ivanova", busy]]) });
          for (const d of result) {
            for (const time of d.times) {
              const start = DateTime.fromISO(`${d.date}T${time}`, { zone: clinic.timezone });
              const end = start.plus({ minutes: consult.duration_min });
              expect(busy.some((b) => start.toMillis() < b.end.toMillis() && end.toMillis() > b.start.toMillis())).toBe(false);
              expect(start.toMillis()).toBeGreaterThanOrEqual(MONDAY_8AM.plus({ minutes: 60 }).toMillis());
              const intervals = ivanova.schedule[(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)[start.weekday - 1]!] ?? [];
              expect(intervals.some(([s, e]) => time >= s && end.toFormat("HH:mm") <= e)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("устойчивость к мусорному вводу (fuzzing)", () => {
  it("разбор вебхука никогда не падает", () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        expect(Array.isArray(parseWebhookPayload(payload))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("разбор вебхука с правдоподобной структурой и случайными полями не падает", () => {
    const message = fc.record({ from: fc.string(), id: fc.string(), type: fc.constantFrom("text", "image", "interactive", "button", "audio", "x"), text: fc.anything(), interactive: fc.anything(), image: fc.anything() });
    fc.assert(
      fc.property(fc.array(message), (messages) => {
        const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages } }] }] };
        for (const parsed of parseWebhookPayload(payload)) expect(parsed.from).toMatch(/^\d+$/);
      }),
    );
  });

  it("инструменты на случайных аргументах не падают и не создают записей мимо проверок", async () => {
    const repo = memoryRepo();
    const ctx = { clinic, phone: "77010000001", repo, now: () => MONDAY_8AM, notify: () => undefined, requestHandoff: () => undefined };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("find_available_slots", "book_appointment", "reschedule_appointment", "cancel_appointment", "confirm_appointment", "get_my_appointments", "privacy_request"),
        fc.dictionary(fc.constantFrom("service_id", "doctor_id", "date", "date_from", "date_to", "time", "patient_name", "appointment_id", "kind"), fc.oneof(fc.string(), fc.integer(), fc.constant(null))),
        async (name, input) => {
          const outcome = await executeTool(name, input, ctx);
          expect(typeof outcome.content).toBe("string");
        },
      ),
      { numRuns: 300 },
    );
    // Случайные строки не проходят проверку формата даты/времени — записей нет
    expect(repo.listAppointments("test", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("свойства защиты", () => {
  const ctx = guardContextFor(testClinic({ website: "https://tes.kz" }), "77010000001", "secret");

  it("фильтр ответа идемпотентен и не пропускает канарейку", () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (text, withCanary) => {
        const input = withCanary ? `${text}${ctx.canary}` : text;
        const once = guardReply(input, ctx);
        if (withCanary) expect(once.blocked).toBe(true);
        expect(once.text).not.toContain(ctx.canary);
        expect(guardReply(once.text, ctx).text).toBe(once.text);
      }),
      { numRuns: 300 },
    );
  });

  it("очистка входа: результат не длиннее лимита (+пометка) и без невидимых символов", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1, max: 500 }), (text, max) => {
        const { text: out } = sanitizeInbound(text, max);
        expect([...out].length).toBeLessThanOrEqual(max + 25);
        expect([...out].some((ch) => (ch.codePointAt(0)! >= 0xe0000 && ch.codePointAt(0)! <= 0xe007f) || ch.codePointAt(0) === 0x200b)).toBe(false);
      }),
    );
  });

  it("шифрование: расшифровка возвращает исходный текст для любых строк", () => {
    const cipher = new FieldCipher("property-test-key-1");
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        expect(cipher.decrypt(cipher.encrypt(text))).toBe(text);
      }),
    );
  });

  it("согласие: длинные и случайные тексты не считаются ответом «да»", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 31 }), (text) => {
        expect(detectConsentAnswer(text)).toBeNull();
      }),
    );
  });
});

describe("свойства форматирования", () => {
  it("разбиение на части: каждая влезает в лимит, текст не теряется", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), fc.integer({ min: 20, max: 500 }), (text, max) => {
        const parts = splitMessage(text, max);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(max);
        expect(parts.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
      }),
      { numRuns: 300 },
    );
  });

  it("toWhatsAppText идемпотентна", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(toWhatsAppText(toWhatsAppText(text))).toBe(toWhatsAppText(text));
      }),
    );
  });
});
