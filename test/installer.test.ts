import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseClinicJson } from "../src/clinic/registry.js";
import { checkSetup } from "../src/ops/check.js";

/*
 * Мастер установки и команда dental-bot проверяются по-настоящему: запускается сам bash-скрипт,
 * вместо Docker — заглушка, вместо API Claude, Meta и Telegram — локальный поддельный сервер.
 * Готовые настройки затем проверяются тем же кодом, которым их проверяет бот при запуске.
 */

const REPO = process.cwd();
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const TOOLS_OK = ["bash", "jq", "openssl", "curl", "git"].every(has);

const DOCKER_STUB = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose version v2.30.0" ;;
  *"ps -q --status running agent"*) if [ -n "\${STUB_RUNNING:-}" ]; then echo c0ffee; fi ;;
  *"dist/cli/check.js"*)
    for f in "$STUB_APP"/clinics.local/*.json; do
      jq empty "$f" 2>/dev/null || { echo "✗ $(basename "$f"): некорректный JSON"; exit 1; }
    done
    echo "Настройки в порядке." ;;
  *"api.js POST /admin/backup"*) echo '{"ok":true,"file":"backup-20261122-120000.db"}' ;;
  *"api.js"*) echo '{"ok":true}' ;;
esac
exit 0
`;
const LOG_STUB = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$STUB_LOG"
exit 0
`;

interface Sandbox {
  root: string;
  app: string;
  bin: string;
  binDir: string;
  calls: string;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function copyApp(target: string): void {
  mkdirSync(path.join(target, "scripts"), { recursive: true });
  mkdirSync(path.join(target, "clinics"), { recursive: true });
  for (const file of ["install.sh", "docker-compose.yml", ".env.example", "scripts/dental-bot.sh", "clinics/demo.json"]) {
    cpSync(path.join(REPO, file), path.join(target, file));
  }
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "dental-install-"));
  sandboxes.push(root);
  const app = path.join(root, "app");
  copyApp(app);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeExecutable(path.join(bin, "docker"), DOCKER_STUB);
  for (const cmd of ["apt-get", "systemctl", "ufw"]) writeExecutable(path.join(bin, cmd), LOG_STUB);
  return { root, app, bin, binDir: path.join(root, "usr-bin"), calls: path.join(root, "calls.log") };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

function run(sb: Sandbox, args: string[], env: Record<string, string>, script = path.join(sb.app, "scripts/dental-bot.sh")): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: sb.root,
      // Окружение собирается с нуля: ключи разработчика из его окружения в тест не попадут.
      env: {
        PATH: `${sb.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: sb.root,
        TMPDIR: sb.root,
        LANG: "C.UTF-8",
        NO_COLOR: "1",
        STUB_LOG: sb.calls,
        STUB_APP: sb.app,
        LOG_FILE: path.join(sb.root, "dental-bot.log"),
        BIN_DIR: sb.binDir,
        SKIP_ROOT_CHECK: "1",
        SKIP_OS_CHECK: "1",
        SKIP_DNS_CHECK: "1",
        SKIP_SWAP: "1",
        SKIP_PORT_CHECK: "1",
        SKIP_HTTPS_CHECK: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Скрипт завис:\n${output}`));
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output });
    });
  });
}

function readEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

const answers = (sb: Sandbox, lines: string[]) => {
  const file = path.join(sb.root, "answers.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};

const clinicFiles = (sb: Sandbox) => readdirSync(path.join(sb.app, "clinics.local")).filter((f) => f.endsWith(".json")).sort();
const readClinic = (sb: Sandbox, id: string) => parseClinicJson(readFileSync(path.join(sb.app, "clinics.local", `${id}.json`), "utf8"));
const calls = (sb: Sandbox) => (existsSync(sb.calls) ? readFileSync(sb.calls, "utf8") : "");
const templatePaths = [path.join(REPO, "clinics/demo.json")];

const KEY = `sk-ant-api03-${"a".repeat(40)}`;
const WA_TOKEN = `EAAB${"x".repeat(60)}`;
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const BASE: Record<string, string> = {
  NONINTERACTIVE: "1",
  SKIP_KEY_CHECKS: "1",
  DOMAIN: "https://Bot.Example.kz/",
  ANTHROPIC_API_KEY: KEY,
  WHATSAPP_PHONE_NUMBER_ID: "123456789012345",
  WHATSAPP_ACCESS_TOKEN: WA_TOKEN,
  WHATSAPP_APP_SECRET: APP_SECRET,
  CLINIC_NAME: "Стоматология «Улыбка»",
  CLINIC_ADDRESS: "г. Алматы, ул. Абая, 1",
  CLINIC_PHONE: "+7 701 234 56 78",
  CLINIC_HOURS: "Пн–Пт 9:00–20:00",
  CLINIC_OPERATOR: "ТОО «Улыбка»",
  CLINIC_POLICY_URL: "ulybka.kz/privacy",
};
const { WHATSAPP_PHONE_NUMBER_ID: _p, WHATSAPP_ACCESS_TOKEN: _t, WHATSAPP_APP_SECRET: _s, ...WITHOUT_WHATSAPP } = BASE;

async function installed(env: Record<string, string> = BASE): Promise<Sandbox> {
  const sb = makeSandbox();
  const result = await run(sb, ["install"], env);
  expect(result.code, result.output).toBe(0);
  return sb;
}

// ───────────────── поддельные API Claude, Meta и Telegram ─────────────────

const GOOD = {
  claude: `sk-ant-api03-good${"g".repeat(30)}`,
  wa: `EAAgood${"w".repeat(40)}`,
  secret: "fedcba9876543210fedcba9876543210",
  tg: `1234567890:${"T".repeat(35)}`,
};
interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let mock: { server: Server; url: string; requests: Recorded[] };

beforeAll(async () => {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://mock");
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/v1/messages") {
        const key = String(req.headers["x-api-key"] ?? "");
        if (key === GOOD.claude) return json(200, { id: "msg_1", type: "message", content: [], stop_reason: "max_tokens" });
        if (key.includes("nocredit")) {
          return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
        }
        return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      }
      if (url.pathname === "/v27.0/debug_token") return json(200, { data: { app_id: "111222333", expires_at: 0, is_valid: true } });
      if (url.pathname === "/v27.0/111222333") {
        return url.searchParams.get("access_token") === `111222333|${GOOD.secret}`
          ? json(200, { id: "111222333" })
          : json(400, { error: { message: "Invalid OAuth access token signature.", code: 190 } });
      }
      const phone = /^\/v27\.0\/(\d+)$/.exec(url.pathname);
      if (phone) {
        return req.headers.authorization === `Bearer ${GOOD.wa}`
          ? json(200, { display_phone_number: "+7 701 000 00 00", verified_name: "Улыбка", id: phone[1] })
          : json(401, { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
      }
      const tg = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      if (tg) {
        if (tg[1] !== GOOD.tg) return json(401, { ok: false, description: "Unauthorized" });
        if (tg[2] === "getMe") return json(200, { ok: true, result: { username: "ulybka_admin_bot" } });
        if (tg[2] === "getUpdates") {
          return json(200, { ok: true, result: [{ update_id: 1, message: { chat: { id: 555000111, first_name: "Айгуль", type: "private" }, text: "/start" } }] });
        }
        if (tg[2] === "sendMessage") return json(200, { ok: true, result: {} });
      }
      return json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  mock = { server, url: `http://127.0.0.1:${port}`, requests };
});
afterAll(() => new Promise<void>((resolve) => mock.server.close(() => resolve())));

// ───────────────────────────── тесты ─────────────────────────────

describe.skipIf(!TOOLS_OK)("мастер установки", () => {
  it("установка без вопросов: секреты, файл клиники, права доступа, итоговая инструкция", async () => {
    const sb = makeSandbox();
    const result = await run(sb, ["install"], BASE);
    expect(result.code, result.output).toBe(0);

    const envFile = path.join(sb.app, ".env");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const env = readEnv(envFile);
    expect(env).toMatchObject({
      DOMAIN: "bot.example.kz",
      ANTHROPIC_API_KEY: KEY,
      WHATSAPP_ACCESS_TOKEN: WA_TOKEN,
      WHATSAPP_APP_SECRET: APP_SECRET,
      CLINICS_HOST_DIR: "./clinics.local",
      SIMULATOR_ENABLED: "true",
      AGENT_MODEL: "claude-opus-5-5", // остальные настройки из .env.example сохранены
      SPAM_MAX_PER_MINUTE: "12",
    });
    expect(env.DATA_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.CANARY_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.WHATSAPP_VERIFY_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(env.SIMULATOR_KEY).toMatch(/^[0-9a-f]{48}$/);

    expect(clinicFiles(sb)).toEqual(["stomatologiya-ulybka.json"]);
    const clinic = readClinic(sb, "stomatologiya-ulybka");
    expect(clinic).toMatchObject({
      id: "stomatologiya-ulybka",
      name: "Стоматология «Улыбка»",
      timezone: "Asia/Almaty",
      currency: "₸",
      address: "г. Алматы, ул. Абая, 1",
      phone: "+7 701 234 56 78",
      working_hours_text: "Пн–Пт 9:00–20:00",
      whatsapp: { phone_number_id: "123456789012345" },
      privacy: { consent_mode: "explicit", operator_name: "ТОО «Улыбка»", policy_url: "https://ulybka.kz/privacy" },
    });
    expect(clinic.privacy.consent_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Выдуманные тексты демо-клиники убраны (поля оставлены пустыми — их видно в редакторе),
    // врачи и услуги оставлены, чтобы бота можно было сразу проверить в симуляторе.
    expect(clinic.faq).toEqual([]);
    expect(clinic.promotions).toEqual([]);
    expect(clinic.policies).toEqual([]);
    expect(clinic).toMatchObject({ about: "", payment_methods: "", website: "", instagram: "", map_url: "" });
    expect(clinic.doctors.length).toBeGreaterThan(0);
    expect(clinic.services.length).toBeGreaterThan(0);

    // Настройки проходят ту же проверку, что делает бот при запуске в production.
    const report = await checkSetup({ ...env, CLINICS_DIR: path.join(sb.app, "clinics.local") }, { production: true, templatePaths });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/демо-примера/);

    expect(calls(sb)).toMatch(/docker compose build[\s\S]*dist\/cli\/check\.js[\s\S]*docker compose up -d/);
    expect(readlinkSync(path.join(sb.binDir, "dental-bot"))).toBe(path.join(sb.app, "scripts/dental-bot.sh"));

    expect(result.output).toContain("https://bot.example.kz/webhook/whatsapp");
    expect(result.output).toContain(env.WHATSAPP_VERIFY_TOKEN!);
    expect(result.output).toContain(`https://bot.example.kz/simulator#key=${env.SIMULATOR_KEY}`);
    expect(result.output).toContain("dental-bot edit");
    // Ключи, которые ввёл пользователь, на экран не выводятся.
    for (const secret of [KEY, WA_TOKEN, APP_SECRET]) expect(result.output).not.toContain(secret);
  }, 60_000);

  it("повторный запуск: ключ шифрования и токены не меняются, правки прайса сохраняются", async () => {
    const sb = await installed();
    const before = readEnv(path.join(sb.app, ".env"));
    const file = path.join(sb.app, "clinics.local/stomatologiya-ulybka.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.services[0].price_from = 7777;
    writeFileSync(file, JSON.stringify(edited, null, 2));

    const again = await run(sb, ["install"], { NONINTERACTIVE: "1", SKIP_KEY_CHECKS: "1", CLINIC_HOURS: "Пн–Сб 9:00–21:00" });
    expect(again.code, again.output).toBe(0);
    const after = readEnv(path.join(sb.app, ".env"));
    for (const key of ["DATA_ENCRYPTION_KEY", "ADMIN_TOKEN", "WHATSAPP_VERIFY_TOKEN", "SIMULATOR_KEY", "CANARY_SECRET", "ANTHROPIC_API_KEY", "DOMAIN"]) {
      expect(after[key], key).toBe(before[key]);
    }
    expect(clinicFiles(sb)).toEqual(["stomatologiya-ulybka.json"]);
    const clinic = readClinic(sb, "stomatologiya-ulybka");
    expect(clinic.working_hours_text).toBe("Пн–Сб 9:00–21:00");
    expect(clinic.services[0]!.price_from).toBe(7777);
    expect(clinic.whatsapp.phone_number_id).toBe("123456789012345");
  }, 60_000);

  it("WhatsApp позже: бот работает в симуляторе, потом dental-bot whatsapp подключает номер", async () => {
    const sb = await installed(WITHOUT_WHATSAPP);
    const env = readEnv(path.join(sb.app, ".env"));
    expect(env.WHATSAPP_ACCESS_TOKEN ?? "").toBe("");
    expect(readClinic(sb, "stomatologiya-ulybka").whatsapp.phone_number_id).toBe("REPLACE_stomatologiya-ulybka");
    const report = await checkSetup({ ...env, CLINICS_DIR: path.join(sb.app, "clinics.local") }, { production: true, templatePaths });
    expect(report.ok).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/WhatsApp не подключён/);

    const connect = await run(sb, ["whatsapp"], {
      NONINTERACTIVE: "1",
      SKIP_KEY_CHECKS: "1",
      WHATSAPP_PHONE_NUMBER_ID: "123456789012345",
      WHATSAPP_ACCESS_TOKEN: WA_TOKEN,
      WHATSAPP_APP_SECRET: APP_SECRET,
    });
    expect(connect.code, connect.output).toBe(0);
    const connected = readEnv(path.join(sb.app, ".env"));
    expect(connected).toMatchObject({ WHATSAPP_ACCESS_TOKEN: WA_TOKEN, WHATSAPP_APP_SECRET: APP_SECRET });
    expect(connected.DATA_ENCRYPTION_KEY).toBe(env.DATA_ENCRYPTION_KEY);
    expect(readClinic(sb, "stomatologiya-ulybka").whatsapp.phone_number_id).toBe("123456789012345");
    expect(connect.output).toContain("https://bot.example.kz/webhook/whatsapp");
    expect(calls(sb)).toMatch(/up -d --force-recreate agent/);
  }, 60_000);

  it("вторая клиника: общий токен, а номер одной клиники нельзя подключить к другой", async () => {
    const sb = await installed();
    const second = {
      NONINTERACTIVE: "1",
      SKIP_KEY_CHECKS: "1",
      CLINIC_NAME: "Дента Плюс",
      CLINIC_ADDRESS: "г. Астана, пр. Мангилик Ел, 10",
      CLINIC_PHONE: "+7 702 000 00 00",
      CLINIC_HOURS: "Ежедневно 10:00–22:00",
      CLINIC_OPERATOR: "ИП Сейткали",
    };
    const added = await run(sb, ["add-clinic"], { ...second, WHATSAPP_PHONE_NUMBER_ID: "223456789012345" });
    expect(added.code, added.output).toBe(0);
    expect(clinicFiles(sb)).toEqual(["denta-plyus.json", "stomatologiya-ulybka.json"]);
    const clinic = readClinic(sb, "denta-plyus");
    expect(clinic.whatsapp).toEqual({ phone_number_id: "223456789012345" }); // общий WHATSAPP_ACCESS_TOKEN
    expect(added.output).toMatch(/dental-bot edit denta-plyus/);
    const env = readEnv(path.join(sb.app, ".env"));
    const report = await checkSetup({ ...env, CLINICS_DIR: path.join(sb.app, "clinics.local") }, { production: true, templatePaths });
    expect(report.ok, report.errors.join("\n")).toBe(true);
    expect(report.clinics).toHaveLength(2);

    const duplicate = await run(sb, ["add-clinic"], { ...second, CLINIC_NAME: "Третья", WHATSAPP_PHONE_NUMBER_ID: "123456789012345" });
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toMatch(/уже подключён к клинике «Стоматология «Улыбка»»/);
    expect(clinicFiles(sb)).toHaveLength(2);
  }, 90_000);

  it("неверный ответ без вопросов — понятная ошибка, ничего не устанавливается", async () => {
    const sb = makeSandbox();
    const badDomain = await run(sb, ["install"], { ...BASE, DOMAIN: "not a domain" });
    expect(badDomain.code).not.toBe(0);
    expect(badDomain.stderr).toMatch(/DOMAIN: Это не похоже на домен/);
    const noName = await run(sb, ["install"], { ...BASE, CLINIC_NAME: "" });
    expect(noName.code).not.toBe(0);
    expect(noName.stderr).toMatch(/CLINIC_NAME: Нужен ответ/);
    const badKey = await run(sb, ["install"], { ...BASE, ANTHROPIC_API_KEY: "my-key" });
    expect(badKey.stderr).toMatch(/ANTHROPIC_API_KEY: Ключ Claude начинается с sk-ant-/);
    expect(existsSync(path.join(sb.app, ".env"))).toBe(false);
    expect(calls(sb)).not.toMatch(/compose build/);
  }, 60_000);

  it("с вопросами: повторяет вопрос при ошибке, проверяет ключи через API и находит чат Telegram", async () => {
    const sb = makeSandbox();
    const tty = answers(sb, [
      "not a domain", // неверный домен — переспросит
      "bot.example.kz",
      "sk-ant-api03-nocredit-xxxxxxxxxxxxxxxxxxxxxxxx", // нет денег на балансе
      "sk-ant-api03-wrong-xxxxxxxxxxxxxxxxxxxxxxxxxxx", // неверный ключ
      GOOD.claude,
      "Улыбка",
      "", // часовой пояс по умолчанию — Казахстан
      "г. Алматы, ул. Абая, 1",
      "+7 701 234 56 78",
      "Пн–Пт 9:00–20:00",
      "ТОО «Улыбка»",
      "", // политики пока нет
      "1", // WhatsApp — сейчас
      "123456789012345",
      `EAAwrong${"z".repeat(30)}`, // токен, который Meta не принимает
      GOOD.wa,
      "00000000000000000000000000000000", // App Secret другого приложения
      GOOD.secret,
      "", // настроить Telegram — да
      GOOD.tg,
      "", // «нажали Start у бота»
      "д", // всё верно
    ]);
    const result = await run(sb, ["install"], {
      INSTALL_TTY: tty,
      ANTHROPIC_API_URL: mock.url,
      GRAPH_API_URL: mock.url,
      TELEGRAM_API_URL: mock.url,
    });
    expect(result.code, result.output).toBe(0);
    for (const text of [
      "Это не похоже на домен",
      "На балансе Claude нет средств",
      "Ключ не подошёл",
      "Ключ Claude работает",
      "Токен недействителен",
      "WhatsApp: номер +7 701 000 00 00 (Улыбка)",
      "App Secret не подходит",
      "Бот Telegram: @ulybka_admin_bot",
      "Тестовое сообщение отправлено",
      "Готово!",
    ]) {
      expect(result.output).toContain(text);
    }

    const env = readEnv(path.join(sb.app, ".env"));
    expect(env).toMatchObject({
      DOMAIN: "bot.example.kz",
      ANTHROPIC_API_KEY: GOOD.claude,
      WHATSAPP_ACCESS_TOKEN: GOOD.wa,
      WHATSAPP_APP_SECRET: GOOD.secret,
      TELEGRAM_BOT_TOKEN: GOOD.tg,
    });
    const clinic = readClinic(sb, "ulybka");
    expect(clinic.notifications.telegram_chat_ids).toEqual(["555000111"]);
    expect(clinic.privacy.policy_url).toBeUndefined();

    // Проверка ключа — один крошечный запрос к модели, по умолчанию claude-opus-5-5.
    const claude = mock.requests.find((r) => r.url === "/v1/messages" && r.headers["x-api-key"] === GOOD.claude)!;
    expect(JSON.parse(claude.body)).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16 });
    expect(claude.headers["anthropic-version"]).toBe("2023-06-01");
    const sent = mock.requests.find((r) => r.url.endsWith("/sendMessage"))!;
    expect(JSON.parse(sent.body)).toMatchObject({ chat_id: "555000111" });

    for (const secret of [GOOD.claude, GOOD.wa, GOOD.secret, GOOD.tg]) expect(result.output).not.toContain(secret);
  }, 60_000);
});

describe.skipIf(!TOOLS_OK)("команда dental-bot", () => {
  it("edit: ошибка в файле — возврат к прежней версии; правильная правка применяется без перезапуска", async () => {
    const sb = await installed();
    const file = path.join(sb.app, "clinics.local/stomatologiya-ulybka.json");
    const original = readFileSync(file, "utf8");

    const breaker = path.join(sb.bin, "break-editor");
    writeExecutable(breaker, "#!/usr/bin/env bash\nprintf '{ \"id\": ' > \"$1\"\n");
    const broken = await run(sb, ["edit"], { EDITOR: breaker, INSTALL_TTY: answers(sb, ["", "н"]) });
    expect(broken.code).toBe(1);
    expect(broken.output).toMatch(/некорректный JSON/);
    expect(broken.output).toMatch(/Вернул прежнюю версию файла/);
    expect(readFileSync(file, "utf8")).toBe(original);

    const fixer = path.join(sb.bin, "price-editor");
    writeExecutable(fixer, "#!/usr/bin/env bash\njq '.services[0].price_from = 9999' \"$1\" > \"$1.tmp\" && cat \"$1.tmp\" > \"$1\" && rm \"$1.tmp\"\n");
    const ok = await run(sb, ["edit"], { EDITOR: fixer, INSTALL_TTY: answers(sb, [""]) });
    expect(ok.code, ok.output).toBe(0);
    expect(ok.output).toContain("Изменения применены");
    expect(readClinic(sb, "stomatologiya-ulybka").services[0]!.price_from).toBe(9999);
    expect(calls(sb)).toMatch(/api\.js POST \/admin\/clinics\/reload/);
  }, 90_000);

  it("info, backup и help", async () => {
    const sb = await installed();
    const env = readEnv(path.join(sb.app, ".env"));
    const info = await run(sb, ["info"], {});
    expect(info.code, info.output).toBe(0);
    expect(info.output).toContain("https://bot.example.kz/webhook/whatsapp");
    expect(info.output).toContain(env.WHATSAPP_VERIFY_TOKEN!);
    expect(info.output).toContain(`#key=${env.SIMULATOR_KEY}`);
    expect(info.output).toMatch(/«Стоматология «Улыбка»» \(stomatologiya-ulybka\) — WhatsApp подключён/);
    expect(info.output).not.toContain(env.DATA_ENCRYPTION_KEY!);
    const secrets = await run(sb, ["info", "--secrets"], {});
    expect(secrets.output).toContain(env.DATA_ENCRYPTION_KEY!);

    const backup = await run(sb, ["backup"], {});
    expect(backup.code, backup.output).toBe(0);
    expect(backup.output).toContain(path.join(sb.app, "data/backups/backup-20261122-120000.db"));

    const help = await run(sb, ["help"], {});
    expect(help.code).toBe(0);
    for (const cmd of ["status", "logs", "edit", "update", "whatsapp", "telegram", "add-clinic", "backup"]) expect(help.output).toContain(`dental-bot ${cmd}`);
    const unknown = await run(sb, ["fly"], {});
    expect(unknown.code).toBe(2);
  }, 90_000);

  it("повторный запуск после прерванной установки предлагает её продолжить", async () => {
    const sb = await installed();
    const before = readEnv(path.join(sb.app, ".env"));
    writeFileSync(sb.calls, "");
    const resumed = await run(sb, ["install"], { INSTALL_TTY: answers(sb, ["1"]) });
    expect(resumed.code, resumed.output).toBe(0);
    expect(resumed.output).toContain("возможно, установка прервалась");
    expect(resumed.output).toContain("Готово!");
    expect(resumed.output).toContain("https://bot.example.kz/webhook/whatsapp");
    expect(calls(sb)).toMatch(/compose build[\s\S]*check\.js[\s\S]*compose up -d/);
    expect(readEnv(path.join(sb.app, ".env")).DATA_ENCRYPTION_KEY).toBe(before.DATA_ENCRYPTION_KEY);

    const menu = await run(sb, ["install"], { STUB_RUNNING: "1", INSTALL_TTY: answers(sb, ["6"]) });
    expect(menu.code, menu.output).toBe(0);
    expect(menu.output).toContain("Бот уже установлен");
    expect(menu.output).toContain(`Verify token:  ${before.WHATSAPP_VERIFY_TOKEN}`);
  }, 90_000);

  it("без установки команды подсказывают, как установить", async () => {
    const sb = makeSandbox();
    const status = await run(sb, ["status"], {});
    expect(status.code).not.toBe(0);
    expect(status.stderr).toMatch(/Бот ещё не установлен[\s\S]*install\.sh/);
  });
});

describe.skipIf(!TOOLS_OK)("install.sh", () => {
  it("скачивает код, запускает мастер; при повторном запуске обновляет код и сохраняет настройки", async () => {
    const sb = makeSandbox();
    const origin = path.join(sb.root, "origin");
    copyApp(origin);
    const git = (...args: string[]) => {
      const res = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd: origin, encoding: "utf8" });
      expect(res.status, res.stderr).toBe(0);
    };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const dir = path.join(sb.root, "opt", "dental-bot");
    const env = { ...BASE, REPO_URL: `file://${origin}`, INSTALL_DIR: dir, STUB_APP: dir };

    const first = await run(sb, [], env, path.join(origin, "install.sh"));
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("Код скачан");
    expect(first.output).toContain("Готово!");
    const before = readEnv(path.join(dir, ".env"));
    expect(existsSync(path.join(dir, "clinics.local/stomatologiya-ulybka.json"))).toBe(true);

    writeFileSync(path.join(origin, "CHANGELOG.md"), "новая версия\n");
    git("add", "-A");
    git("commit", "-q", "-m", "update");
    const second = await run(sb, [], { NONINTERACTIVE: "1", SKIP_KEY_CHECKS: "1", REPO_URL: `file://${origin}`, INSTALL_DIR: dir, STUB_APP: dir }, path.join(origin, "install.sh"));
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain("Код обновлён");
    expect(existsSync(path.join(dir, "CHANGELOG.md"))).toBe(true);
    expect(readEnv(path.join(dir, ".env")).DATA_ENCRYPTION_KEY).toBe(before.DATA_ENCRYPTION_KEY);

    const foreign = path.join(sb.root, "foreign");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "notes.txt"), "чужие файлы");
    const refused = await run(sb, [], { ...env, INSTALL_DIR: foreign }, path.join(origin, "install.sh"));
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/уже существует и не пуста/);
    expect(readFileSync(path.join(foreign, "notes.txt"), "utf8")).toBe("чужие файлы");
  }, 90_000);

  it.skipIf(!has("shellcheck"))("скрипты проходят shellcheck", () => {
    const res = spawnSync("shellcheck", ["install.sh", "scripts/dental-bot.sh"], { cwd: REPO, encoding: "utf8" });
    expect(res.stdout + res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});
