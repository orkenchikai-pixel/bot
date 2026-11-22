import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Шифрование чувствительных полей в базе (AES-256-GCM): тексты переписки, имена, комментарии.
 * Если файл базы или бэкап утечёт, без ключа DATA_ENCRYPTION_KEY прочитать их нельзя.
 *
 * Формат: "enc:v1:" + base64(iv | tag | ciphertext). Строки без префикса считаются открытыми —
 * так старые записи читаются после включения шифрования. Версия в префиксе нужна для будущей смены ключа.
 */
export class FieldCipher {
  private readonly key: Buffer | null;

  constructor(secret?: string) {
    // scrypt превращает любую строку-секрет в 32-байтовый ключ; соль фиксирована, т.к. ключ один на установку.
    this.key = secret ? scryptSync(secret, "dental-crm-agent:field-cipher:v1", 32) : null;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  encrypt(value: string): string;
  encrypt(value: string | null | undefined): string | null;
  encrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!this.key) return value;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  decrypt(value: string): string;
  decrypt(value: string | null | undefined): string | null;
  decrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!value.startsWith(PREFIX)) return value;
    if (!this.key) throw new Error("В базе есть зашифрованные данные, но DATA_ENCRYPTION_KEY не задан");
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    // Если данные подменили или ключ не тот — GCM бросит исключение, а не вернёт мусор.
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}
