// Вычистка секретов из логов перед архивом: набор регулярок плюс точные значения из env-файлов.
// Значения никогда не печатаются — только число замен. Для серьёзной проверки есть отдельные сканеры,
// например leak-guard (`leak-guard scrub < app.log > app.clean.log`).
import fs from 'node:fs';
import path from 'node:path';

export const REDACTED = '[REDACTED]';

export interface ScrubRule { name: string; re: RegExp; replace: string }

export const DEFAULT_RULES: ScrubRule[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: `${REDACTED} private key` },
  { name: 'auth-header', re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: `$1 ${REDACTED}` },
  { name: 'url-password', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, replace: `$1${REDACTED}@` },
  { name: 'assign', re: /\b([\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, replace: `$1${REDACTED}` },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { name: 'aws-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { name: 'jwt', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, replace: REDACTED },
];

/** Значения из файлов вида ИМЯ=значение (кавычки снимаются, короче 6 знаков — не берём: слишком много ложных замен). */
export function loadEnvValues(file: string): string[] {
  const out: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[\w.-]+\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = (m[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v.length >= 6) out.push(v);
  }
  return out;
}

export interface ScrubResult { text: string; replaced: number }

export function scrubText(text: string, rules: ScrubRule[] = DEFAULT_RULES, values: string[] = []): ScrubResult {
  let replaced = 0;
  let s = text;
  // сначала точные значения, длинные раньше коротких — чтобы короткое не разрезало длинное
  for (const v of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    const parts = s.split(v);
    if (parts.length > 1) { replaced += parts.length - 1; s = parts.join(REDACTED); }
  }
  for (const r of rules) {
    s = s.replace(r.re, (...args: unknown[]) => {
      const whole = String(args[0]);
      const out = whole.replace(new RegExp(r.re.source, r.re.flags.replace('g', '')), r.replace);
      if (out !== whole) replaced++;
      return out;
    });
  }
  return { text: s, replaced };
}

export function userRules(patterns: string[]): ScrubRule[] {
  return patterns.map((p, i) => ({ name: `user-${i + 1}`, re: new RegExp(p, 'g'), replace: REDACTED }));
}

export interface ScrubFilesOptions {
  /** Каталог, куда положить вычищенные копии. */
  to: string;
  rules?: ScrubRule[];
  values?: string[];
  /** Оставить исходники на месте (по умолчанию — удалить: лог переезжает в архив). */
  keep?: boolean;
  dryRun?: boolean;
}

export interface ScrubFileReport { file: string; dest: string; replaced: number }

/** Вычистить и переложить логи. Отсутствующие файлы пропускаются — повторный запуск ничего не ломает. */
export function scrubFiles(files: string[], o: ScrubFilesOptions): ScrubFileReport[] {
  const reports: ScrubFileReport[] = [];
  for (const f of files) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const dest = path.join(o.to, path.basename(f));
    const { text, replaced } = scrubText(fs.readFileSync(f, 'utf8'), o.rules ?? DEFAULT_RULES, o.values ?? []);
    if (!o.dryRun) {
      fs.mkdirSync(o.to, { recursive: true });
      fs.writeFileSync(dest, text);
      if (!o.keep) fs.rmSync(f);
    }
    reports.push({ file: f, dest, replaced });
  }
  return reports;
}
