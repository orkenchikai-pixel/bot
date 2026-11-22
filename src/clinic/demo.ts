import { existsSync, readFileSync } from "node:fs";
import { parseClinicJson } from "./registry.js";
import type { ClinicConfig } from "./schema.js";

/** Где лежит демо-пример клиники: в Docker-образе (templates/) и в репозитории (clinics/). */
export const DEMO_TEMPLATE_PATHS = ["templates/clinic-demo.json", "clinics/demo.json"];

export function loadDemoTemplate(paths: string[] = DEMO_TEMPLATE_PATHS): ClinicConfig | undefined {
  for (const file of paths) {
    if (!existsSync(file)) continue;
    try {
      return parseClinicJson(readFileSync(file, "utf8"), file);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Мастер установки создаёт клинику из демо-примера, чтобы бота можно было сразу проверить.
 * Если врачи или цены из примера остались, бот будет называть пациентам вымышленных врачей
 * и чужие цены, поэтому о них предупреждаем при каждой проверке и запуске.
 */
export function demoDataWarnings(clinics: ClinicConfig[], template: ClinicConfig | undefined): string[] {
  if (!template) return [];
  const demoDoctors = new Set(template.doctors.map((d) => d.name));
  const demoPrices = new Set(template.services.map((s) => `${s.name}|${s.price_from}`));
  const warnings: string[] = [];
  for (const clinic of clinics) {
    if (clinic.id === template.id) continue; // сам демо-пример
    const doctors = clinic.doctors.filter((d) => demoDoctors.has(d.name)).length;
    const prices = clinic.services.filter((s) => demoPrices.has(`${s.name}|${s.price_from}`)).length;
    if (doctors > 0 || prices >= 3) {
      warnings.push(
        `Клиника ${clinic.id}: в файле остались врачи или цены из демо-примера — замените своими (dental-bot edit ${clinic.id})`,
      );
    }
  }
  return warnings;
}
