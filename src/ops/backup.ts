import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "../db/database.js";
import { errorMessage, log } from "../log.js";

/** Копии и в новом формате имени (с миллисекундами), и в прежнем (до секунды). */
const BACKUP_FILE = /^backup-\d{8}-\d{6}(-\d{3})?\.db$/;

/** backup-20261122-164335-123.db — имена сортируются по времени создания. */
function backupName(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-22T16:43:35.123Z
  return `backup-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}.db`;
}

/**
 * Резервная копия базы средствами SQLite (VACUUM INTO): согласованный снимок без остановки сервера.
 * Зашифрованные поля остаются зашифрованными и в копии. Храните копии ещё и вне сервера.
 */
export function backupDatabase(db: Database, dir: string, keep: number): string {
  mkdirSync(dir, { recursive: true });
  // VACUUM INTO не перезаписывает файл: копии, сделанные почти одновременно (плановая и ручная,
  // или перед обновлением), получают разные имена.
  let when = Date.now();
  let file = path.resolve(dir, backupName(when));
  while (existsSync(file)) file = path.resolve(dir, backupName(++when));
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const backups = readdirSync(dir)
    .filter((f) => BACKUP_FILE.test(f))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(path.join(dir, old), { force: true });
  }
  log.info("Резервная копия базы создана", { file: path.basename(file), sizeKb: Math.round(statSync(file).size / 1024) });
  return file;
}

export function startBackupScheduler(db: Database, dir: string, keep: number, intervalHours: number): () => void {
  const tick = () => {
    try {
      backupDatabase(db, dir, keep);
    } catch (err) {
      log.error("Не удалось создать резервную копию базы", { error: errorMessage(err) });
    }
  };
  const timer = setInterval(tick, intervalHours * 3_600_000);
  return () => clearInterval(timer);
}
