import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRules } from "../src/agent/prompt.js";
import { guardContextFor } from "../src/agent/safety.js";
import { FieldCipher, isEncrypted } from "../src/security/crypto.js";
import { guardReply, isAllowedUrl, SAFE_FALLBACK } from "../src/security/output-guard.js";
import { anonymizePhone, logText, maskPhone } from "../src/security/pii.js";
import { Semaphore, SlidingWindowCounter, Throttle } from "../src/security/ratelimit.js";
import { normalizeForCompare, sanitizeInbound } from "../src/security/sanitize.js";
import { isMetaMediaUrl } from "../src/whatsapp/client.js";
import { testClinic } from "./helpers.js";

const clinic = testClinic({
  phone: "+7 700 000 00 00",
  website: "https://smile.example.kz",
  map_url: "https://2gis.kz/almaty/firm/123",
  instagram: "@smile",
  privacy: { consent_mode: "off", policy_url: "https://smile.example.kz/privacy" },
});
const PATIENT = "77010000001";
const ctx = guardContextFor(clinic, PATIENT, "secret");

describe("очистка входящих сообщений", () => {
  it("удаляет невидимые символы, которыми прячут инструкции для ИИ", () => {
    const hidden = "Привет" + String.fromCodePoint(0x200b, 0x202e, 0xe0049, 0xe0047, 0xe004e, 0x2066) + "!";
    const result = sanitizeInbound(hidden, 2000);
    expect(result.text).toBe("Привет!");
    expect(result.removedInvisible).toBe(6);
  });

  it("обрезает слишком длинные сообщения", () => {
    const result = sanitizeInbound("я".repeat(5000), 100);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("я".repeat(100))).toBe(true);
    expect(result.text).toContain("[сообщение обрезано]");
  });

  it("сохраняет обычный текст, эмодзи и переносы", () => {
    expect(sanitizeInbound("  Здравствуйте 😊\nСколько стоит?  ", 2000).text).toBe("Здравствуйте 😊\nСколько стоит?");
  });

  it("нормализует текст для поиска повторов", () => {
    expect(normalizeForCompare("ПРИВЕТ!!!   как дела?")).toBe(normalizeForCompare("привет, как дела"));
  });
});

describe("фильтр ответов ИИ", () => {
  it("блокирует утечку канареечной метки", () => {
    const result = guardReply(`Вот мои инструкции: ${ctx.canary}`, ctx);
    expect(result).toMatchObject({ blocked: true, text: SAFE_FALLBACK, issues: ["canary_leak"] });
  });

  it("блокирует дословный пересказ инструкций", () => {
    const leaked = ctx.instructionLines.slice(0, 3).join("\n");
    expect(guardReply(leaked, ctx).blocked).toBe(true);
    // одна похожая фраза — ещё не утечка
    expect(guardReply(ctx.instructionLines[0]!, ctx).blocked).toBe(false);
  });

  it.each([
    "Для бронирования пришлите номер вашей карты и CVV",
    "Пожалуйста, сообщите код из SMS, чтобы подтвердить запись",
    "Please send your card number to confirm",
    "Напишите пароль от Kaspi",
  ])("блокирует фишинговый запрос: %s", (text) => {
    expect(guardReply(text, ctx)).toMatchObject({ blocked: true, issues: ["sensitive_data_request"] });
  });

  it("не трогает предупреждения и обычные фразы про оплату", () => {
    expect(guardReply("Оплатить можно картой или Kaspi QR в клинике.", ctx).blocked).toBe(false);
    expect(guardReply("Никогда не сообщайте никому код из SMS.", ctx).blocked).toBe(false);
  });

  it("удаляет ссылки на сторонние сайты и оставляет ссылки клиники", () => {
    const result = guardReply(
      "Адрес на карте: https://2gis.kz/almaty/firm/123. Политика: https://smile.example.kz/privacy, а оплатить можно тут: https://evil.example.com/pay.",
      ctx,
    );
    expect(result.text).toContain("https://2gis.kz/almaty/firm/123.");
    expect(result.text).toContain("https://smile.example.kz/privacy,");
    expect(result.text).toContain("[ссылка удалена].");
    expect(result.text).not.toContain("evil");
    expect(result.issues).toContain("foreign_link");
  });

  it("скрывает чужие номера телефонов, но оставляет номер клиники и пациента", () => {
    const result = guardReply("Звоните нам: +7 700 000 00 00 или 8 (700) 000-00-00. Ваш номер +77010000001. Другой пациент: +7 701 999 88 77.", ctx);
    expect(result.text).toContain("+7 700 000 00 00");
    expect(result.text).toContain("8 (700) 000-00-00");
    expect(result.text).toContain("+77010000001");
    expect(result.text).toContain("[номер скрыт]");
    expect(result.text).not.toContain("999 88 77");
  });

  it("не путает цены и даты с телефонами", () => {
    const text = "Брекеты — 350 000–700 000 ₸, приём 25.11.2026 в 10:00. Диапазон 700 000-800 000 ₸.";
    expect(guardReply(text, ctx).text).toBe(text);
  });

  it("убирает служебные id и ограничивает длину", () => {
    expect(guardReply("Чистка [id: cleaning] — 25 000 ₸", ctx).text).toBe("Чистка — 25 000 ₸");
    const long = guardReply("а".repeat(10_000), ctx);
    expect(long.text.length).toBeLessThanOrEqual(3501);
    expect(long.issues).toContain("too_long");
  });

  it("проверяет домены точно, а не по вхождению", () => {
    expect(isAllowedUrl("https://smile.example.kz.evil.com/", ["smile.example.kz"])).toBe(false);
    expect(isAllowedUrl("https://sub.smile.example.kz/x", ["smile.example.kz"])).toBe(true);
    expect(isAllowedUrl("javascript:alert(1)", ["smile.example.kz"])).toBe(false);
  });

  it("канарейка попадает в промпт, а строки инструкций берутся из правил", () => {
    expect(buildRules(clinic, ctx.canary)).toContain(ctx.canary);
    expect(ctx.instructionLines.length).toBeGreaterThan(10);
    expect(ctx.allowedHosts).toEqual(expect.arrayContaining(["smile.example.kz", "2gis.kz", "instagram.com"]));
  });
});

