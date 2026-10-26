// Решение сторожа на подменённом списке процессов: ни один настоящий процесс не трогается.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveConfig, type ResolvedProcess } from '../src/config.ts';
import type { ProcInfo } from '../src/procs.ts';
import { decide, fmtAge, Watchdog, type DecideInput, type ProcState } from '../src/watchdog.ts';
import { tmpDir } from './helpers.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function spec(extra: Record<string, unknown> = {}): ResolvedProcess {
  return resolveConfig({
    processes: [{
      name: 'w', match: 'worker\\.js', exclude: '--once',
      wrapper: { match: 'run-forever\\.sh.*worker\\.js' },
      heartbeat: { file: 'w.hb', maxAgeSec: 120 },
      start: { command: 'bash', args: ['run-forever.sh', 'node', 'worker.js'] },
      ...extra,
    }],
  }, '/app').processes[0]!;
}

const node = (pid: number, cmd: string | null, startedAt: number | null = NOW - 60 * MIN): ProcInfo => ({ pid, name: 'node.exe', cmd, startedAt });
const bash = (pid: number, cmd: string): ProcInfo => ({ pid, name: 'bash.exe', cmd, startedAt: NOW - 60 * MIN });
const WRAPPER = bash(10, 'bash run-forever.sh node worker.js');

function run(procs: ProcInfo[], age: number | null, state: ProcState = { downTicks: 0, lastActionAt: 0 }, s = spec()) {
  const input: DecideInput = { spec: s, procs, heartbeatAgeSec: age, state, now: NOW, skipPids: [1], wrapperGraceTicks: 2 };
  const d = decide(input);
  return { ...d, kinds: d.actions.map(a => a.kind), state };
}

test('процесс жив, пульс свежий — ничего не делать', () => {
  const r = run([WRAPPER, node(11, 'node worker.js')], 5);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.pids, [11]);
});

test('обёртка bash с тем же worker.js в командной строке не считается процессом (фильтр по образу)', () => {
  const r = run([WRAPPER], 5);
  assert.notEqual(r.status, 'ok');
  assert.deepEqual(r.pids, []);
});

test('пульс протух — алерт и снятие всех экземпляров', () => {
  const r = run([WRAPPER, node(11, 'node worker.js')], 600);
  assert.equal(r.status, 'stale');
  assert.deepEqual(r.kinds, ['alert', 'kill']);
  assert.equal(r.actions[1]?.kind === 'kill' && r.actions[1].pid, 11);
  assert.equal(r.state.lastActionAt, NOW);
});

test('пульс протух, но процесс моложе предела — ждём первого пульса', () => {
  const r = run([node(11, 'node worker.js', NOW - 30_000)], 600);
  assert.equal(r.status, 'restarting');
  assert.deepEqual(r.kinds, ['log']);
});

test('после снятия не снимаем повторно, пока не прошёл предел', () => {
  const state = { downTicks: 0, lastActionAt: NOW - 60_000 };
  const r = run([node(12, 'node worker.js', null)], 600, state);
  assert.deepEqual(r.kinds, ['log']);
});

test('процесса и обёртки нет — запуск', () => {
  const r = run([node(99, 'node other.js')], null);
  assert.equal(r.status, 'down');
  assert.deepEqual(r.kinds, ['alert', 'start']);
});

test('процесса нет, обёртка жива — не запускаем второй; алерт только после wrapperGraceTicks', () => {
  const state = { downTicks: 0, lastActionAt: 0 };
  const r1 = run([WRAPPER], null, state);
  assert.deepEqual(r1.kinds, ['log']);
  const r2 = run([WRAPPER], null, state);
  assert.deepEqual(r2.kinds, ['alert']);
  assert.equal(r2.status, 'restarting');
  run([WRAPPER, node(11, 'node worker.js')], 1, state);
  assert.equal(state.downTicks, 0, 'счётчик сбрасывается, когда процесс вернулся');
});

test('два экземпляра — алерт о дубле', () => {
  const r = run([node(11, 'node worker.js'), node(12, 'node worker.js')], 3);
  assert.equal(r.status, 'duplicate');
  assert.deepEqual(r.kinds, ['alert']);
  assert.match((r.actions[0] as { text: string }).text, /2 экземпляра/);
});

test('пробный запуск (--once) и сам сторож не считаются', () => {
  const r = run([node(11, 'node worker.js --once'), node(1, 'node cli.ts watch worker.js')], null);
  assert.equal(r.status, 'down');
});

test('node без командной строки (другие права) — второй не запускаем', () => {
  const r = run([node(11, null)], null);
  assert.equal(r.status, 'blind');
  assert.deepEqual(r.kinds, ['log']);
});

