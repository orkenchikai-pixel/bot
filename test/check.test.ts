import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { demoDataWarnings, loadDemoTemplate } from "../src/clinic/demo.js";
import { parseClinicJson } from "../src/clinic/registry.js";
import { loadConfig, productionProblems } from "../src/config.js";
import { checkSetup, formatCheckReport } from "../src/ops/check.js";
import { testClinic } from "./helpers.js";

const demo = parseClinicJson(readFileSync("clinics/demo.json", "utf8"));

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  WHATSAPP_ACCESS_TOKEN: "EAAtest",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify-token-1234567890",
  DATA_ENCRYPTION_KEY: "k".repeat(64),
  CANARY_SECRET: "c".repeat(32),
  ADMIN_TOKEN: "a".repeat(64),
  SIMULATOR_KEY: "s".repeat(48),
};

const dirs: string[] = [];
function clinicsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clinics-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const clinicJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify(testClinic({ privacy: { consent_mode: "explicit", policy_url: "https://x.kz/p" }, ...overrides }));

describe("проверка настроек (npm run check / dental-bot check)", () => {
  it("готовая конфигурация проходит проверку production", async () => {
    const report = await checkSetup({ ...SECRETS, CLINICS_DIR: clinicsDir({ "test.json": clinicJson() }) }, { production: true });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatCheckReport(report)).toMatch(/Тест Дент.*WhatsApp подключён[\s\S]*Настройки в порядке/);
  });

  it("опечатка в файле клиники — ошибка с именем файла, бот не перезапускается", async () => {
    const dir = clinicsDir({ "broken.json": '{ "id": "x", ' });
    const report = await checkSetup({ ...SECRETS, CLINICS_DIR: dir }, { production: true });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/broken\.json: некорректный JSON/);
    expect(formatCheckReport(report)).toMatch(/бот не запустится/);
  });

  it("ошибка в расписании врача объясняется по-русски", async () => {
    const bad = JSON.parse(clinicJson());
    bad.doctors[0].schedule.mon = [["18:00", "09:00"]];
    const report = await checkSetup({ ...SECRETS, CLINICS_DIR: clinicsDir({ "test.json": JSON.stringify(bad) }) }, { production: true });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/начало интервала должно быть раньше конца/);
  });

  it("без секретов в production — ошибки; на своём компьютере — только предупреждения", async () => {
    const dir = clinicsDir({ "test.json": clinicJson() });
    const prod = await checkSetup({ CLINICS_DIR: dir }, { production: true });
    expect(prod.ok).toBe(false);
    expect(prod.errors.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    const dev = await checkSetup({ CLINICS_DIR: dir }, { production: false });
    expect(dev.ok).toBe(true);
    expect(dev.warnings.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("предупреждает о забытых демо-врачах и ценах", async () => {
    const fromDemo = { ...demo, id: "ulybka", name: "Улыбка" };
    const report = await checkSetup({ ...SECRETS, CLINICS_DIR: clinicsDir({ "ulybka.json": JSON.stringify(fromDemo) }) }, { production: true });
    expect(report.ok).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/демо-примера.*dental-bot edit ulybka/);
  });
});

describe("демо-данные", () => {
  it("находит шаблон в репозитории и не ругается на сам пример и на свои данные", () => {
    const template = loadDemoTemplate();
    expect(template?.id).toBe("demo");
    expect(demoDataWarnings([demo], template)).toEqual([]);
    expect(demoDataWarnings([testClinic()], template)).toEqual([]);
    expect(demoDataWarnings([testClinic()], undefined)).toEqual([]);
  });

  it("достаточно одного демо-врача или трёх демо-цен", () => {
    const template = loadDemoTemplate()!;
    const oneDoctor = testClinic({
      doctors: [{ ...testClinic().doctors[0], name: demo.doctors[0]!.name }],
    });
    expect(demoDataWarnings([oneDoctor], template)).toHaveLength(1);
    const prices = demo.services.slice(0, 3).map((s) => ({ ...s, id: `demo-${s.id}`, bookable: false }));
    const threePrices = testClinic({ services: [...testClinic().services, ...prices] });
    expect(demoDataWarnings([threePrices], template)).toHaveLength(1);
  });
});

describe("симулятор и токены", () => {
  it("советует отдельный SIMULATOR_KEY вместо токена суперадмина", () => {
    const { SIMULATOR_KEY: _omit, ...rest } = SECRETS;
    const withAdminOnly = productionProblems(loadConfig({ ...rest, SIMULATOR_ENABLED: "true" }), [testClinic()], rest);
    expect(withAdminOnly.warnings.join("\n")).toMatch(/SIMULATOR_KEY/);
    const separate = productionProblems(loadConfig({ ...SECRETS, SIMULATOR_ENABLED: "true" }), [testClinic()], SECRETS);
    expect(separate.warnings.join("\n")).not.toMatch(/SIMULATOR_KEY/);
    expect(() => loadConfig({ SIMULATOR_KEY: "short" })).toThrow(/SIMULATOR_KEY/);
  });
});