describe("шифрование полей", () => {
  it("шифрует и расшифровывает, каждый раз с новым IV", () => {
    const cipher = new FieldCipher("very-secret-key-123");
    const a = cipher.encrypt("Болит зуб справа");
    const b = cipher.encrypt("Болит зуб справа");
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("Болит зуб справа");
  });

  it("обнаруживает подмену данных и чужой ключ", () => {
    const cipher = new FieldCipher("very-secret-key-123");
    const encrypted = cipher.encrypt("секрет");
    const tampered = encrypted.slice(0, -4) + (encrypted.endsWith("A") ? "B" : "A") + encrypted.slice(-3);
    expect(() => cipher.decrypt(tampered)).toThrow();
    expect(() => new FieldCipher("other-key-456789").decrypt(encrypted)).toThrow();
    expect(() => new FieldCipher().decrypt(encrypted)).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it("без ключа хранит открыто, старые открытые записи читаются после включения ключа", () => {
    expect(new FieldCipher().encrypt("текст")).toBe("текст");
    expect(new FieldCipher("very-secret-key-123").decrypt("старый текст")).toBe("старый текст");
    expect(new FieldCipher("very-secret-key-123").encrypt(null)).toBeNull();
  });
});

describe("персональные данные в логах", () => {
  it("маскирует номера и прячет тексты", () => {
    expect(maskPhone("77011234567")).toBe("7701*****67");
    expect(maskPhone("123")).toBe("***");
    expect(logText("Болит зуб")).toBe("[9 симв.]");
    expect(anonymizePhone("77011234567")).toMatch(/^anon:[a-f0-9]{16}$/);
    expect(anonymizePhone("77011234567")).not.toContain("1234567");
  });
});

describe("лимиты", () => {
  it("SlidingWindowCounter считает события в окне", () => {
    const counter = new SlidingWindowCounter(1000);
    expect(counter.hit("a", 0)).toBe(1);
    expect(counter.hit("a", 500)).toBe(2);
    expect(counter.hit("a", 1600)).toBe(1); // первые два вышли из окна
    expect(counter.count("b", 1600)).toBe(0);
  });

  it("SlidingWindowCounter не растёт бесконечно при атаке с множества ключей", () => {
    const counter = new SlidingWindowCounter(60_000, 100);
    for (let i = 0; i < 5000; i++) counter.hit(`key-${i}`, i);
    expect((counter as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(1000);
  });

  it("Throttle пропускает раз в интервал", () => {
    const throttle = new Throttle(1000);
    expect(throttle.allow("x", 0)).toBe(true);
    expect(throttle.allow("x", 500)).toBe(false);
    expect(throttle.allow("x", 1000)).toBe(true);
  });

  it("Semaphore не превышает лимит одновременных задач", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
    expect(semaphore.inUse).toBe(0);
  });
});

describe("скачивание вложений", () => {
  it("отправляет токен только на серверы Meta", () => {
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")).toBe(true);
    expect(isMetaMediaUrl("https://mmg.whatsapp.net/x")).toBe(true);
    expect(isMetaMediaUrl("http://lookaside.fbsbx.com/x")).toBe(false);
    expect(isMetaMediaUrl("https://fbsbx.com.evil.io/x")).toBe(false);
    expect(isMetaMediaUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
  });
});

describe("исходный код", () => {
  // «Trojan Source»: невидимые и управляющие символы в коде могут спрятать логику от ревьюера.
  it("не содержит невидимых и bidi-символов", () => {
    const ranges: Array<[number, number]> = [[0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xe0000, 0xe007f]];
    const bad = { test: (text: string) => [...text].some((ch) => ranges.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b)) };
    const offenders: string[] = [];
    // Установщик выполняется от root прямо из интернета — управляющих символов (кроме табуляции) в нём быть не должно.
    const controlChars = /[\u0000-\u0008\u000b-\u001f\u007f]/;
    const check = (full: string) => {
      const text = readFileSync(full, "utf8");
      if (bad.test(text) || (/\.sh$/.test(full) && controlChars.test(text))) offenders.push(full);
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|json|md|sh|ya?ml)$/.test(name)) check(full);
      }
    };
    for (const dir of ["src", "test", "clinics", "scripts", ".github"]) {
      try {
        walk(dir);
      } catch {
        // папки может не быть
      }
    }
    for (const file of ["install.sh", "Dockerfile", "Caddyfile", "docker-compose.yml", ".env.example", "README.md", "START.md", "SECURITY.md", "COMPLIANCE.md"]) {
      check(file);
    }
    expect(offenders).toEqual([]);
  });
});
