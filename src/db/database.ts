import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * Встроенный в Node 22+ SQLite (node:sqlite) не требует нативной сборки.
 * Он пока помечен experimental и печатает предупреждение при загрузке — гасим только его.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const MIGRATIONS: string[] = [
  // 1 — начальная схема
  `
  CREATE TABLE patients (
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    name TEXT,
    wa_profile_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (clinic_id, phone)
  );

  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    start_utc TEXT NOT NULL,
    end_utc TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('booked', 'confirmed', 'cancelled', 'completed', 'no_show')),
    comment TEXT,
    source TEXT NOT NULL DEFAULT 'whatsapp',
    cancel_reason TEXT,
    reminder_status TEXT,
    reminder_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_appointments_doctor ON appointments (clinic_id, doctor_id, start_utc);
  CREATE INDEX idx_appointments_patient ON appointments (clinic_id, patient_phone, start_utc);
  CREATE INDEX idx_appointments_start ON appointments (start_utc);

  CREATE TABLE conversations (
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human')),
    human_until TEXT,
    handoff_reason TEXT,
    last_inbound_at TEXT,
    last_bot_log_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (clinic_id, phone)
  );

  -- История для Claude: один ход = JSON-массив сообщений (без thinking-блоков).
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_turns_conversation ON turns (clinic_id, phone, id);

  -- Человекочитаемая переписка (для администратора) + идемпотентность входящих.
  CREATE TABLE message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    author TEXT NOT NULL CHECK (author IN ('patient', 'bot', 'admin', 'reminder')),
    text TEXT NOT NULL,
    wa_message_id TEXT UNIQUE,
    processed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_message_log_conversation ON message_log (clinic_id, phone, id);
  `,

  // 2 — согласие, блок-лист, журнал аудита, учёт расходов, запросы пациентов о данных
  `
  ALTER TABLE patients ADD COLUMN consent_status TEXT;
  ALTER TABLE patients ADD COLUMN consent_version TEXT;
  ALTER TABLE patients ADD COLUMN consent_method TEXT;
  ALTER TABLE patients ADD COLUMN consent_at TEXT;
  ALTER TABLE patients ADD COLUMN consent_prompted_at TEXT;
  ALTER TABLE patients ADD COLUMN reminders_opt_out INTEGER NOT NULL DEFAULT 0;

  -- Неизменяемая история решений пациента о согласии (доказательство для проверок).
  CREATE TABLE consent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('requested', 'granted', 'refused', 'withdrawn', 'notice_shown')),
    version TEXT,
    method TEXT,
    wa_message_id TEXT,
    text TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_consent_log ON consent_log (clinic_id, phone, id);

  CREATE TABLE blocked_numbers (
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    until TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (clinic_id, phone)
  );

  -- Кто из администраторов что делал с данными пациентов.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    clinic_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    ip TEXT
  );
  CREATE INDEX idx_audit_log ON audit_log (clinic_id, id);

  CREATE TABLE usage_daily (
    clinic_id TEXT NOT NULL,
    day TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (clinic_id, day)
  );

  CREATE TABLE privacy_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX idx_privacy_requests ON privacy_requests (clinic_id, status);

  CREATE TABLE booking_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clinic_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_booking_events ON booking_events (clinic_id, phone, created_at);

  CREATE INDEX idx_message_log_created ON message_log (created_at);
  CREATE INDEX idx_turns_created ON turns (created_at);
  `,
];

function migrate(db: Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDatabase(file: string): Database {
  const { DatabaseSync } = loadSqlite();
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}
