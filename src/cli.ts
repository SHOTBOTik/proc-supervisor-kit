#!/usr/bin/env node
// proc-supervisor-kit: сторож и служебные команды для deploy.sh.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { ConfigError, loadConfig } from './config.ts';
import { heartbeatTime } from './heartbeat.ts';
import { EXIT_ALREADY_RUNNING, takeLock } from './lock.ts';
import { ancestorPids, findProcesses, killPid, listProcesses, spawnDetached, type ProcInfo } from './procs.ts';
import { DEFAULT_RULES, loadEnvValues, scrubFiles, userRules } from './scrub.ts';
import { Watchdog } from './watchdog.ts';

const USAGE = `proc-supervisor-kit

  node src/cli.ts watch <config.json> [--once] [--dry-run] [--verbose]
      сторож: раз в intervalSec проверяет процессы, пульс и логи
      --once     один проход; код 0 — всё в порядке, 1 — есть проблемы
      --dry-run  ничего не снимать, не запускать и не писать в файлы, только печатать
  node src/cli.ts check <config.json>
      проверить конфиг
  node src/cli.ts ps <regex> [--image node] [--count]
      процессы, чья командная строка совпала
  node src/cli.ts kill <regex> [--image node] [--force] [--dry-run] [--max N]
      снять такие процессы (кроме самого себя и родителя); выражение, совпадающее
      с пустой строкой, — ошибка; совпало больше N (по умолчанию 10) — ничего не снимает
  node src/cli.ts spawn [--cwd dir] -- <command> [args...]
      запустить отвязанно, без окна; печатает pid
  node src/cli.ts beat <file> [--max-age sec] [--newer-than ms] [--wait sec]
      свежий ли пульс; --wait — ждать до N секунд
  node src/cli.ts scrub-logs --to <dir> [--values-from env]... [--pattern re]... [--keep] [--dry-run] -- <files...>
      вычистить секреты из логов и переложить их в dir

  Общее: --procs-from <file.json> (или PSK_PROCS_FROM) — взять список процессов из файла, для тестов.
  Коды выхода: 0 — успех, 1 — проблема, 2 — ошибка запуска или конфига, 3 — уже запущен другой сторож.
`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fail(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

const COMMON = { 'procs-from': { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
  } catch (e) { return fail(`${(e as Error).message}\n\n${USAGE}`); }
}

function regex(s: string | undefined): RegExp {
  if (!s) fail(`нужно регулярное выражение\n\n${USAGE}`);
  try { return new RegExp(s); } catch (e) { return fail(`плохое регулярное выражение: ${(e as Error).message}`); }
}

async function cmdWatch(args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { once: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, verbose: { type: 'boolean' } });
  const file = positionals[0] ?? fail(`нужен файл конфига\n\n${USAGE}`);
  const cfg = loadConfig(file);
  const dryRun = Boolean(v['dry-run']);
  const once = Boolean(v.once);
  if (!dryRun && !once) {
    const lockFile = path.join(cfg.dir, `${path.basename(file, path.extname(file))}.watchdog.lock`);
    const lock = takeLock(lockFile);
    if (!lock) { process.stderr.write(`сторож с этим конфигом уже запущен (${path.basename(lockFile)})\n`); return EXIT_ALREADY_RUNNING; }
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(s, () => process.exit(0));
  }
  const procsFrom = v['procs-from'];
  const wd = new Watchdog(cfg, {
    listProcesses: () => listProcesses({ procsFrom }),
    kill: pid => killPid(pid),
    start: spawnDetached,
    dryRun,
    verbose: once || Boolean(v.verbose),
  });
  if (once) {
    const r = await wd.tick();
    wd.info(wd.summaryLine());
    return r.problems > 0 ? 1 : 0;
  }
  wd.info(`старт сторожа: процессов ${cfg.processes.length}, интервал ${cfg.intervalSec} с${dryRun ? ', сухой прогон' : ''}`);
  for (;;) {
    try { await wd.tick(); } catch (e) { wd.info(`ошибка тика: ${(e as Error).message}`); }
    await sleep(cfg.intervalSec * 1000);
  }
}

function cmdCheck(args: string[]): number {
  const { positionals } = parse(args, {});
  const file = positionals[0] ?? fail(`нужен файл конфига\n\n${USAGE}`);
  const cfg = loadConfig(file);
  process.stdout.write(`конфиг в порядке: ${cfg.processes.map(p => p.name).join(', ')}\n`);
  return 0;
}

/** Совпавшие процессы, кроме себя и своих предков: оболочка, что нас вызвала, может нести то же выражение в командной строке. */
function findOthers(procs: ProcInfo[], match: RegExp, image: string | undefined): ProcInfo[] {
  return findProcesses(procs, { match, image, skipPids: [process.pid, process.ppid, ...ancestorPids(procs, process.pid)] });
}

function cmdPs(args: string[]): number {
  const { values: v, positionals } = parse(args, { image: { type: 'string' }, count: { type: 'boolean' } });
  const found = findOthers(listProcesses({ procsFrom: v['procs-from'] }), regex(positionals[0]), v.image);
  if (v.count) process.stdout.write(`${found.length}\n`);
  else for (const p of found) process.stdout.write(`${p.pid}\t${p.name}\t${p.cmd}\n`);
  return 0;
}

