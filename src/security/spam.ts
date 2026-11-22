import { createHash } from "node:crypto";
import { SlidingWindowCounter, Throttle } from "./ratelimit.js";
import { normalizeForCompare } from "./sanitize.js";

export interface SpamSettings {
  /** Сообщений с одного номера в минуту — сверх лимита сообщения не обрабатываются. */
  maxPerMinute: number;
  /** Сообщений в час — сверх лимита номер блокируется на autoBlockHours. */
  maxPerHour: number;
  /** Сообщений в сутки — сверх лимита номер блокируется. */
  maxPerDay: number;
  /** Сколько одинаковых сообщений подряд (за 10 минут) обрабатывать — остальные повторы игнорируются. */
  duplicateMax: number;
  /** Новых чатов в час на одну клинику — защита от атаки с множества номеров. */
  newChatsPerHourPerClinic: number;
  autoBlockHours: number;
}

export const DEFAULT_SPAM_SETTINGS: SpamSettings = {
  maxPerMinute: 12,
  maxPerHour: 60,
  maxPerDay: 300,
  duplicateMax: 3,
  newChatsPerHourPerClinic: 60,
  autoBlockHours: 24,
};

export type SpamDecision =
  | { action: "allow" }
  | { action: "drop"; reason: "minute_limit" | "duplicate" | "new_chats_limit"; warn: SpamWarning | null }
  | { action: "block"; reason: "hour_limit" | "day_limit"; hours: number };

export type SpamWarning = "slow_down" | "overload";

export const SPAM_WARNINGS: Record<SpamWarning, string> = {
  slow_down:
    "Вы отправляете сообщения слишком часто, и часть из них я не смогу обработать. Подождите минуту и напишите, пожалуйста, одним сообщением.",
  overload: "Сейчас очень много обращений. Пожалуйста, напишите чуть позже или позвоните в клинику.",
};

/**
 * Антиспам по номеру и по клинике. Счётчики живут в памяти процесса (после перезапуска
 * обнуляются), а блокировки сохраняются в базе — это делает Dispatcher.
 */
export class SpamGuard {
  private readonly minute = new SlidingWindowCounter(60_000);
  private readonly hour = new SlidingWindowCounter(3_600_000);
  private readonly day = new SlidingWindowCounter(86_400_000);
  private readonly duplicates = new SlidingWindowCounter(10 * 60_000);
  private readonly newChats = new SlidingWindowCounter(3_600_000);
  private readonly warnings = new Throttle(10 * 60_000);

  constructor(private readonly settings: SpamSettings = DEFAULT_SPAM_SETTINGS) {}

  check(input: { clinicId: string; phone: string; text: string; isNewChat: boolean; now?: number }): SpamDecision {
    const now = input.now ?? Date.now();
    const key = `${input.clinicId}:${input.phone}`;
    const warn = (kind: SpamWarning): SpamWarning | null => (this.warnings.allow(key, now) ? kind : null);

    if (input.isNewChat && this.newChats.hit(input.clinicId, now) > this.settings.newChatsPerHourPerClinic) {
      return { action: "drop", reason: "new_chats_limit", warn: warn("overload") };
    }

    const perDay = this.day.hit(key, now);
    const perHour = this.hour.hit(key, now);
    const perMinute = this.minute.hit(key, now);
    if (perDay > this.settings.maxPerDay) return { action: "block", reason: "day_limit", hours: this.settings.autoBlockHours };
    if (perHour > this.settings.maxPerHour) return { action: "block", reason: "hour_limit", hours: this.settings.autoBlockHours };
    if (perMinute > this.settings.maxPerMinute) return { action: "drop", reason: "minute_limit", warn: warn("slow_down") };

    const normalized = normalizeForCompare(input.text);
    if (normalized.length > 0) {
      const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
      if (this.duplicates.hit(`${key}:${digest}`, now) > this.settings.duplicateMax) {
        return { action: "drop", reason: "duplicate", warn: null };
      }
    }
    return { action: "allow" };
  }

  /** Сброс счётчиков номера (после ручной разблокировки администратором). */
  forget(clinicId: string, phone: string): void {
    const key = `${clinicId}:${phone}`;
    this.minute.reset(key);
    this.hour.reset(key);
    this.day.reset(key);
  }
}
