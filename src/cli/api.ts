/**
 * Запрос к работающему боту изнутри его контейнера — так команда dental-bot перечитывает файлы
 * клиник, делает резервную копию и проверяет здоровье, не открывая админ-API наружу:
 *   node dist/cli/api.js GET /health
 *   node dist/cli/api.js POST /admin/clinics/reload
 *   node dist/cli/api.js POST /admin/backup
 * Токен берётся из ADMIN_TOKEN, адрес — http://127.0.0.1:$PORT. Код выхода 1 — ошибка.
 */
const [method = "GET", path = "/health"] = process.argv.slice(2);

if (!["GET", "POST"].includes(method) || !(path === "/health" || path.startsWith("/admin/"))) {
  console.error("Использование: node dist/cli/api.js GET|POST /health|/admin/…");
  process.exit(2);
}

const headers: Record<string, string> = {};
if (path.startsWith("/admin/")) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error("ADMIN_TOKEN не задан — админ-API выключен");
    process.exit(2);
  }
  headers.authorization = `Bearer ${token}`;
}

try {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? "3000"}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  console.log(await res.text());
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error(`Бот не отвечает: ${(err as Error).message}`);
  process.exit(1);
}
