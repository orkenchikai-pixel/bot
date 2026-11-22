import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { DentalAgent } from "./agent.js";

export const DEFAULT_CANARY_SECRET = "dental-crm-agent-canary";

export function createAgent(config: AppConfig): DentalAgent {
  // Ключ берётся из ANTHROPIC_API_KEY. Таймаут на запрос — 2 минуты, SDK сам повторяет 429/5xx.
  const client = new Anthropic({ maxRetries: 2, timeout: 120_000 });
  return new DentalAgent(client, {
    model: config.AGENT_MODEL,
    effort: config.AGENT_EFFORT,
    maxTokens: config.AGENT_MAX_TOKENS,
    fallbacks: config.AGENT_FALLBACKS,
    maxToolRounds: config.AGENT_MAX_TOOL_ROUNDS,
    canarySecret: config.CANARY_SECRET ?? DEFAULT_CANARY_SECRET,
  });
}
