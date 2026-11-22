import type { ClinicConfig } from "../clinic/schema.js";
import { canaryFor, extractInstructionLines, hostOf, type GuardContext } from "../security/output-guard.js";
import { buildRules } from "./prompt.js";

/** Канареечная метка клиники для системного промпта (см. security/output-guard.ts). */
export function clinicCanary(clinic: ClinicConfig, secret: string): string {
  return canaryFor(clinic.id, secret);
}

/** Что разрешено и что считается утечкой в ответах бота этой клиники этому пациенту. */
export function guardContextFor(clinic: ClinicConfig, patientPhone: string, secret: string): GuardContext {
  // Без секрета агент не добавляет метку в промпт — значит, и искать её не нужно.
  const canary = secret ? clinicCanary(clinic, secret) : "";
  const hosts = [hostOf(clinic.website), hostOf(clinic.map_url), hostOf(clinic.privacy.policy_url)];
  if (clinic.instagram) hosts.push("instagram.com");
  return {
    canary,
    instructionLines: extractInstructionLines(buildRules(clinic, canary)),
    allowedHosts: hosts.filter((h): h is string => Boolean(h)),
    allowedPhones: [clinic.phone?.replace(/\D/g, ""), patientPhone.replace(/\D/g, "")].filter((p): p is string => Boolean(p)),
  };
}
