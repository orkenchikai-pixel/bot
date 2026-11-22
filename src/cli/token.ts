/**
 * Генератор секретов.
 *   npm run token            — токен для ADMIN_TOKEN / администратора клиники
 * Токен покажите один раз и сохраните в менеджере паролей; в файл клиники кладётся только его SHA-256.
 */
import { createHash, randomBytes } from "node:crypto";

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");

console.log("Новый токен (сохраните в менеджере паролей, повторно не показывается):");
console.log(`  ${token}`);
console.log("");
console.log("Для суперадмина впишите его в .env:  ADMIN_TOKEN=<токен>");
console.log("Для администратора клиники впишите в clinics/<клиника>.json:");
console.log(`  "admin": { "token_sha256": "${hash}" }`);
console.log("");
console.log("Ключ шифрования базы (DATA_ENCRYPTION_KEY), если ещё не задан:");
console.log(`  ${randomBytes(32).toString("base64")}`);
