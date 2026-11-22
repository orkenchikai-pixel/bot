import "../src/scheduling/time.js";
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DentalAgent } from "../src/agent/agent.js";
import { ClinicRegistry } from "../src/clinic/registry.js";
import { ClinicSchema, type ClinicConfig } from "../src/clinic/schema.js";
import { openDatabase } from "../src/db/database.js";
import { Repo } from "../src/db/repo.js";
import { Dispatcher, type DispatcherSettings } from "../src/messaging/dispatcher.js";
import { MemoryTransport } from "../src/messaging/transport.js";
import { Notifier, type AdminEvent } from "../src/notify/notifier.js";
import { DateTime } from "../src/scheduling/time.js";
import { FieldCipher } from "../src/security/crypto.js";
import { Semaphore } from "../src/security/ratelimit.js";
import { DEFAULT_SPAM_SETTINGS, SpamGuard, type SpamSettings } from "../src/security/spam.js";

/** Небольшая клиника для тестов: часовой пояс Алматы (UTC+5), два врача. */
export function testClinic(overrides: Record<string, unknown> = {}): ClinicConfig {
  return ClinicSchema.parse({
    id: "test",
    name: "Тест Дент",
    timezone: "Asia/Almaty",
    currency: "₸",
    address: "ул. Тестовая, 1",
    working_hours_text: "Пн–Пт 9–18",
    holidays: ["2026-12-16"],
    booking: { slot_step_min: 30, min_notice_min: 60, horizon_days: 30, max_active_per_patient: 2, change_deadline_hours: 2 },
    whatsapp: { phone_number_id: "PN1" },
    // В большинстве тестов согласие не проверяем; отдельные тесты включают режим explicit.
    privacy: { consent_mode: "off" },
    services: [
      { id: "consult", category: "Консультации", name: "Консультация", price_from: 5000, price_fixed: true, duration_min: 30 },
      { id: "cleaning", category: "Гигиена", name: "Чистка", price_from: 25000, price_fixed: true, duration_min: 60 },
      { id: "implant", category: "Хирургия", name: "Имплантация", price_from: 250000, duration_min: 90, bookable: false },
    ],
    doctors: [
      {
        id: "ivanova",
        name: "Иванова Анна",
        specialty: "терапевт",
        services: ["consult", "cleaning"],
        schedule: { mon: [["09:00", "12:00"], ["13:00", "15:00"]], tue: [["09:00", "12:00"]] },
        days_off: ["2026-11-30"],
      },
      {
        id: "petrov",
        name: "Петров Олег",
        specialty: "гигиенист",
        services: ["cleaning"],
        schedule: { wed: [["10:00", "14:00"]] },
      },
    ],
    ...overrides,
  });
}

/** Понедельник 23.11.2026, 08:00 по Алматы (03:00 UTC). */
export const MONDAY_8AM = DateTime.fromISO("2026-11-23T08:00", { zone: "Asia/Almaty" });

export function memoryRepo(): Repo {
  return new Repo(openDatabase(":memory:"));
}

export class RecordingNotifier extends Notifier {
  readonly events: AdminEvent[] = [];
  override async notify(_clinic: ClinicConfig, event: AdminEvent): Promise<void> {
    this.events.push(event);
  }
}

type FakeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "thinking" };

/**
 * Фейковый клиент Claude: отдаёт заранее заданные ответы по очереди и запоминает запросы.
 * Позволяет проверить весь цикл (инструменты, история, отправка) без сети и ключа.
 */
export class FakeClaude {
  readonly requests: MessageCreateParamsNonStreaming[] = [];
  private queue: Array<{ blocks: FakeBlock[]; stop?: BetaMessage["stop_reason"] } | Error> = [];
  private counter = 0;

  reply(blocks: FakeBlock[], stop?: BetaMessage["stop_reason"]): this {
    this.queue.push({ blocks, stop });
    return this;
  }

  fail(error: Error): this {
    this.queue.push(error);
    return this;
  }

  get remaining(): number {
    return this.queue.length;
  }

  beta = {
    messages: {
      create: async (params: MessageCreateParamsNonStreaming): Promise<BetaMessage> => {
        // Копия: дальше массив сообщений мутирует (как и в реальном SDK, запрос уже «улетел»).
        this.requests.push(structuredClone(params));
        const next = this.queue.shift();
        if (!next) throw new Error("FakeClaude: нет заготовленного ответа");
        if (next instanceof Error) throw next;
        const content = next.blocks.map((b): BetaContentBlock => {
          if (b.type === "text") return { type: "text", text: b.text, citations: null } as BetaContentBlock;
          if (b.type === "thinking") return { type: "thinking", thinking: "", signature: "sig" } as BetaContentBlock;
          return { type: "tool_use", id: `toolu_${++this.counter}`, name: b.name, input: b.input } as BetaContentBlock;
        });
        const stop = next.stop ?? (next.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
        return {
          id: `msg_${++this.counter}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } as unknown as BetaMessage;
      },
    },
  };
}

export const TEST_CANARY_SECRET = "test-canary-secret";

export function setup(
  options: {
    now?: DateTime;
    clinic?: ClinicConfig;
    debounceMs?: number;
    spam?: Partial<SpamSettings>;
    settings?: Partial<DispatcherSettings>;
    cipherKey?: string;
    aiConcurrency?: number;
  } = {},
) {
  const clinic = options.clinic ?? testClinic();
  let now = options.now ?? MONDAY_8AM;
  const repo = new Repo(openDatabase(":memory:"), new FieldCipher(options.cipherKey));
  const registry = new ClinicRegistry([clinic]);
  const transport = new MemoryTransport();
  const notifier = new RecordingNotifier();
  const claude = new FakeClaude();
  const agent = new DentalAgent(claude, {
    model: "claude-opus-5-5",
    effort: "medium",
    maxTokens: 16000,
    fallbacks: "default",
    maxToolRounds: 5,
    canarySecret: TEST_CANARY_SECRET,
  });
  const dispatcher = new Dispatcher({
    repo,
    registry,
    agent,
    transport,
    notifier,
    settings: {
      debounceMs: options.debounceMs ?? 0,
      handoffHours: 12,
      historyMaxTurns: 20,
      historyDays: 14,
      canarySecret: TEST_CANARY_SECRET,
      ...options.settings,
    },
    now: () => now,
    spamGuard: new SpamGuard({ ...DEFAULT_SPAM_SETTINGS, ...options.spam }),
    aiLimiter: new Semaphore(options.aiConcurrency ?? 8),
  });
  return {
    clinic,
    repo,
    registry,
    transport,
    notifier,
    claude,
    agent,
    dispatcher,
    setNow: (value: DateTime) => {
      now = value;
    },
    now: () => now,
  };
}
