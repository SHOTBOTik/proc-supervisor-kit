// Конфиг сторожа: JSON со списком процессов. Проверка строгая — опечатка в ключе тоже ошибка,
// иначе сторож молча не будет следить за тем, за чем должен.
import fs from 'node:fs';
import path from 'node:path';

export interface ProcessConfig {
  /** Короткое имя для логов и алертов. */
  name: string;
  /** Регулярное выражение для командной строки процесса. */
  match: string;
  /** Имя образа, по умолчанию `node` (совпадает и с `node.exe`). */
  image?: string;
  /** Командные строки, которые не считаются: пробные запуски и т. п. */
  exclude?: string;
  /** Обёртка перезапуска: если жива, сторож сам не запускает — ждёт, пока поднимет она. */
  wrapper?: { match: string; image?: string };
  /** Файл пульса и его предельный возраст: старше — процесс завис, его снимают. */
  heartbeat?: { file: string; maxAgeSec: number };
  /** Чем запустить, если нет ни процесса, ни обёртки. */
  start?: { command: string; args?: string[]; cwd?: string };
  /** Чей лог смотреть: строки, совпавшие с `alert` (без учёта регистра), становятся алертами. */
  tail?: { file: string; alert?: string };
}

export interface WatchdogConfig {
  intervalSec?: number;
  log?: string;
  alertsLog?: string;
  logMaxBytes?: number;
  logKeep?: number;
  dedupWindowSec?: number;
  summaryEverySec?: number;
  /** Сколько тиков подряд процесса нет при живой обёртке, прежде чем это алерт. */
  wrapperGraceTicks?: number;
  processes: ProcessConfig[];
}

export interface ResolvedProcess {
  name: string;
  match: RegExp;
  image: string;
  exclude: RegExp | null;
  wrapper: { match: RegExp; image: string } | null;
  heartbeat: { file: string; maxAgeSec: number } | null;
  start: { command: string; args: string[]; cwd: string } | null;
  tail: { file: string; alert: RegExp } | null;
}

