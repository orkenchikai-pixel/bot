import { existsSync } from "node:fs";
import { z } from "zod";

// Подхватываем .env из текущей папки, если он есть (Node 22+ умеет это без dotenv).
if (existsSync(".env")) process.loadEnvFile(".env");

const flag = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1" || v === "yes"));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/app.db"),
  CLINICS_DIR: z.string().default("./clinics"),

  // Claude. Ключ SDK читает сам из ANTHROPIC_API_KEY.
  // Префикс AGENT_, а не CLAUDE_: переменные CLAUDE_* использует Claude Code, и они бы перебивали настройки.
  AGENT_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  AGENT_FALLBACKS: z.enum(["default", "off"]).default("default"),
  AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(8),

  // WhatsApp Cloud API (Meta)
  WHATSAPP_API_VERSION: z.string().default("v27.0"),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // Уведомления администраторам
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Админ-API и веб-симулятор
  ADMIN_TOKEN: z.string().optional(),
  SIMULATOR_ENABLED: flag(false),
  /**
   * Ключ веб-симулятора (ссылка /simulator#key=…). Отдельный от ADMIN_TOKEN, чтобы ссылку на тестовый
   * чат можно было дать сотрудникам клиники, не раскрывая доступ к данным пациентов.
   */
  SIMULATOR_KEY: z.string().min(16, "SIMULATOR_KEY: минимум 16 символов").optional(),

  // Поведение диалога
  DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2500),
  HANDOFF_HOURS: z.coerce.number().positive().default(12),
  HISTORY_MAX_TURNS: z.coerce.number().int().positive().default(20),
  HISTORY_DAYS: z.coerce.number().positive().default(14),
  MAX_TURNS_PER_HOUR: z.coerce.number().int().positive().default(40),
  MAX_TURNS_PER_DAY: z.coerce.number().int().positive().default(150),
  MAX_INBOUND_CHARS: z.coerce.number().int().positive().default(2000),
  STALE_MESSAGE_HOURS: z.coerce.number().positive().default(12),

  // Антиспам
  SPAM_MAX_PER_MINUTE: z.coerce.number().int().positive().default(12),
  SPAM_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  SPAM_MAX_PER_DAY: z.coerce.number().int().positive().default(300),
  SPAM_DUPLICATE_MAX: z.coerce.number().int().positive().default(3),
  SPAM_NEW_CHATS_PER_HOUR: z.coerce.number().int().positive().default(60),
  SPAM_BLOCK_HOURS: z.coerce.number().positive().default(24),

  // Расходы на ИИ
  AI_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),
  /** Общий дневной бюджет по всем клиникам, USD (0 — без общего лимита). Лимит клиники — в её файле. */
  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(100),

  // Безопасность и персональные данные
  /** Ключ шифрования полей в базе. Сгенерировать: openssl rand -base64 32. Потеря ключа = потеря данных. */
  DATA_ENCRYPTION_KEY: z.string().min(16, "DATA_ENCRYPTION_KEY: минимум 16 символов (лучше openssl rand -base64 32)").optional(),
  /** Секрет канареечной метки в промпте (любая случайная строка). */
  CANARY_SECRET: z.string().optional(),
  /** true — писать тексты сообщений в логи (только для отладки!). */
  LOG_MESSAGE_TEXT: flag(false),
  /** true — сервер за обратным прокси (Caddy/Nginx): IP клиента берётся из X-Forwarded-For. */
  TRUST_PROXY: flag(false),
  ADMIN_MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(10),
  RETENTION_MESSAGES_DAYS: z.coerce.number().int().positive().default(180),
  RETENTION_APPOINTMENTS_DAYS: z.coerce.number().int().positive().default(1095),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(1095),

  // Резервные копии
  BACKUP_ENABLED: flag(true),
  BACKUP_DIR: z.string().default("./data/backups"),
  BACKUP_KEEP: z.coerce.number().int().positive().default(14),
  BACKUP_INTERVAL_HOURS: z.coerce.number().positive().default(24),

  // Напоминания о визите
  REMINDERS_ENABLED: flag(true),
  REMINDER_CHECK_INTERVAL_MIN: z.coerce.number().positive().default(5),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Пустые строки из .env (KEY=) считаем «не задано».
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Ошибка в переменных окружения:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.LOG_MESSAGE_TEXT) process.env.LOG_MESSAGE_TEXT = "true";
  return parsed.data;
}

