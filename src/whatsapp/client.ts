import type { ClinicConfig } from "../clinic/schema.js";
import type { ReplyButton, TemplateMessage, Transport } from "../messaging/transport.js";

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`WhatsApp API ${status}: ${describeWhatsAppError(body)}`);
    this.name = "WhatsAppApiError";
  }
}

/** Человекочитаемое описание частых ошибок Cloud API. */
function describeWhatsAppError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number; message?: string; error_data?: { details?: string } } };
    const code = parsed.error?.code;
    const hints: Record<number, string> = {
      131047: "прошло больше 24 часов с последнего сообщения пациента — можно писать только шаблоном",
      131026: "сообщение не доставлено (у номера нет WhatsApp или старая версия приложения)",
      190: "токен доступа недействителен или истёк",
      131056: "слишком много сообщений этому номеру за короткое время",
      132001: "шаблон не найден или не утверждён для этого языка",
    };
    const hint = code !== undefined ? hints[code] : undefined;
    return [code, parsed.error?.message, parsed.error?.error_data?.details, hint].filter(Boolean).join(" — ");
  } catch {
    return body.slice(0, 300);
  }
}

export interface WhatsAppClientOptions {
  apiVersion: string;
  /** Токен по умолчанию (WHATSAPP_ACCESS_TOKEN), если у клиники не задан свой. */
  defaultAccessToken?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Отправка сообщений через официальный WhatsApp Cloud API (graph.facebook.com). */
export class WhatsAppCloudClient implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: WhatsAppClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.env = opts.env ?? process.env;
  }

  private token(clinic: ClinicConfig): string {
    const envName = clinic.whatsapp.access_token_env;
    const token = envName ? this.env[envName] : this.opts.defaultAccessToken;
    if (!token) {
      throw new Error(
        envName
          ? `Не задан токен WhatsApp: переменная окружения ${envName} (клиника ${clinic.id})`
          : `Не задан WHATSAPP_ACCESS_TOKEN (клиника ${clinic.id})`,
      );
    }
    return token;
  }

  private url(path: string): string {
    return `https://graph.facebook.com/${this.opts.apiVersion}/${path}`;
  }

  private async post<T>(clinic: ClinicConfig, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.url(`${clinic.whatsapp.phone_number_id}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token(clinic)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new WhatsAppApiError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async sendText(clinic: ClinicConfig, to: string, text: string): Promise<{ messageId?: string }> {
    const res = await this.post<{ messages?: Array<{ id: string }> }>(clinic, {
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    });
    return { messageId: res.messages?.[0]?.id };
  }

  async markReadAndTyping(clinic: ClinicConfig, messageId: string): Promise<void> {
    await this.post(clinic, { status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  }

  async sendTemplate(clinic: ClinicConfig, to: string, template: TemplateMessage): Promise<{ messageId?: string }> {
    const res = await this.post<{ messages?: Array<{ id: string }> }>(clinic, {
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: [{ type: "body", parameters: template.bodyParams.map((text) => ({ type: "text", text })) }],
      },
    });
    return { messageId: res.messages?.[0]?.id };
  }

  async sendButtons(clinic: ClinicConfig, to: string, body: string, buttons: ReplyButton[]): Promise<{ messageId?: string }> {
    // Тело интерактивного сообщения — до 1024 символов; длинный текст отправляем отдельно.
    let bodyText = body;
    if (body.length > 1024) {
      await this.sendText(clinic, to, body);
      bodyText = "Выберите вариант:";
    }
    const res = await this.post<{ messages?: Array<{ id: string }> }>(clinic, {
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
        },
      },
    });
    return { messageId: res.messages?.[0]?.id };
  }

  /**
   * Скачивает вложение: сначала получаем временный URL по media id, затем сам файл (тоже с токеном).
   * Токен отправляем только на домены Meta — иначе подменённый URL мог бы увести его (SSRF).
   */
  async downloadMedia(clinic: ClinicConfig, mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(mediaId)) throw new Error("Некорректный media id");
    const headers = { Authorization: `Bearer ${this.token(clinic)}` };
    const metaRes = await this.fetchImpl(this.url(mediaId), { headers, signal: AbortSignal.timeout(15_000) });
    const metaText = await metaRes.text();
    if (!metaRes.ok) throw new WhatsAppApiError(metaRes.status, metaText);
    const meta = JSON.parse(metaText) as { url: string; mime_type: string; file_size?: number };
    if (!isMetaMediaUrl(meta.url)) throw new Error("URL вложения ведёт не на сервер Meta — скачивание отменено");
    if (meta.file_size !== undefined && meta.file_size > MAX_MEDIA_BYTES) throw new Error("Вложение слишком большое");
    const fileRes = await this.fetchImpl(meta.url, { headers, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!fileRes.ok) throw new WhatsAppApiError(fileRes.status, await fileRes.text());
    return { data: await readLimited(fileRes, MAX_MEDIA_BYTES), mimeType: meta.mime_type };
  }
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const META_MEDIA_HOSTS = ["fbsbx.com", "fbcdn.net", "whatsapp.net", "facebook.com"];

export function isMetaMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return META_MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Читает тело ответа, но не больше maxBytes (защита от исчерпания памяти). */
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("Вложение слишком большое");
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Вложение слишком большое");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
