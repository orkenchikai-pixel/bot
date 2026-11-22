import type { ClinicConfig } from "../clinic/schema.js";

export interface TemplateMessage {
  name: string;
  language: string;
  /** Значения параметров {{1}}, {{2}}, … в тексте шаблона. */
  bodyParams: string[];
}

/** Канал отправки сообщений. Реализации: WhatsApp Cloud API, консоль (CLI), память (тесты и веб-симулятор). */
export interface Transport {
  sendText(clinic: ClinicConfig, to: string, text: string): Promise<{ messageId?: string }>;
  /** Отметить входящее прочитанным и показать «печатает…». */
  markReadAndTyping?(clinic: ClinicConfig, messageId: string): Promise<void>;
  sendTemplate?(clinic: ClinicConfig, to: string, template: TemplateMessage): Promise<{ messageId?: string }>;
  /** Сообщение с кнопками быстрого ответа (до 3 кнопок). */
  sendButtons?(clinic: ClinicConfig, to: string, body: string, buttons: ReplyButton[]): Promise<{ messageId?: string }>;
  downloadMedia?(clinic: ClinicConfig, mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export interface ReplyButton {
  id: string;
  /** До 20 символов (ограничение WhatsApp). */
  title: string;
}

/** Складывает исходящие сообщения в память — для тестов и веб-симулятора. */
export class MemoryTransport implements Transport {
  readonly sent: Array<{ clinicId: string; to: string; text: string; at: Date; buttons?: ReplyButton[] }> = [];

  async sendText(clinic: ClinicConfig, to: string, text: string): Promise<{ messageId?: string }> {
    this.sent.push({ clinicId: clinic.id, to, text, at: new Date() });
    return {};
  }

  async sendTemplate(clinic: ClinicConfig, to: string, template: TemplateMessage): Promise<{ messageId?: string }> {
    this.sent.push({ clinicId: clinic.id, to, text: `[шаблон ${template.name}] ${template.bodyParams.join(" | ")}`, at: new Date() });
    return {};
  }

  async sendButtons(clinic: ClinicConfig, to: string, body: string, buttons: ReplyButton[]): Promise<{ messageId?: string }> {
    this.sent.push({ clinicId: clinic.id, to, text: body, buttons, at: new Date() });
    return {};
  }

  messagesTo(to: string): string[] {
    return this.sent.filter((m) => m.to === to).map((m) => m.text);
  }
}