export interface ResolvedConfig {
  dir: string;
  intervalSec: number;
  log: string;
  alertsLog: string;
  logMaxBytes: number;
  logKeep: number;
  dedupWindowSec: number;
  summaryEverySec: number;
  wrapperGraceTicks: number;
  processes: ResolvedProcess[];
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`конфиг: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

const TOP_KEYS = ['intervalSec', 'log', 'alertsLog', 'logMaxBytes', 'logKeep', 'dedupWindowSec', 'summaryEverySec', 'wrapperGraceTicks', 'processes'];
const PROC_KEYS = ['name', 'match', 'image', 'exclude', 'wrapper', 'heartbeat', 'start', 'tail'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Проверить разобранный JSON. Возвращает список проблем; пустой — конфиг годен. */
export function validateConfig(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ['корень должен быть объектом'];
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) p.push(`неизвестный ключ «${k}»`);
  const num = (o: Obj, k: string, where: string, min: number) => {
    if (o[k] === undefined) return;
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || (o[k] as number) < min) p.push(`${where}${k}: нужно число ≥ ${min}`);
  };
  const str = (o: Obj, k: string, where: string, required: boolean) => {
    if (o[k] === undefined) { if (required) p.push(`${where}${k}: обязательно`); return; }
    if (typeof o[k] !== 'string' || o[k] === '') p.push(`${where}${k}: нужна непустая строка`);
  };
  const re = (o: Obj, k: string, where: string, required: boolean) => {
    str(o, k, where, required);
    if (typeof o[k] === 'string' && o[k]) {
      try { new RegExp(o[k] as string); } catch (e) { p.push(`${where}${k}: плохое регулярное выражение (${(e as Error).message})`); }
    }
  };
  /** `match`, совпадающий с пустой строкой (`.*`, `x?`), совпадёт с любым процессом — сторож снимал бы чужие. */
  const notAny = (o: Obj, where: string) => {
    if (typeof o.match !== 'string' || !o.match) return;
    try { if (new RegExp(o.match).test('')) p.push(`${where}match: совпадает с пустой строкой, то есть с любым процессом`); } catch { /* уже отмечено */ }
  };
  const sub = (o: Obj, k: string, where: string, keys: string[], check: (s: Obj, w: string) => void) => {
    if (o[k] === undefined) return;
    if (!isObj(o[k])) { p.push(`${where}${k}: нужен объект`); return; }
    const s = o[k] as Obj;
    for (const sk of Object.keys(s)) if (!keys.includes(sk)) p.push(`${where}${k}: неизвестный ключ «${sk}»`);
    check(s, `${where}${k}.`);
  };
  num(raw, 'intervalSec', '', 1);
  num(raw, 'logMaxBytes', '', 1024);
  num(raw, 'logKeep', '', 1);
  num(raw, 'dedupWindowSec', '', 0);
  num(raw, 'summaryEverySec', '', 0);
  num(raw, 'wrapperGraceTicks', '', 1);
  str(raw, 'log', '', false);
  str(raw, 'alertsLog', '', false);
  if (!Array.isArray(raw.processes) || raw.processes.length === 0) {
    p.push('processes: нужен непустой массив');
    return p;
  }
  const names = new Set<string>();
  raw.processes.forEach((pr: unknown, i: number) => {
    const w = `processes[${i}].`;
    if (!isObj(pr)) { p.push(`processes[${i}]: нужен объект`); return; }
    for (const k of Object.keys(pr)) if (!PROC_KEYS.includes(k)) p.push(`processes[${i}]: неизвестный ключ «${k}»`);
    str(pr, 'name', w, true);
    if (typeof pr.name === 'string') {
      if (names.has(pr.name)) p.push(`${w}name: имя «${pr.name}» уже есть`);
      names.add(pr.name);
    }
    re(pr, 'match', w, true);
    notAny(pr, w);
    str(pr, 'image', w, false);
    re(pr, 'exclude', w, false);
    sub(pr, 'wrapper', w, ['match', 'image'], (s, sw) => { re(s, 'match', sw, true); notAny(s, sw); str(s, 'image', sw, false); });
    sub(pr, 'heartbeat', w, ['file', 'maxAgeSec'], (s, sw) => {
      str(s, 'file', sw, true);
      if (s.maxAgeSec === undefined) p.push(`${sw}maxAgeSec: обязательно`); else num(s, 'maxAgeSec', sw, 1);
    });
    sub(pr, 'start', w, ['command', 'args', 'cwd'], (s, sw) => {
      str(s, 'command', sw, true);
      str(s, 'cwd', sw, false);
      if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string'))) p.push(`${sw}args: нужен массив строк`);
    });
    sub(pr, 'tail', w, ['file', 'alert'], (s, sw) => { str(s, 'file', sw, true); re(s, 'alert', sw, false); });
  });
  return p;
}

/** Проверить и разрешить: пути — от каталога конфига, регулярки — скомпилировать, умолчания — подставить. */
export function resolveConfig(raw: unknown, dir: string): ResolvedConfig {
  const problems = validateConfig(raw);
  if (problems.length) throw new ConfigError(problems);
  const c = raw as WatchdogConfig;
  const abs = (f: string) => path.resolve(dir, f);
  return {
    dir,
    intervalSec: c.intervalSec ?? 60,
    log: abs(c.log ?? 'watchdog.log'),
    alertsLog: abs(c.alertsLog ?? 'alerts.log'),
    logMaxBytes: c.logMaxBytes ?? 10 * 1024 * 1024,
    logKeep: c.logKeep ?? 2,
    dedupWindowSec: c.dedupWindowSec ?? 600,
    summaryEverySec: c.summaryEverySec ?? 6 * 3600,
    wrapperGraceTicks: c.wrapperGraceTicks ?? 2,
    processes: c.processes.map(pr => ({
      name: pr.name,
      match: new RegExp(pr.match),
      image: pr.image ?? 'node',
      exclude: pr.exclude ? new RegExp(pr.exclude) : null,
      wrapper: pr.wrapper ? { match: new RegExp(pr.wrapper.match), image: pr.wrapper.image ?? 'bash' } : null,
      heartbeat: pr.heartbeat ? { file: abs(pr.heartbeat.file), maxAgeSec: pr.heartbeat.maxAgeSec } : null,
      start: pr.start ? { command: pr.start.command, args: pr.start.args ?? [], cwd: abs(pr.start.cwd ?? '.') } : null,
      tail: pr.tail ? { file: abs(pr.tail.file), alert: new RegExp(pr.tail.alert ?? '\\b(error|fatal)\\b', 'i') } : null,
    })),
  };
}

export function loadConfig(file: string): ResolvedConfig {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError([`${file}: ${(e as Error).message}`]); }
  return resolveConfig(raw, path.dirname(path.resolve(file)));
}
