// Сторож: раз в интервал смотрит список процессов, пульс и хвосты логов и решает, что делать.
// Решение (`decide`) — чистая функция от списка процессов и возраста пульса, поэтому её легко проверять
// на подменённом списке. Исполнение действий (снять, запустить) — в классе Watchdog через подменяемые зависимости.
import { Alerter } from './alerts.ts';
import type { ResolvedConfig, ResolvedProcess } from './config.ts';
import { heartbeatAgeSec } from './heartbeat.ts';
import { RotatingLog } from './logfile.ts';
import { ancestorPids, findProcesses, imageMatches, type ProcInfo, type StartSpec } from './procs.ts';
import { LogTail } from './tail.ts';

export type Action =
  | { kind: 'alert'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'kill'; pid: number; text: string }
  | { kind: 'start'; text: string };

export type Status = 'ok' | 'stale' | 'restarting' | 'down' | 'blind' | 'duplicate' | 'no-heartbeat';

export interface ProcState {
  /** Сколько тиков подряд процесса нет. */
  downTicks: number;
  /** Когда сторож последний раз снимал или запускал процесс (мс): после этого даём время на первый пульс. */
  lastActionAt: number;
}

export interface DecideInput {
  spec: ResolvedProcess;
  procs: ProcInfo[];
  heartbeatAgeSec: number | null;
  state: ProcState;
  now: number;
  skipPids: number[];
  wrapperGraceTicks: number;
}

export interface Decision { status: Status; actions: Action[]; pids: number[] }

export const fmtAge = (sec: number): string =>
  sec < 120 ? `${Math.round(sec)} с`
    : sec < 7200 ? `${Math.round(sec / 60)} мин`
      : sec < 172800 ? `${Math.round(sec / 3600)} ч`
        : `${Math.round(sec / 86400)} дн`;

/** Решить, что делать с одним процессом. Меняет `state` (счётчик тиков, время последнего действия). */
export function decide(i: DecideInput): Decision {
  const { spec, procs, state, now } = i;
  const actions: Action[] = [];
  const nodes = findProcesses(procs, { match: spec.match, image: spec.image, exclude: spec.exclude ?? undefined, skipPids: i.skipPids });
  const pids = nodes.map(p => p.pid);

  if (nodes.length === 0) {
    state.downTicks++;
    const opaque = procs.filter(p => p.cmd === null && imageMatches(p.name, spec.image) && !i.skipPids.includes(p.pid)).length;
    if (opaque > 0) {
      actions.push({ kind: 'log', text: `${spec.name}: не виден, но есть ${opaque} процесс(ов) ${spec.image} без командной строки (другие права) — второй не запускаю` });
      return { status: 'blind', actions, pids };
    }
    const wrappers = spec.wrapper ? findProcesses(procs, { match: spec.wrapper.match, image: spec.wrapper.image, skipPids: i.skipPids }) : [];
    if (wrappers.length > 0) {
      if (state.downTicks >= i.wrapperGraceTicks) {
        actions.push({ kind: 'alert', text: `${spec.name}: процесса нет ${state.downTicks} тиков подряд, хотя обёртка жива (pid ${wrappers.map(w => w.pid).join(',')}) — смотри её лог` });
      } else {
        actions.push({ kind: 'log', text: `${spec.name}: процесса нет, обёртка жива — жду, пока она поднимет` });
      }
      return { status: 'restarting', actions, pids };
    }
    if (spec.start) {
      actions.push({ kind: 'alert', text: `${spec.name}: нет ни процесса, ни обёртки — запускаю` });
      actions.push({ kind: 'start', text: `${spec.name}: ${spec.start.command} ${spec.start.args.join(' ')}`.trim() });
      state.lastActionAt = now;
    } else {
      actions.push({ kind: 'alert', text: `${spec.name}: процесса нет, команда запуска не задана` });
    }
    return { status: 'down', actions, pids };
  }

  state.downTicks = 0;
  if (nodes.length > 1) {
    actions.push({ kind: 'alert', text: `${spec.name}: ${nodes.length} экземпляра (pid ${pids.join(',')}) — проверь замок от второго экземпляра` });
  }
  if (!spec.heartbeat) return { status: nodes.length > 1 ? 'duplicate' : 'ok', actions, pids };

  const max = spec.heartbeat.maxAgeSec;
  const age = i.heartbeatAgeSec;
  if (age === null) {
    actions.push({ kind: 'alert', text: `${spec.name}: файла пульса нет — процесс жив, но пульса не пишет` });
    return { status: 'no-heartbeat', actions, pids };
  }
  if (age <= max) return { status: nodes.length > 1 ? 'duplicate' : 'ok', actions, pids };

  // Пульс протух. Не снимаем, если процесс моложе предела (не успел написать первый пульс)
  // или сторож сам недавно его снимал/запускал.
  const youngest = Math.max(...nodes.map(p => p.startedAt ?? 0));
  const procAgeSec = youngest > 0 ? (now - youngest) / 1000 : Infinity;
  const sinceActionSec = (now - state.lastActionAt) / 1000;
  if (procAgeSec <= max || sinceActionSec <= max) {
    actions.push({ kind: 'log', text: `${spec.name}: пульс ${fmtAge(age)}, но процесс только что (пере)запущен — жду первого пульса` });
    return { status: 'restarting', actions, pids };
  }
  actions.push({ kind: 'alert', text: `${spec.name}: нет пульса ${fmtAge(age)} (предел ${fmtAge(max)}) — снимаю, обёртка перезапустит` });
  for (const p of nodes) actions.push({ kind: 'kill', pid: p.pid, text: `${spec.name}: снят pid ${p.pid} за отсутствие пульса` });
  state.lastActionAt = now;
  return { status: 'stale', actions, pids };
}

