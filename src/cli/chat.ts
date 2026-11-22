/**
 * Чат с ИИ-администратором прямо в терминале — без WhatsApp.
 *   npm run chat
 *   npm run chat -- --clinic demo --phone 77010000001 --name Айгерим --verbose
 */
import "../scheduling/time.js";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { createAgent, DEFAULT_CANARY_SECRET } from "../agent/factory.js";
import { FieldCipher } from "../security/crypto.js";
import { STATUS_RU } from "../agent/prompt.js";
import { ClinicRegistry } from "../clinic/registry.js";
import { findDoctor, findService, type ClinicConfig } from "../clinic/schema.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { Repo } from "../db/repo.js";
import { Dispatcher } from "../messaging/dispatcher.js";
import type { Transport } from "../messaging/transport.js";
import { formatAdminEvent, Notifier, type AdminEvent } from "../notify/notifier.js";
import { DateTime, formatDateTimeLongRu, fromUtcIso, toUtcIso } from "../scheduling/time.js";

const { values: args } = parseArgs({
  options: {
    clinic: { type: "string" },
    phone: { type: "string", default: "77000000001" },
    name: { type: "string" },
    db: { type: "string", default: "./data/cli-chat.db" },
    verbose: { type: "boolean", default: false },
  },
});

if (!args.verbose) process.env.LOG_LEVEL = "warn";

const color = {
  bot: (s: string) => `\x1b[36m${s}\x1b[0m`,
  admin: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

class ConsoleTransport implements Transport {
  async sendText(_clinic: ClinicConfig, _to: string, text: string): Promise<{ messageId?: string }> {
    console.log(`\n${color.bot("Бот:")} ${text}\n`);
    return {};
  }
}

class ConsoleNotifier extends Notifier {
  override async notify(clinic: ClinicConfig, event: AdminEvent): Promise<void> {
    console.log(color.admin(`\n[Уведомление администратору]\n${formatAdminEvent(clinic, event)}\n`));
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = await ClinicRegistry.loadFromDir(config.CLINICS_DIR);
  const clinic = args.clinic ? registry.get(args.clinic) : registry.list()[0];
  if (!clinic) throw new Error(`Клиника "${args.clinic}" не найдена. Есть: ${registry.list().map((c) => c.id).join(", ")}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(color.admin("⚠️  ANTHROPIC_API_KEY не задан. Добавьте ключ в .env (см. .env.example).\n"));
  }

  const repo = new Repo(openDatabase(args.db!), new FieldCipher(config.DATA_ENCRYPTION_KEY));
  const phone = args.phone!;
  const dispatcher = new Dispatcher({
    repo,
    registry,
    agent: createAgent(config),
    transport: new ConsoleTransport(),
    notifier: new ConsoleNotifier(),
    settings: {
      debounceMs: 0,
      handoffHours: config.HANDOFF_HOURS,
      historyMaxTurns: config.HISTORY_MAX_TURNS,
      historyDays: config.HISTORY_DAYS,
      maxInboundChars: config.MAX_INBOUND_CHARS,
      canarySecret: config.CANARY_SECRET ?? DEFAULT_CANARY_SECRET,
    },
  });

  console.log(`Клиника: ${clinic.name}. Вы пишете как пациент с номера +${phone}.`);
  console.log(color.dim("Команды: /reset — новый диалог, /appointments — записи, /resume — вернуть бота, /exit — выход\n"));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("close", () => process.exit(0));
  for (;;) {
    const line = (await rl.question("Вы: ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/reset") {
      // Полный сброс тестового пациента: переписка, согласие, записи.
      repo.erasePatient(clinic.id, phone, toUtcIso(DateTime.utc()));
      dispatcher.unblockNumber(clinic.id, phone);
      console.log(color.dim("Диалог сброшен (данные тестового пациента удалены).\n"));
      continue;
    }
    if (line === "/resume") {
      dispatcher.resumeBot(clinic.id, phone);
      console.log(color.dim("Бот снова отвечает.\n"));
      continue;
    }
    if (line === "/appointments") {
      const list = repo.patientAppointments(clinic.id, phone, toUtcIso(DateTime.utc()));
      if (list.length === 0) console.log(color.dim("Записей нет.\n"));
      for (const a of list) {
        console.log(
          color.dim(
            `№${a.id}: ${formatDateTimeLongRu(fromUtcIso(a.start_utc, clinic.timezone))} — ` +
              `${findService(clinic, a.service_id)?.name}, ${findDoctor(clinic, a.doctor_id)?.name}, ${a.patient_name} (${STATUS_RU[a.status]})`,
          ),
        );
      }
      console.log();
      continue;
    }
    await dispatcher.handleInbound({ clinicId: clinic.id, phone, profileName: args.name, text: line });
    await dispatcher.waitForIdle(clinic.id, phone);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
