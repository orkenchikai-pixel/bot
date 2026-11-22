import "./scheduling/time.js";
import { serve } from "@hono/node-server";
import { createAgent, DEFAULT_CANARY_SECRET } from "./agent/factory.js";
import { ClinicRegistry } from "./clinic/registry.js";
import { loadConfig, productionProblems } from "./config.js";
import { openDatabase } from "./db/database.js";
import { Repo } from "./db/repo.js";
import { errorMessage, log } from "./log.js";
import { Dispatcher, type DispatcherSettings } from "./messaging/dispatcher.js";
import { Notifier } from "./notify/notifier.js";
import { backupDatabase, startBackupScheduler } from "./ops/backup.js";
import { startRetentionScheduler } from "./privacy/retention.js";
import { runReminderPass, startReminderScheduler } from "./reminders/scheduler.js";
import { FieldCipher } from "./security/crypto.js";
import { Semaphore } from "./security/ratelimit.js";
import { SpamGuard } from "./security/spam.js";
import { createApp } from "./server.js";
import { createSimulatorRoutes } from "./simulator/simulator.js";
import { WhatsAppCloudClient } from "./whatsapp/client.js";

process.on("unhandledRejection", (reason) => log.error("Необработанный отказ промиса", { error: errorMessage(reason) }));
process.on("uncaughtException", (err) => log.error("Необработанное исключение", { error: errorMessage(err) }));

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = await ClinicRegistry.loadFromDir(config.CLINICS_DIR);
  const production = process.env.NODE_ENV === "production";

  const problems = productionProblems(config, registry.list());
  if (production && problems.errors.length > 0) {
    throw new Error(`Конфигурация не готова к production:\n- ${problems.errors.join("\n- ")}`);
  }
  for (const warning of production ? problems.warnings : [...problems.errors, ...problems.warnings]) log.warn(warning);

  const cipher = new FieldCipher(config.DATA_ENCRYPTION_KEY);
  const db = openDatabase(config.DATABASE_PATH);
  const repo = new Repo(db, cipher);

  const transport = new WhatsAppCloudClient({
    apiVersion: config.WHATSAPP_API_VERSION,
    defaultAccessToken: config.WHATSAPP_ACCESS_TOKEN,
  });
  const notifier = new Notifier({ telegramBotToken: config.TELEGRAM_BOT_TOKEN });
  const agent = createAgent(config);
  const aiLimiter = new Semaphore(config.AI_MAX_CONCURRENT);
  const spamGuard = new SpamGuard({
    maxPerMinute: config.SPAM_MAX_PER_MINUTE,
    maxPerHour: config.SPAM_MAX_PER_HOUR,
    maxPerDay: config.SPAM_MAX_PER_DAY,
    duplicateMax: config.SPAM_DUPLICATE_MAX,
    newChatsPerHourPerClinic: config.SPAM_NEW_CHATS_PER_HOUR,
    autoBlockHours: config.SPAM_BLOCK_HOURS,
  });
  const settings: DispatcherSettings = {
    debounceMs: config.DEBOUNCE_MS,
    handoffHours: config.HANDOFF_HOURS,
    historyMaxTurns: config.HISTORY_MAX_TURNS,
    historyDays: config.HISTORY_DAYS,
    maxTurnsPerHour: config.MAX_TURNS_PER_HOUR,
    maxTurnsPerDay: config.MAX_TURNS_PER_DAY,
    maxInboundChars: config.MAX_INBOUND_CHARS,
    staleMessageHours: config.STALE_MESSAGE_HOURS,
    globalDailyBudgetUsd: config.AI_DAILY_BUDGET_USD,
    canarySecret: config.CANARY_SECRET ?? DEFAULT_CANARY_SECRET,
  };
  const dispatcher = new Dispatcher({ repo, registry, agent, transport, notifier, settings, spamGuard, aiLimiter });
  const reminderDeps = { repo, registry, transport, notifier };

  // Открытый симулятор на публичном сервере — это бесплатный доступ к вашему ключу Claude для всех.
  const simulatorEnabled = config.SIMULATOR_ENABLED && (Boolean(config.ADMIN_TOKEN) || !production);
  if (config.SIMULATOR_ENABLED && !simulatorEnabled) log.warn("Симулятор выключен: в production он работает только с ADMIN_TOKEN");

  const app = createApp({
    registry,
    dispatcher,
    trustProxy: config.TRUST_PROXY,
    whatsapp: { verifyToken: config.WHATSAPP_VERIFY_TOKEN, appSecret: config.WHATSAPP_APP_SECRET },
    admin: {
      adminToken: config.ADMIN_TOKEN,
      clinicsDir: config.CLINICS_DIR,
      registry,
      repo,
      dispatcher,
      maxFailedLogins: config.ADMIN_MAX_FAILED_LOGINS,
      runReminders: () => runReminderPass(reminderDeps),
      runBackup: () => backupDatabase(db, config.BACKUP_DIR, config.BACKUP_KEEP),
    },
    simulator: simulatorEnabled
      ? createSimulatorRoutes({
          registry,
          agent,
          cipher,
          dbPath: config.DATABASE_PATH.replace(/(\.db)?$/, "-simulator.db"),
          adminToken: config.ADMIN_TOKEN,
          settings,
        })
      : undefined,
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log.info(`Сервер запущен: http://localhost:${info.port}`);
    log.info(`Клиники: ${registry.list().map((c) => `${c.name} (${c.id})`).join(", ")}`);
    log.info(`Модель: ${config.AGENT_MODEL}, effort: ${config.AGENT_EFFORT}; шифрование базы: ${cipher.enabled ? "включено" : "ВЫКЛЮЧЕНО"}`);
    if (simulatorEnabled) {
      log.info(`Веб-симулятор: http://localhost:${info.port}/simulator${config.ADMIN_TOKEN ? "#key=<ADMIN_TOKEN>" : ""}`);
    }
  });

  dispatcher.recoverUnprocessed();
  const stoppers = [
    config.REMINDERS_ENABLED ? startReminderScheduler(reminderDeps, config.REMINDER_CHECK_INTERVAL_MIN) : () => undefined,
    startRetentionScheduler(repo, {
      messagesDays: config.RETENTION_MESSAGES_DAYS,
      appointmentsDays: config.RETENTION_APPOINTMENTS_DAYS,
      auditDays: config.RETENTION_AUDIT_DAYS,
    }),
    config.BACKUP_ENABLED ? startBackupScheduler(db, config.BACKUP_DIR, config.BACKUP_KEEP, config.BACKUP_INTERVAL_HOURS) : () => undefined,
  ];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Получен ${signal}, останавливаемся…`);
    stoppers.forEach((stop) => stop());
    server.close();
    await dispatcher.shutdown();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Не удалось запустить сервер: ${errorMessage(err)}`);
  process.exit(1);
});
