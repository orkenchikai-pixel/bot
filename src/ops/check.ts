import { demoDataWarnings, loadDemoTemplate } from "../clinic/demo.js";
import { ClinicRegistry } from "../clinic/registry.js";
import type { ClinicConfig } from "../clinic/schema.js";
import { isWhatsAppConnected, loadConfig, productionProblems, type AppConfig } from "../config.js";
import { errorMessage } from "../log.js";

export interface CheckReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  clinics: ClinicConfig[];
}

/**
 * Полная проверка настроек без запуска сервера: переменные окружения, файлы клиник (формат,
 * расписание, ссылки врачей на услуги, уникальность номеров) и, в production, обязательные секреты.
 * Её запускают мастер установки и команда dental-bot перед каждым перезапуском, чтобы опечатка
 * в прайсе не остановила работающего бота.
 */
export async function checkSetup(
  env: NodeJS.ProcessEnv = process.env,
  options: { production?: boolean; templatePaths?: string[] } = {},
): Promise<CheckReport> {
  const production = options.production ?? env.NODE_ENV === "production";
  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (err) {
    return { ok: false, errors: [errorMessage(err)], warnings: [], clinics: [] };
  }
  let clinics: ClinicConfig[];
  try {
    clinics = (await ClinicRegistry.loadFromDir(config.CLINICS_DIR)).list();
  } catch (err) {
    return { ok: false, errors: [errorMessage(err)], warnings: [], clinics: [] };
  }
  const problems = productionProblems(config, clinics, env);
  const errors = production ? problems.errors : [];
  const warnings = [
    ...(production ? [] : problems.errors),
    ...problems.warnings,
    ...demoDataWarnings(clinics, loadDemoTemplate(options.templatePaths)),
  ];
  return { ok: errors.length === 0, errors, warnings, clinics };
}

export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const clinic of report.clinics) {
    const whatsapp = isWhatsAppConnected(clinic) ? "WhatsApp подключён" : "WhatsApp не подключён";
    lines.push(`✓ Клиника «${clinic.name}» (${clinic.id}): услуг ${clinic.services.length}, врачей ${clinic.doctors.length}, ${whatsapp}`);
  }
  for (const error of report.errors) lines.push(`✗ ${error}`);
  for (const warning of report.warnings) lines.push(`! ${warning}`);
  lines.push(report.ok ? "Настройки в порядке." : "Есть ошибки — с такими настройками бот не запустится.");
  return lines.join("\n");
}
