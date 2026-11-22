import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ClinicSchema, type ClinicConfig } from "./schema.js";

/**
 * Хранит настройки всех клиник. Источник правды — JSON-файлы в папке clinics/:
 * один файл = одна клиника (прайс, врачи, расписание, FAQ, номер WhatsApp).
 */
export class ClinicRegistry {
  private byId = new Map<string, ClinicConfig>();
  private byPhoneNumberId = new Map<string, ClinicConfig>();

  constructor(clinics: ClinicConfig[] = []) {
    this.replaceAll(clinics);
  }

  static async loadFromDir(dir: string): Promise<ClinicRegistry> {
    const registry = new ClinicRegistry();
    await registry.reloadFromDir(dir);
    return registry;
  }

  async reloadFromDir(dir: string): Promise<ClinicConfig[]> {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const clinics: ClinicConfig[] = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      clinics.push(parseClinicJson(await readFile(fullPath, "utf8"), fullPath));
    }
    if (clinics.length === 0) throw new Error(`В папке ${dir} нет ни одного файла клиники (*.json)`);
    this.replaceAll(clinics);
    return clinics;
  }

  replaceAll(clinics: ClinicConfig[]): void {
    const byId = new Map<string, ClinicConfig>();
    const byPhone = new Map<string, ClinicConfig>();
    for (const clinic of clinics) {
      if (byId.has(clinic.id)) throw new Error(`Две клиники с одинаковым id "${clinic.id}"`);
      if (byPhone.has(clinic.whatsapp.phone_number_id)) {
        throw new Error(`Две клиники с одним WhatsApp phone_number_id "${clinic.whatsapp.phone_number_id}"`);
      }
      byId.set(clinic.id, clinic);
      byPhone.set(clinic.whatsapp.phone_number_id, clinic);
    }
    this.byId = byId;
    this.byPhoneNumberId = byPhone;
  }

  get(id: string): ClinicConfig | undefined {
    return this.byId.get(id);
  }

  getByPhoneNumberId(phoneNumberId: string): ClinicConfig | undefined {
    return this.byPhoneNumberId.get(phoneNumberId);
  }

  list(): ClinicConfig[] {
    return [...this.byId.values()];
  }
}

export function parseClinicJson(json: string, source = "clinic.json"): ClinicConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source}: некорректный JSON (${(err as Error).message})`);
  }
  const parsed = ClinicSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: ошибка в настройках клиники:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
