import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "../db/database.js";
import { errorMessage, log } from "../log.js";

/**
 * Резервная копия базы средствами SQLite (VACUUM INTO): согласованный снимок без остановки сервера.
 * Зашифрованные поля остаются зашифрованными и в копии. Храните копии ещё и вне сервера.
 */
export function backupDatabase(db: Database, dir: string, keep: number): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.resolve(dir, `backup-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const backups = readdirSync(dir)
    .filter((f) => /^backup-\d{8}-\d{6}\.db$/.test(f))
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
