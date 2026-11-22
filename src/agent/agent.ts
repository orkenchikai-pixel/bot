import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ClinicConfig } from "../clinic/schema.js";
import { estimateCostUsd } from "../billing/usage.js";
import { errorMessage, log } from "../log.js";
import { buildSystemPrompt } from "./prompt.js";
import { clinicCanary } from "./safety.js";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentOptions {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** "default" — серверные fallbacks на случай отказа модели (refusal). */
  fallbacks: "default" | "off";
  /** Сколько раз за один ход Claude может вызвать инструменты. */
  maxToolRounds: number;
  /** Секрет для канареечной метки в промпте (утечка промпта распознаётся по ней). */
  canarySecret?: string;
}

/** Минимальный интерфейс клиента — в тестах подставляется фейк. */
export interface ClaudeClient {
  beta: { messages: { create(params: MessageCreateParamsNonStreaming): Promise<BetaMessage> } };
}

export interface RunTurnInput {
  clinic: ClinicConfig;
  /** Сообщения прошлых ходов (без thinking-блоков). */
  history: BetaMessageParam[];
  /** Новые сообщения пациента (текст и/или фото). */
  userContent: string | BetaContentBlockParam[];
  /** Служебный контекст хода: время, данные пациента, его записи. */
  contextNote: string;
  tools: ToolContext;
  /** Текст, который Claude написал перед вызовом инструментов («Минутку, проверю…»). */
  onInterimText?: (text: string) => Promise<void>;
  /** Непрозрачный id пациента для metadata.user_id (помогает Anthropic бороться со злоупотреблениями). */
  userKey?: string;
}

export type TurnStopReason = "end_turn" | "max_tokens" | "refusal" | "max_rounds" | "error";

export interface RunTurnResult {
  /** Финальные тексты ответа пациенту. */
  replies: string[];
  /** Все сообщения хода (для сохранения через sanitizeTurnForStorage). */
  messages: BetaMessageParam[];
  stopReason: TurnStopReason;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number; costUsd: number };
}

/** Модели, которые поддерживают серверные fallbacks при отказе (refusal). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);
/** Модели без поддержки role:"system" внутри messages — им контекст кладём в сообщение пациента. */
const NO_MID_CONVERSATION_SYSTEM = /^(claude-sonnet-5$|claude-sonnet-4|claude-haiku-4|claude-opus-4-[0-7]|claude-3)/;

export class DentalAgent {
  private readonly useFallbacks: boolean;
  private readonly systemMessages: boolean;

  constructor(
    private readonly client: ClaudeClient | Anthropic,
    private readonly opts: AgentOptions,
  ) {
    this.useFallbacks = opts.fallbacks === "default" && FALLBACK_MODELS.has(opts.model);
    this.systemMessages = !NO_MID_CONVERSATION_SYSTEM.test(opts.model);
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    // Системный промпт строим один раз на ход: внутри хода префикс запроса не должен меняться.
    const canary = this.opts.canarySecret ? clinicCanary(input.clinic, this.opts.canarySecret) : "";
    const system: BetaTextBlockParam[] = [
      { type: "text", text: buildSystemPrompt(input.clinic, canary), cache_control: { type: "ephemeral" } },
    ];
    const turn = this.initialMessages(input.userContent, input.contextNote);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0 };

    for (let round = 0; round < this.opts.maxToolRounds; round++) {
      let response: BetaMessage;
      try {
        response = await this.client.beta.messages.create(this.params(system, [...input.history, ...turn], input.userKey));
      } catch (err) {
        log.error("Ошибка запроса к Claude", { clinic: input.clinic.id, error: errorMessage(err) });
        return { replies: [], messages: turn, stopReason: "error", error: errorMessage(err), usage };
      }

      const step = {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      };
      usage.requests += 1;
      usage.input += step.input;
      usage.output += step.output;
      usage.cacheRead += step.cacheRead;
      usage.cacheWrite += step.cacheWrite;
      // response.model — модель, которая реально ответила (при fallback может отличаться от запрошенной).
      usage.costUsd += estimateCostUsd(response.model || this.opts.model, step);

      // Отказ всей цепочки моделей (с учётом fallbacks). Содержимое не используем.
      if (response.stop_reason === "refusal") {
        log.warn("Claude отказался отвечать", { clinic: input.clinic.id, details: response.stop_details ?? null });
        return { replies: [], messages: turn, stopReason: "refusal", usage };
      }

      // Возвращаем ответ в историю целиком (вместе с thinking и fallback-блоками) — это требование API.
      turn.push({ role: "assistant", content: response.content });
      const texts = response.content.flatMap((b) => (b.type === "text" && b.text.trim() !== "" ? [b.text.trim()] : []));

      const hasToolCalls = response.content.some((b) => b.type === "tool_use");
      if (response.stop_reason === "tool_use" && hasToolCalls) {
        if (input.onInterimText) for (const text of texts) await input.onInterimText(text);
        const results: BetaToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const outcome = await executeTool(block.name, block.input, input.tools);
          // Аргументы и результаты содержат имена и даты — пишем их в лог только в режиме отладки.
          log.info(`🔧 ${block.name}`, {
            clinic: input.clinic.id,
            error: outcome.isError ?? false,
            ...(process.env.LOG_MESSAGE_TEXT === "true" ? { input: block.input, result: outcome.content.slice(0, 500) } : {}),
          });
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }
        // Все результаты параллельных вызовов — в одном сообщении.
        turn.push({ role: "user", content: results });
        continue;
      }

      if (response.stop_reason === "pause_turn") continue;

      log.info("Ход завершён", { clinic: input.clinic.id, stop: response.stop_reason, served_by: response.model, usage });
      return {
        replies: texts,
        messages: turn,
        stopReason: response.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
        usage,
      };
    }

    log.warn("Превышен лимит шагов агента за ход", { clinic: input.clinic.id, rounds: this.opts.maxToolRounds });
    return { replies: [], messages: turn, stopReason: "max_rounds", usage };
  }

  private initialMessages(userContent: string | BetaContentBlockParam[], contextNote: string): BetaMessageParam[] {
    if (this.systemMessages) {
      // Служебный контекст — отдельным system-сообщением после реплики пациента: его нельзя подделать
      // из текста пациента, и он не ломает кэш системного промпта.
      return [
        { role: "user", content: userContent },
        { role: "system", content: contextNote },
      ];
    }
    const blocks: BetaContentBlockParam[] =
      typeof userContent === "string" ? [{ type: "text", text: userContent }] : userContent;
    return [{ role: "user", content: [{ type: "text", text: `<context>\n${contextNote}\n</context>` }, ...blocks] }];
  }

  private params(system: BetaTextBlockParam[], messages: BetaMessageParam[], userKey?: string): MessageCreateParamsNonStreaming {
    const params: MessageCreateParamsNonStreaming = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: this.opts.effort },
      // Автокэширование растущего хвоста переписки (плюс явная точка кэша на системном промпте).
      cache_control: { type: "ephemeral" },
    };
    if (userKey) params.metadata = { user_id: createHash("sha256").update(userKey).digest("hex").slice(0, 32) };
    if (this.useFallbacks) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }
}
