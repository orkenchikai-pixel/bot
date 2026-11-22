import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClinicRegistry } from "../src/clinic/registry.js";
import { createApp } from "../src/server.js";
import { createSimulatorRoutes } from "../src/simulator/simulator.js";
import { setup, testClinic } from "./helpers.js";

const SUPER = "super-admin-token-0123456789abcdef";
const CLINIC_A_TOKEN = "clinic-a-token-0123456789abcdefgh";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function build(options: { maxFailedLogins?: number } = {}) {
  const clinicA = testClinic({ id: "clinic-a", whatsapp: { phone_number_id: "PNA" }, admin: { token_sha256: sha(CLINIC_A_TOKEN) } });
  const clinicB = testClinic({ id: "clinic-b", name: "Другая клиника", whatsapp: { phone_number_id: "PNB" } });
  const t = setup({ clinic: clinicA });
  t.registry.replaceAll([clinicA, clinicB]);
  const app = createApp({
    registry: t.registry,
    dispatcher: t.dispatcher,
    whatsapp: { verifyToken: "verify-token-123456", appSecret: "app-secret" },
    admin: {
      adminToken: SUPER,
      clinicsDir: "./clinics",
      registry: t.registry,
      repo: t.repo,
      dispatcher: t.dispatcher,
      maxFailedLogins: options.maxFailedLogins ?? 10,
      runReminders: async () => ({ sent: 0, skipped: 0 }),
    },
    simulator: createSimulatorRoutes({
      registry: new ClinicRegistry([clinicA]),
      agent: t.agent,
      dbPath: ":memory:",
      accessKey: SUPER,
      settings: { debounceMs: 0, handoffHours: 12, historyMaxTurns: 20, historyDays: 14 },
    }),
  });
  const as = (token: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  return { ...t, app, as };
}

describe("админ-API: доступ", () => {
  it("токен клиники видит только свою клинику", async () => {
    const t = build();
    const own = await t.app.request("/admin/appointments?clinic=clinic-a", t.as(CLINIC_A_TOKEN));
    expect(own.status).toBe(200);
    const foreign = await t.app.request("/admin/appointments?clinic=clinic-b", t.as(CLINIC_A_TOKEN));
    expect(foreign.status).toBe(403);
    const list = (await (await t.app.request("/admin/clinics", t.as(CLINIC_A_TOKEN))).json()) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual(["clinic-a"]);
    const all = (await (await t.app.request("/admin/clinics", t.as(SUPER))).json()) as Array<{ id: string }>;
    expect(all.map((c) => c.id)).toEqual(["clinic-a", "clinic-b"]);
  });

  it("действия только для владельца сервиса недоступны клинике", async () => {
    const t = build();
    expect((await t.app.request("/admin/clinics/reload", t.as(CLINIC_A_TOKEN, { method: "POST" }))).status).toBe(403);
    expect((await t.app.request("/admin/reminders/run", t.as(CLINIC_A_TOKEN, { method: "POST" }))).status).toBe(403);
  });

  it("перебор токена: после N неудач — 429 даже с правильным токеном", async () => {
    const t = build({ maxFailedLogins: 3 });
    for (let i = 0; i < 3; i++) expect((await t.app.request("/admin/clinics", t.as(`wrong-${i}`))).status).toBe(401);
    const blocked = await t.app.request("/admin/clinics", t.as(SUPER));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
  });

  it("некорректный номер и чужая запись отклоняются", async () => {
    const t = build();
    expect((await t.app.request("/admin/conversations/clinic-a/abc'%20OR%201=1", t.as(SUPER))).status).toBe(400);
    const created = t.repo.createAppointment({
      clinicId: "clinic-b",
      patientPhone: "77010000009",
      patientName: "Чужой пациент",
      doctorId: "ivanova",
      serviceId: "consult",
      startUtc: "2026-11-24T04:00:00.000Z",
      endUtc: "2026-11-24T04:30:00.000Z",
      nowUtc: "2026-11-20T00:00:00.000Z",
      maxActivePerPatient: 3,
    });
    if (!created.ok) throw new Error("не создана");
    const res = await t.app.request(
      `/admin/appointments/${created.appointment.id}/status`,
      t.as(CLINIC_A_TOKEN, { method: "POST", body: JSON.stringify({ status: "cancelled" }), headers: { "Content-Type": "application/json" } }),
    );
    expect(res.status).toBe(403);
    expect(t.repo.getAppointment(created.appointment.id)?.status).toBe("booked");
  });
});

describe("админ-API: права пациента и аудит", () => {
  it("выгрузка, удаление (с подтверждением) и журнал аудита", async () => {
    const t = build();
    t.repo.touchPatient("clinic-a", "77010000001", "Aigerim", "2026-11-23T03:00:00.000Z");
    t.repo.logInbound({ clinicId: "clinic-a", phone: "77010000001", text: "Болит зуб", createdAtUtc: "2026-11-23T03:00:00.000Z" });

    const exported = await t.app.request("/admin/patients/clinic-a/77010000001/export", t.as(CLINIC_A_TOKEN));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(JSON.stringify(await exported.json())).toContain("Болит зуб");

    const noConfirm = await t.app.request("/admin/patients/clinic-a/77010000001", t.as(CLINIC_A_TOKEN, { method: "DELETE" }));
    expect(noConfirm.status).toBe(400);
    const erased = await t.app.request("/admin/patients/clinic-a/77010000001?confirm=77010000001", t.as(CLINIC_A_TOKEN, { method: "DELETE" }));
    expect(erased.status).toBe(200);
    expect(t.repo.getPatient("clinic-a", "77010000001")).toBeUndefined();

    const audit = (await (await t.app.request("/admin/audit?clinic=clinic-a", t.as(CLINIC_A_TOKEN))).json()) as Array<{ action: string; actor: string; target: string }>;
    expect(audit.map((a) => a.action)).toEqual(["erase_patient", "export_patient"]);
    expect(audit[0]).toMatchObject({ actor: "clinic-admin:clinic-a", target: "7701*****01" });
  });

  it("блок-лист через API", async () => {
    const t = build();
    const json = { "Content-Type": "application/json" };
    const blocked = await t.app.request("/admin/blocklist/clinic-a/77010000005", t.as(SUPER, { method: "POST", headers: json, body: JSON.stringify({ hours: 2, reason: "оскорбления" }) }));
    expect(blocked.status).toBe(200);
    const list = (await (await t.app.request("/admin/blocklist?clinic=clinic-a", t.as(SUPER))).json()) as Array<{ phone: string; reason: string }>;
    expect(list).toMatchObject([{ phone: "77010000005", reason: "оскорбления" }]);
    const removed = await t.app.request("/admin/blocklist/clinic-a/77010000005", t.as(SUPER, { method: "DELETE" }));
    expect(await removed.json()).toMatchObject({ removed: true });
  });

  it("расходы по клинике", async () => {
    const t = build();
    t.repo.addUsage("clinic-a", "2026-11-22", { turns: 3, requests: 5, input: 1000, output: 200, cacheRead: 5000, cacheWrite: 800, costUsd: 0.12 });
    t.repo.addUsage("clinic-b", "2026-11-22", { turns: 1, requests: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 });
    const own = (await (await t.app.request("/admin/usage?from=2026-11-01&to=2026-11-30", t.as(CLINIC_A_TOKEN))).json()) as { total_cost_usd: number };
    expect(own.total_cost_usd).toBe(0.12);
    const all = (await (await t.app.request("/admin/usage?from=2026-11-01&to=2026-11-30", t.as(SUPER))).json()) as { total_cost_usd: number };
    expect(all.total_cost_usd).toBe(0.62);
    expect((await t.app.request("/admin/usage?clinic=clinic-b", t.as(CLINIC_A_TOKEN))).status).toBe(403);
  });
});

describe("HTTP-защита", () => {
  it("заголовки безопасности на всех ответах", async () => {
    const t = build();
    const res = await t.app.request("/health");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("слишком большой запрос отклоняется (413)", async () => {
    const t = build();
    const res = await t.app.request("/admin/conversations/clinic-a/77010000001/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPER}`, "Content-Type": "application/json", "Content-Length": String(200 * 1024) },
      body: JSON.stringify({ text: "x".repeat(200 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("неизвестный путь — 404 в JSON без подробностей", async () => {
    const t = build();
    const res = await t.app.request("/.env");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("симулятор: страница со строгим CSP и nonce, API — только с ключом в заголовке", async () => {
    const t = build();
    const page = await t.app.request("/simulator");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy")!;
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(await page.text()).toContain(`<script nonce="${nonce}">`);

    expect((await t.app.request("/simulator/api/clinics")).status).toBe(401);
    expect((await t.app.request("/simulator/api/clinics?key=" + SUPER)).status).toBe(401); // ключ в URL не принимается
    expect((await t.app.request("/simulator/api/clinics", { headers: { "X-Simulator-Key": SUPER } })).status).toBe(200);
  });
});
