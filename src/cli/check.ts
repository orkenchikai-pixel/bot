/**
 * Проверка настроек без запуска бота:
 *   npm run check                 — на своём компьютере
 *   node dist/cli/check.js        — в Docker-контейнере (так её вызывает команда dental-bot)
 * Код выхода 1 — с такими настройками бот не запустится (ошибки перечислены в выводе).
 */
import "../scheduling/time.js";
import { checkSetup, formatCheckReport } from "../ops/check.js";

const report = await checkSetup(process.env, { production: process.env.NODE_ENV === "production" || process.argv.includes("--production") });
console.log(formatCheckReport(report));
process.exit(report.ok ? 0 : 1);
