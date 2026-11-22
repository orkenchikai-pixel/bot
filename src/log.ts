type Level = "info" | "warn" | "error";

const LEVELS: Record<string, number> = { info: 10, warn: 20, error: 30, silent: 100 };

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  // Уровень читаем при каждом вызове, чтобы CLI мог поменять его на лету (LOG_LEVEL=warn).
  const threshold = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? LEVELS.info!;
  if (LEVELS[level]! < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const extra = meta && Object.keys(meta).length > 0 ? ` ${safeJson(meta)}` : "";
  if (level === "error") console.error(line + extra);
  else if (level === "warn") console.warn(line + extra);
  else console.log(line + extra);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
