import type { Repo } from "../db/repo.js";
import { errorMessage, log } from "../log.js";
import { DateTime, toUtcIso } from "../scheduling/time.js";

export interface RetentionSettings {
  /** Переписка и история для ИИ хранятся столько дней. */
  messagesDays: number;
  /** Через столько дней после визита запись обезличивается (имя и номер удаляются, статистика остаётся). */
  appointmentsDays: number;
  /** Журнал действий администраторов хранится столько дней. */
  auditDays: number;
}

/** Удаляет данные, срок хранения которых истёк (принцип минимизации данных). */
export function runRetention(repo: Repo, settings: RetentionSettings, now: DateTime = DateTime.utc()) {
  const result = repo.purgeOldData({
    messagesBeforeUtc: toUtcIso(now.minus({ days: settings.messagesDays })),
    appointmentsBeforeUtc: toUtcIso(now.minus({ days: settings.appointmentsDays })),
    auditBeforeUtc: toUtcIso(now.minus({ days: settings.auditDays })),
    nowUtc: toUtcIso(now),
  });
  if (Object.values(result).some((n) => n > 0)) log.info("Автоочистка данных по срокам хранения", result);
  return result;
}

export function startRetentionScheduler(repo: Repo, settings: RetentionSettings): () => void {
  const tick = () => {
    try {
      runRetention(repo, settings);
    } catch (err) {
      log.error("Сбой автоочистки данных", { error: errorMessage(err) });
    }
  };
  tick();
  const timer = setInterval(tick, 6 * 3_600_000);
  return () => clearInterval(timer);
}
