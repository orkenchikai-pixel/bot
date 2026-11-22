/** Лимит WhatsApp на длину текстового сообщения — 4096 символов; оставляем запас. */
export const WHATSAPP_MAX_TEXT = 4000;

/**
 * Приводит Markdown, который иногда проскакивает у модели, к разметке WhatsApp:
 * **жирный** → *жирный*, заголовки → жирная строка, [текст](url) → «текст: url», «- пункт» → «• пункт».
 */
export function toWhatsAppText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Делит длинный текст на части по абзацам/строкам, чтобы каждая влезла в одно сообщение WhatsApp. */
export function splitMessage(text: string, max = WHATSAPP_MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= max) {
      current = paragraph;
      continue;
    }
    for (const line of paragraph.split("\n")) {
      const withLine = current ? `${current}\n${line}` : line;
      if (withLine.length <= max) {
        current = withLine;
        continue;
      }
      flush();
      for (let i = 0; i < line.length; i += max) {
        const chunk = line.slice(i, i + max);
        if (chunk.length === max) parts.push(chunk);
        else current = chunk;
      }
    }
  }
  flush();
  return parts;
}
