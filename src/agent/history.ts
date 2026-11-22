import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Готовит сообщения завершённого хода к сохранению в истории.
 *
 * Почему убираем thinking-блоки. У Claude Opus 5.5 подпись thinking-блока привязана к
 * точному префиксу разговора (system, tools и все предыдущие сообщения). Мы между ходами
 * меняем префикс: подрезаем старую историю, обновляем прайс в системном промпте. Если бы
 * старые thinking-блоки оставались в истории, API отклонил бы запрос (400). Поэтому
 * внутри хода (цикл инструментов) блоки передаются как есть, а в историю сохраняются только
 * текст и вызовы инструментов — это разрешённое «удаление всех thinking-блоков».
 *
 * Что ещё делаем:
 *  - фото заменяем текстовой пометкой (не гоняем base64 в каждом следующем запросе);
 *  - убираем пустые сообщения ассистента и tool_use без результата (иначе API вернёт 400);
 *  - убираем служебные system-сообщения, после которых не идёт ответ ассистента
 *    (по правилам API такое сообщение должно быть последним или стоять перед ответом).
 */
export function sanitizeTurnForStorage(messages: BetaMessageParam[]): BetaMessageParam[] {
  const cleaned: BetaMessageParam[] = [];

  messages.forEach((msg, index) => {
    if (msg.role === "assistant") {
      const blocks = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content;
      const answered = toolResultIds(messages[index + 1]);
      const kept: Array<BetaTextBlockParam | BetaToolUseBlockParam> = [];
      for (const block of blocks) {
        if (block.type === "text" && block.text.trim() !== "") {
          kept.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use" && answered.has(block.id)) {
          kept.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      if (kept.length > 0) cleaned.push({ role: "assistant", content: kept });
      return;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        cleaned.push({ role: "user", content: msg.content });
        return;
      }
      const blocks: BetaContentBlockParam[] = msg.content.map((block): BetaContentBlockParam => {
        if (block.type === "image") return { type: "text", text: "[фото от пациента]" };
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_result") {
          const result: BetaToolResultBlockParam = { type: "tool_result", tool_use_id: block.tool_use_id };
          if (block.content !== undefined) result.content = block.content;
          if (block.is_error) result.is_error = true;
          return result;
        }
        return block;
      });
      cleaned.push({ role: "user", content: blocks });
      return;
    }

    cleaned.push(msg);
  });

  // tool_result без парного tool_use (если tool_use был выброшен) тоже недопустим.
  const withValidResults = cleaned.flatMap((msg, index): BetaMessageParam[] => {
    if (msg.role !== "user" || typeof msg.content === "string") return [msg];
    const prev = cleaned[index - 1];
    const allowed = prev?.role === "assistant" ? toolUseIds(prev) : new Set<string>();
    const content = msg.content.filter((b) => b.type !== "tool_result" || allowed.has(b.tool_use_id));
    return content.length > 0 ? [{ role: "user", content }] : [];
  });

  return withValidResults.filter((msg, index) => msg.role !== "system" || withValidResults[index + 1]?.role === "assistant");
}

function toolResultIds(msg: BetaMessageParam | undefined): Set<string> {
  const ids = new Set<string>();
  if (msg?.role === "user" && typeof msg.content !== "string") {
    for (const block of msg.content) if (block.type === "tool_result") ids.add(block.tool_use_id);
  }
  return ids;
}

function toolUseIds(msg: BetaMessageParam): Set<string> {
  const ids = new Set<string>();
  if (typeof msg.content !== "string" && msg.content) {
    for (const block of msg.content) if (block.type === "tool_use") ids.add(block.id);
  }
  return ids;
}

/** Склеивает сохранённые ходы в историю для запроса. Каждый ход начинается с сообщения пациента. */
export function buildHistory(turns: BetaMessageParam[][]): BetaMessageParam[] {
  const flat = turns.flat();
  const firstUser = flat.findIndex((m) => m.role === "user");
  return firstUser === -1 ? [] : flat.slice(firstUser);
}