export interface WatchdogDeps {
  listProcesses: () => ProcInfo[];
  kill: (pid: number) => void;
  start: (spec: StartSpec) => Promise<number>;
  now?: () => number;
  /** Куда печатать: по умолчанию stdout. */
  print?: (line: string) => void;
  /** Какие pid не считать никогда. По умолчанию — сам сторож и цепочка его предков. */
  selfPids?: number[];
  dryRun?: boolean;
  /** Печатать и служебные строки (по умолчанию — только алерты, действия и сводку). */
  verbose?: boolean;
}

export interface TickResult { problems: number; statuses: Record<string, Status> }

export class Watchdog {
  readonly cfg: ResolvedConfig;
  private readonly deps: WatchdogDeps;
  private readonly now: () => number;
  private readonly print: (line: string) => void;
  private readonly log: RotatingLog;
  private readonly alertsLog: RotatingLog;
  readonly alerter: Alerter;
  private readonly tails = new Map<string, LogTail>();
  private readonly states = new Map<string, ProcState>();
  private lastStatuses: Record<string, Status> = {};
  private lastSummaryAt: number;
  private problemsThisTick = 0;
  ticks = 0;
  kills = 0;
  starts = 0;

  constructor(cfg: ResolvedConfig, deps: WatchdogDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.print = deps.print ?? (line => process.stdout.write(line + '\n'));
    this.log = new RotatingLog(cfg.log, { maxBytes: cfg.logMaxBytes, keep: cfg.logKeep, now: this.now });
    this.alertsLog = new RotatingLog(cfg.alertsLog, { maxBytes: cfg.logMaxBytes, keep: cfg.logKeep, now: this.now });
    this.alerter = new Alerter({
      windowMs: cfg.dedupWindowSec * 1000,
      now: this.now,
      sink: text => { this.problemsThisTick++; this.emit(`ALERT ${text}`, true); if (!deps.dryRun) this.alertsLog.write(text); },
    });
    for (const p of cfg.processes) {
      this.states.set(p.name, { downTicks: 0, lastActionAt: 0 });
      if (p.tail) this.tails.set(p.name, new LogTail(p.tail.file));
    }
    this.lastSummaryAt = this.now();
  }

  /** Строка — в свой лог (кроме сухого прогона) и, если важная или verbose, в stdout. */
  private emit(text: string, important: boolean): void {
    const line = this.deps.dryRun ? `[dry-run] ${text}` : text;
    if (!this.deps.dryRun) this.log.write(text);
    if (important || this.deps.verbose) this.print(`${new Date(this.now()).toISOString()} ${line}`);
  }

  info(text: string): void { this.emit(text, false); }

  async tick(): Promise<TickResult> {
    this.ticks++;
    this.problemsThisTick = 0;
    const now = this.now();
    let procs: ProcInfo[];
    try { procs = this.deps.listProcesses(); } catch (e) {
      this.emit(`список процессов не получен: ${(e as Error).message}`, true);
      return { problems: 1, statuses: {} };
    }
    const statuses: Record<string, Status> = {};
    const skipPids = this.deps.selfPids ?? [process.pid, ...ancestorPids(procs, process.pid)];
    for (const spec of this.cfg.processes) {
      const tail = this.tails.get(spec.name);
      if (tail && spec.tail) {
        try {
          for (const line of tail.read()) if (spec.tail.alert.test(line)) this.alerter.alert(`${spec.name}: ${line.slice(0, 300)}`);
        } catch (e) { this.info(`${spec.name}: хвост лога не прочитан: ${(e as Error).message}`); }
      }
      const age = spec.heartbeat ? heartbeatAgeSec(spec.heartbeat.file, now) : null;
      const state = this.states.get(spec.name)!;
      const d = decide({ spec, procs, heartbeatAgeSec: age, state, now, skipPids, wrapperGraceTicks: this.cfg.wrapperGraceTicks });
      statuses[spec.name] = d.status;
      for (const a of d.actions) await this.run(a, spec);
    }
    this.alerter.flush();
    this.lastStatuses = statuses;
    if (this.cfg.summaryEverySec > 0 && now - this.lastSummaryAt >= this.cfg.summaryEverySec * 1000) {
      this.lastSummaryAt = now;
      this.emit(this.summaryLine(), true);
    }
    return { problems: this.problemsThisTick, statuses };
  }

  private async run(a: Action, spec: ResolvedProcess): Promise<void> {
    if (a.kind === 'alert') { this.alerter.alert(a.text); return; }
    if (a.kind === 'log') { this.info(a.text); return; }
    this.problemsThisTick++;
    if (a.kind === 'kill') {
      if (this.deps.dryRun) { this.emit(`снял бы: ${a.text}`, true); return; }
      try { this.deps.kill(a.pid); this.kills++; this.emit(a.text, true); } catch (e) { this.emit(`${spec.name}: pid ${a.pid} не снят: ${(e as Error).message}`, true); }
      return;
    }
    if (!spec.start) return;
    if (this.deps.dryRun) { this.emit(`запустил бы: ${a.text}`, true); return; }
    try { const pid = await this.deps.start(spec.start); this.starts++; this.emit(`запущен ${a.text} (pid ${pid})`, true); } catch (e) { this.emit(`${spec.name}: не запустился: ${(e as Error).message}`, true); }
  }

  /** Сводка одной строкой: состояние каждого процесса и счётчики. */
  summaryLine(): string {
    const parts = this.cfg.processes.map(p => `${p.name} ${this.lastStatuses[p.name] ?? '?'}`);
    return `сводка: ${parts.join(', ')} | тиков ${this.ticks}, алертов ${this.alerter.emitted}, подавлено ${this.alerter.suppressedTotal}, снято ${this.kills}, запущено ${this.starts}`;
  }
}