/** Номер WhatsApp клиники указан (а не оставлен плейсхолдер из примера — REPLACE…). */
export function isWhatsAppConnected(clinic: { whatsapp: { phone_number_id: string } }): boolean {
  return !clinic.whatsapp.phone_number_id.startsWith("REPLACE");
}

/**
 * Проверки перед запуском в production (NODE_ENV=production): лучше не стартовать вовсе,
 * чем работать с открытым вебхуком, слабым паролем админки или незашифрованной базой.
 */
export function productionProblems(
  config: AppConfig,
  clinics: Array<{ id: string; whatsapp: { phone_number_id: string; access_token_env?: string }; privacy: { policy_url?: string; consent_mode: string } }>,
  env: NodeJS.ProcessEnv = process.env,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Клиника без номера WhatsApp (плейсхолдер REPLACE…) работает только в веб-симуляторе: так можно
  // установить бота и проверить его до того, как Meta выдаст номер и токен.
  const connected = clinics.filter((clinic) => isWhatsAppConnected(clinic));
  if (!env.ANTHROPIC_API_KEY) errors.push("ANTHROPIC_API_KEY не задан");
  if (connected.length > 0) {
    if (!config.WHATSAPP_APP_SECRET) errors.push("WHATSAPP_APP_SECRET не задан — нельзя проверить подпись вебхука");
    if (!config.WHATSAPP_VERIFY_TOKEN || config.WHATSAPP_VERIFY_TOKEN.length < 16) errors.push("WHATSAPP_VERIFY_TOKEN: нужна случайная строка от 16 символов");
  } else if (clinics.length > 0) {
    warnings.push("WhatsApp не подключён ни у одной клиники — бот отвечает только в веб-симуляторе");
  }
  if (config.ADMIN_TOKEN && config.ADMIN_TOKEN.length < 32) errors.push("ADMIN_TOKEN: нужна случайная строка от 32 символов (npm run token)");
  if (!config.DATA_ENCRYPTION_KEY) errors.push("DATA_ENCRYPTION_KEY не задан — медицинские данные нельзя хранить незашифрованными (openssl rand -base64 32)");
  if (!config.CANARY_SECRET) warnings.push("CANARY_SECRET не задан — используется значение по умолчанию");
  if (config.LOG_MESSAGE_TEXT) warnings.push("LOG_MESSAGE_TEXT=true — тексты пациентов пишутся в логи, выключите после отладки");
  if (config.SIMULATOR_ENABLED && !config.SIMULATOR_KEY && !config.ADMIN_TOKEN) {
    warnings.push("SIMULATOR_ENABLED без SIMULATOR_KEY — симулятор не будет включён");
  } else if (config.SIMULATOR_ENABLED && !config.SIMULATOR_KEY) {
    warnings.push("Симулятор открывается токеном суперадмина — задайте отдельный SIMULATOR_KEY, чтобы не раздавать доступ к админке");
  }
  for (const clinic of clinics) {
    if (!isWhatsAppConnected(clinic)) {
      warnings.push(`Клиника ${clinic.id}: WhatsApp не подключён (whatsapp.phone_number_id) — она доступна только в симуляторе`);
    } else {
      const tokenVar = clinic.whatsapp.access_token_env;
      if (tokenVar ? !env[tokenVar] : !config.WHATSAPP_ACCESS_TOKEN) {
        errors.push(`Клиника ${clinic.id}: не задан токен WhatsApp (${tokenVar ?? "WHATSAPP_ACCESS_TOKEN"})`);
      }
    }
    if (clinic.privacy.consent_mode !== "off" && !clinic.privacy.policy_url) {
      warnings.push(`Клиника ${clinic.id}: не указана ссылка на политику обработки данных (privacy.policy_url)`);
    }
  }
  return { errors, warnings };
}