test('нет команды запуска — только алерт', () => {
  const s = resolveConfig({ processes: [{ name: 'w', match: 'worker\\.js' }] }, '/').processes[0]!;
  const r = run([], null, undefined, s);
  assert.deepEqual(r.kinds, ['alert']);
});

test('нет файла пульса у живого процесса — алерт без снятия', () => {
  const r = run([node(11, 'node worker.js')], null);
  assert.equal(r.status, 'no-heartbeat');
  assert.deepEqual(r.kinds, ['alert']);
});

function makeWatchdog(procs: ProcInfo[], opts: { dryRun?: boolean; hbAgeMs?: number } = {}) {
  const dir = tmpDir();
  let now = NOW;
  if (opts.hbAgeMs !== undefined) fs.writeFileSync(path.join(dir, 'w.hb'), String(NOW - opts.hbAgeMs));
  fs.writeFileSync(path.join(dir, 'w.log'), 'старт\n');
  const cfg = resolveConfig({
    summaryEverySec: 3600,
    processes: [{
      name: 'w', match: 'worker\\.js', heartbeat: { file: 'w.hb', maxAgeSec: 120 },
      start: { command: 'bash', args: ['x'] }, tail: { file: 'w.log', alert: 'error' },
    }],
  }, dir);
  const killed: number[] = [];
  const started: string[] = [];
  const printed: string[] = [];
  const wd = new Watchdog(cfg, {
    listProcesses: () => procs,
    kill: pid => { killed.push(pid); },
    start: async s => { started.push(s.command); return 4242; },
    now: () => now,
    print: l => printed.push(l),
    selfPids: [1],
    dryRun: opts.dryRun,
  });
  return { wd, dir, killed, started, printed, advance: (ms: number) => { now += ms; } };
}

test('Watchdog: протухший пульс — снимает через подменённый kill, пишет алерт в файлы', async () => {
  const t = makeWatchdog([node(11, 'node worker.js')], { hbAgeMs: 10 * MIN });
  const r = await t.wd.tick();
  assert.deepEqual(t.killed, [11]);
  assert.ok(r.problems >= 2);
  assert.match(fs.readFileSync(path.join(t.dir, 'alerts.log'), 'utf8'), /нет пульса 10 мин/);
  assert.match(fs.readFileSync(path.join(t.dir, 'watchdog.log'), 'utf8'), /снят pid 11/);
  assert.ok(t.printed.some(l => l.includes('ALERT w: нет пульса')));
});

test('Watchdog --dry-run: ничего не снимает и не запускает, файлов не пишет', async () => {
  const t = makeWatchdog([], { dryRun: true });
  const r = await t.wd.tick();
  assert.deepEqual(t.started, []);
  assert.deepEqual(t.killed, []);
  assert.ok(r.problems > 0);
  assert.ok(t.printed.some(l => l.includes('[dry-run] запустил бы: w: bash x')));
  assert.equal(fs.existsSync(path.join(t.dir, 'alerts.log')), false);
  assert.equal(fs.existsSync(path.join(t.dir, 'watchdog.log')), false);
});

test('Watchdog: запуск, строки лога с ошибкой — алерты, сводка одной строкой раз в период', async () => {
  const t = makeWatchdog([]);
  await t.wd.tick();
  assert.deepEqual(t.started, ['bash']);
  fs.appendFileSync(path.join(t.dir, 'w.log'), 'всё хорошо\nerror: что-то сломалось\n');
  t.advance(61 * MIN);
  await t.wd.tick();
  const alerts = fs.readFileSync(path.join(t.dir, 'alerts.log'), 'utf8');
  assert.match(alerts, /w: error: что-то сломалось/);
  assert.doesNotMatch(alerts, /всё хорошо/);
  const summary = t.printed.filter(l => l.includes('сводка:'));
  assert.equal(summary.length, 1);
  assert.match(summary[0]!, /сводка: w down \| тиков 2, алертов \d+, подавлено \d+, снято 0, запущено 2$/);
  assert.equal(summary[0]!.includes('\n'), false);
});

test('Watchdog: живой процесс со свежим пульсом — ноль проблем', async () => {
  const t = makeWatchdog([node(11, 'node worker.js')], { hbAgeMs: 1000 });
  const r = await t.wd.tick();
  assert.equal(r.problems, 0);
  assert.deepEqual(r.statuses, { w: 'ok' });
});

test('возраст пульса в алерте — в удобных единицах', () => {
  assert.equal(fmtAge(45), '45 с');
  assert.equal(fmtAge(600), '10 мин');
  assert.equal(fmtAge(3 * 3600), '3 ч');
  assert.equal(fmtAge(10 * 86400), '10 дн');
});
