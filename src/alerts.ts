// Алерты с окном дедупликации: одинаковый текст не чаще раза в окно, повторы считаются.
// «Одинаковый» — после замены чисел на `#`: «нет пульса 12 мин» и «нет пульса 13 мин» — один алерт.

export interface AlerterOptions {
  windowMs?: number;
  now?: () => number;
  /** Куда уходит готовая строка алерта (без времени — его добавляет приёмник). */
  sink: (text: string) => void;
  /** Сравнивать без цифр (по умолчанию да). */
  ignoreDigits?: boolean;
}

interface Entry { text: string; firstAt: number; suppressed: number }

export function timesRu(n: number): string {
  const d10 = n % 10, d100 = n % 100;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} раза`;
  return `${n} раз`;
}

export function dedupKey(text: string, ignoreDigits = true): string {
  const t = text.replace(/\r?\n/g, ' | ');
  return ignoreDigits ? t.replace(/\d+(?:[.,]\d+)?/g, '#') : t;
}

export class Alerter {
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly sink: (text: string) => void;
  private readonly ignoreDigits: boolean;
  private readonly seen = new Map<string, Entry>();
  emitted = 0;
  suppressedTotal = 0;

  constructor(o: AlerterOptions) {
    this.windowMs = o.windowMs ?? 10 * 60_000;
    this.now = o.now ?? Date.now;
    this.sink = o.sink;
    this.ignoreDigits = o.ignoreDigits ?? true;
  }

  /** Вернёт true, если алерт ушёл, false — если подавлен окном. */
  alert(text: string): boolean {
    const line = text.replace(/\r?\n/g, ' | ');
    const key = dedupKey(line, this.ignoreDigits);
    const now = this.now();
    const e = this.seen.get(key);
    if (e && now - e.firstAt < this.windowMs) {
      e.suppressed++; e.text = line; this.suppressedTotal++;
      return false;
    }
    const suffix = e && e.suppressed > 0 ? ` (повторилось ${timesRu(e.suppressed)})` : '';
    this.seen.set(key, { text: line, firstAt: now, suppressed: 0 });
    this.emitted++;
    this.sink(line + suffix);
    return true;
  }

  /** Закрыть истёкшие окна: если в окне были повторы — сообщить их число, даже если алерт больше не приходит. */
  flush(): void {
    const now = this.now();
    for (const [key, e] of this.seen) {
      if (now - e.firstAt < this.windowMs) continue;
      this.seen.delete(key);
      if (e.suppressed > 0) {
        this.emitted++;
        this.sink(`${e.text} (повторилось ${timesRu(e.suppressed)} за ${Math.round(this.windowMs / 60_000)} мин)`);
      }
    }
  }
}
