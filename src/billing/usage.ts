/** Цены Claude API, USD за 1 млн токенов. Обновляйте при смене тарифов Anthropic. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Запись в кэш на 5 минут — 1,25 × цены входа. */
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
};

/** Для неизвестной модели считаем по завышенному тарифу — лимиты бюджета сработают раньше, а не позже. */
const UNKNOWN_MODEL_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function priceFor(model: string): Price {
  if (PRICES[model]) return PRICES[model];
  const prefix = Object.keys(PRICES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? PRICES[prefix]! : UNKNOWN_MODEL_PRICE;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1_000_000;
}
