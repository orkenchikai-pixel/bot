/**
 * Счётчик событий в скользящем окне (в памяти процесса).
 * Используется для лимитов сообщений, неудачных входов в админку и т.п.
 */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();
  private operations = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 100_000,
  ) {}

  /** Регистрирует событие и возвращает число событий в окне (включая это). */
  hit(key: string, now = Date.now()): number {
    const list = this.fresh(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (++this.operations % 1000 === 0 || this.hits.size > this.maxKeys) this.sweep(now);
    return list.length;
  }

  count(key: string, now = Date.now()): number {
    return this.fresh(key, now).length;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private fresh(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) this.hits.delete(key);
    return list;
  }

  /** Чистит пустые ключи, чтобы память не росла от разовых номеров. */
  private sweep(now: number): void {
    for (const key of [...this.hits.keys()]) this.fresh(key, now);
    // Защита от исчерпания памяти при атаке с огромного числа ключей: выбрасываем самые старые.
    if (this.hits.size > this.maxKeys) {
      const excess = this.hits.size - this.maxKeys;
      let removed = 0;
      for (const key of this.hits.keys()) {
        if (removed++ >= excess) break;
        this.hits.delete(key);
      }
    }
  }
}

/** Не чаще одного раза за интервал (например, предупреждение о спаме одному номеру). */
export class Throttle {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    if (this.last.size > 50_000) {
      for (const [k, t] of this.last) if (now - t >= this.intervalMs) this.last.delete(k);
    }
    return true;
  }
}

/** Ограничение числа одновременных запросов к ИИ: остальные ждут в очереди. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      // Слот передаётся напрямую от завершившейся задачи — счётчик уже учтён (без гонки).
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