function cmdKill(args: string[]): number {
  const { values: v, positionals } = parse(args, { image: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, max: { type: 'string' } });
  const re = regex(positionals[0]);
  // Защита от небрежного шаблона: «.*», «x?» и т. п. совпадают с любой командной строкой.
  if (re.test('')) fail(`kill: выражение «${re.source}» совпадает с пустой строкой, то есть с любым процессом — ничего не снимаю`);
  const max = Number(v.max ?? 10);
  if (!Number.isInteger(max) || max < 1) fail('--max — целое число ≥ 1');
  const found = findOthers(listProcesses({ procsFrom: v['procs-from'] }), re, v.image);
  if (found.length > max) {
    fail(`kill: совпало ${found.length} процессов, больше --max ${max}: шаблон слишком общий, ничего не снимаю\n${found.map(p => `  ${p.pid}\t${p.name}\t${p.cmd}`).join('\n')}`);
  }
  let failed = 0;
  for (const p of found) {
    if (v['dry-run']) { process.stdout.write(`[dry-run] снял бы pid ${p.pid} ${p.name}\n`); continue; }
    try { killPid(p.pid, Boolean(v.force)); process.stdout.write(`снят pid ${p.pid} ${p.name}\n`); } catch (e) { failed++; process.stdout.write(`не снят pid ${p.pid}: ${(e as Error).message}\n`); }
  }
  if (found.length === 0) process.stdout.write('совпадений нет\n');
  return failed ? 1 : 0;
}

async function cmdSpawn(args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { cwd: { type: 'string' } });
  const [command, ...rest] = positionals;
  if (!command) fail(`нужна команда\n\n${USAGE}`);
  const pid = await spawnDetached({ command, args: rest, cwd: v.cwd });
  process.stdout.write(`${pid}\n`);
  return 0;
}

async function cmdBeat(args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { 'max-age': { type: 'string' }, 'newer-than': { type: 'string' }, wait: { type: 'string' } });
  const file = positionals[0] ?? fail(`нужен файл пульса\n\n${USAGE}`);
  const maxAge = v['max-age'] !== undefined ? Number(v['max-age']) : null;
  const newer = v['newer-than'] !== undefined ? Number(v['newer-than']) : null;
  const waitSec = Number(v.wait ?? 0);
  if ([maxAge, newer, waitSec].some(x => x !== null && !Number.isFinite(x))) fail('--max-age, --newer-than и --wait — числа');
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const t = heartbeatTime(file);
    const ok = t !== null && (newer === null || t > newer) && (maxAge === null || (Date.now() - t) / 1000 <= maxAge);
    if (ok) { process.stdout.write(`пульс свежий: ${Math.round((Date.now() - t!) / 1000)} с назад\n`); return 0; }
    if (Date.now() >= deadline) {
      process.stdout.write(t === null ? 'пульса нет\n' : `пульс несвежий: ${Math.round((Date.now() - t) / 1000)} с назад\n`);
      return 1;
    }
    await sleep(1000);
  }
}

function cmdScrubLogs(args: string[]): number {
  const { values: v, positionals } = parse(args, {
    to: { type: 'string' }, 'values-from': { type: 'string', multiple: true }, pattern: { type: 'string', multiple: true },
    keep: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  });
  if (!v.to) fail(`нужен --to <dir>\n\n${USAGE}`);
  const values: string[] = [];
  for (const f of (v['values-from'] as string[] | undefined) ?? []) {
    if (fs.existsSync(f)) values.push(...loadEnvValues(f));
    else process.stdout.write(`нет файла ${path.basename(f)} — его значения не вычищаются\n`);
  }
  let rules = DEFAULT_RULES;
  try { rules = [...DEFAULT_RULES, ...userRules((v.pattern as string[] | undefined) ?? [])]; } catch (e) { fail(`плохой --pattern: ${(e as Error).message}`); }
  const reports = scrubFiles(positionals, { to: v.to, rules, values, keep: Boolean(v.keep), dryRun: Boolean(v['dry-run']) });
  const prefix = v['dry-run'] ? '[dry-run] ' : '';
  for (const r of reports) process.stdout.write(`${prefix}${r.file} → ${r.dest} (замен: ${r.replaced})\n`);
  if (reports.length === 0) process.stdout.write(`${prefix}логов нет — нечего перекладывать\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (rest.includes('--help') || rest.includes('-h') || cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }
  switch (cmd) {
    case 'watch': return cmdWatch(rest);
    case 'check': return cmdCheck(rest);
    case 'ps': return cmdPs(rest);
    case 'kill': return cmdKill(rest);
    case 'spawn': return cmdSpawn(rest);
    case 'beat': return cmdBeat(rest);
    case 'scrub-logs': return cmdScrubLogs(rest);
    default: process.stderr.write(USAGE); return 2;
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
  if (e instanceof ConfigError) { process.stderr.write(`${e.problems.map(p => `конфиг: ${p}`).join('\n')}\n`); process.exitCode = 2; return; }
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exitCode = 2;
});
