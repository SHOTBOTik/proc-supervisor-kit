// Замок от второго экземпляра: файл с pid, создаётся эксклюзивно (флаг 'wx').
// Если файл есть и его pid жив — второй экземпляр выходит с кодом 3, а run-forever.sh по коду 3 не перезапускает.
// Если pid мёртв — замок протух, его снимают и берут заново.
import fs from 'node:fs';
import path from 'node:path';
import { listProcesses } from './procs.ts';

export const EXIT_ALREADY_RUNNING = 3;

export interface LockOptions {
  /** Жив ли pid. По умолчанию — сигнал 0; с `match` — ещё и сверка командной строки (защита от повторно выданного pid). */
  isAlive?: (pid: number) => boolean;
  match?: RegExp;
}

export interface Lock { file: string; release(): void }

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Жив ли pid и похож ли он на наш процесс. Командной строки не видно (другие права) — считаем живым: лучше не запуститься, чем задвоиться. */
export function pidMatches(pid: number, match: RegExp): boolean {
  try {
    const p = listProcesses().find(x => x.pid === pid);
    return p !== undefined && (p.cmd === null || match.test(p.cmd));
  } catch { return pidAlive(pid); }
}

/** Взять замок. Вернёт null, если его держит живой процесс. */
export function takeLock(file: string, o: LockOptions = {}): Lock | null {
  const alive = o.isAlive ?? (o.match ? (pid: number) => pidMatches(pid, o.match!) : pidAlive);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return makeLock(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch { /* его как раз сняли */ }
      if (pid === process.pid) return makeLock(file);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
      try { fs.unlinkSync(file); } catch { /* сняли раньше нас */ }
    }
  }
  return null;
}

function makeLock(file: string): Lock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.unlinkSync(file); } catch { /* уже нет */ }
  };
  process.once('exit', release);
  return { file, release };
}

/** Взять замок или выйти с кодом 3. Заодно SIGINT/SIGTERM превращаются в обычный выход, чтобы замок снялся. */
export function lockOrExit(file: string, o: LockOptions = {}, say: (s: string) => void = s => process.stderr.write(s + '\n')): Lock {
  const lock = takeLock(file, o);
  if (!lock) {
    say(`уже запущен другой экземпляр (замок ${path.basename(file)}) — выхожу с кодом ${EXIT_ALREADY_RUNNING}`);
    process.exit(EXIT_ALREADY_RUNNING);
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(s, () => process.exit(0));
  return lock;
}
