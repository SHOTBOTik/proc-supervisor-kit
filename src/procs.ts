// Список процессов, снятие и запуск. Windows — через CIM (Win32_Process), остальное — через ps.
// В PowerShell уходит только постоянный скрипт: ни одна строка из конфига или командной строки в него не вклеивается,
// фильтрация по регулярным выражениям идёт здесь, в JS.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  /** Имя образа: `node.exe` на Windows, `node` на POSIX. */
  name: string;
  /** Командная строка; `null`, если её не видно (процесс с другими правами). */
  cmd: string | null;
  /** Родитель, если известен. */
  ppid?: number | null;
  /** Время старта, мс от эпохи, если известно. */
  startedAt?: number | null;
}

export interface ListOptions {
  /** Взять список из JSON-файла вместо системы — для тестов и разбора. */
  procsFrom?: string;
  timeoutMs?: number;
}

const CIM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$list = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '  $t = $null',
  '  if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = $_.CommandLine; started = $t }',
  '})',
  'ConvertTo-Json -InputObject $list -Compress -Depth 2',
].join('\n');

/** Разобрать вывод CIM-скрипта. PowerShell 5.1 пропускает часть управляющих символов в CommandLine без экранирования — чистим до разбора. */
export function parseCimJson(out: string): ProcInfo[] {
  const clean = out.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!clean) return [];
  const raw: unknown = JSON.parse(clean);
  const items = Array.isArray(raw) ? raw : [raw];
  const result: ProcInfo[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const pid = Number(o.pid ?? o.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cmd = o.cmd ?? o.CommandLine;
    const started = o.started;
    const ppid = Number(o.ppid ?? o.ParentProcessId);
    result.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
      name: String(o.name ?? o.Name ?? ''),
      cmd: typeof cmd === 'string' ? cmd : null,
      startedAt: typeof started === 'number' ? started : null,
    });
  }
  return result;
}

/** `[[dd-]hh:]mm:ss` → секунды. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

/** Разобрать вывод `ps -A -o pid= -o ppid= -o etime= -o args=`. */
export function parsePs(out: string, now = Date.now()): ProcInfo[] {
  const result: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidS, ppidS, etime, args] = m as unknown as [string, string, string, string, string];
    const cmd = args.trim();
    const first = cmd.split(/\s+/)[0] ?? '';
    const secs = parseEtime(etime);
    result.push({
      pid: Number(pidS),
      ppid: Number(ppidS) || null,
      name: path.posix.basename(first),
      cmd: cmd || null,
      startedAt: secs === null ? null : now - secs * 1000,
    });
  }
  return result;
}

export function listProcesses(opts: ListOptions = {}): ProcInfo[] {
  const from = opts.procsFrom ?? process.env.PSK_PROCS_FROM;
  if (from) return parseCimJson(fs.readFileSync(from, 'utf8'));
  const timeout = opts.timeoutMs ?? 30000;
  if (process.platform === 'win32') {
    const encoded = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return parseCimJson(out);
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'etime=', '-o', 'args='], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  return parsePs(out);
}

/** `node` совпадает с `node.exe` и `NODE.EXE`. */
export function imageMatches(name: string, image: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '');
  return norm(name) === norm(image);
}

export interface FindOptions {
  match: RegExp;
  image?: string;
  exclude?: RegExp;
  /** Эти pid не считаются никогда: сам сторож, его родитель. */
  skipPids?: number[];
  /** Считать и оболочки с командой в строке (`bash -c "…"`, `cmd /c`, `powershell -Command`). По умолчанию нет. */
  includeInlineShells?: boolean;
}

/**
 * Оболочка, которой команда передана текстом: `bash -c "…"`, `sh -lc …`, `cmd /c …`, `powershell -Command …`.
 * В её командной строке искомое выражение встречается просто как текст — например, у терминала, из которого запустили
 * `kill`. Под Git Bash цепочка родителей Windows рвётся, и по предкам такую оболочку не отличить, поэтому их не считаем.
 */
export function isInlineShell(cmd: string): boolean {
  return INLINE_SHELLS.some(re => re.test(cmd));
}

/** Начало командной строки — исполняемый файл `name`: голый, с путём или с путём в кавычках (`"C:\Program Files\…\bash.exe"`). */
const exe = (name: string) => String.raw`^\s*(?:"(?:[^"]*[\\/])?${name}(?:\.exe)?"|(?:[^"\s]*[\\/])?${name}(?:\.exe)?)\s+`;
const INLINE_SHELLS = [
  new RegExp(exe('(?:ba|da|z|k)?sh') + String.raw`(?:-[a-z-]+\s+)*-[a-z]*c[a-z]*\s`, 'i'),
  new RegExp(exe('cmd') + String.raw`(?:\/[a-z]\s+)*\/[ck]\s`, 'i'),
  new RegExp(exe('(?:powershell|pwsh)') + String.raw`(?:.*\s)?-(?:c|command|encodedcommand|ec)\s`, 'i'),
];

/** pid и все его предки по списку. Их нельзя снимать: в командной строке оболочки, которая нас вызвала, может стоять то же регулярное выражение. */
export function ancestorPids(procs: ProcInfo[], pid: number): number[] {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out: number[] = [];
  let cur: number | null | undefined = pid;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return out;
}

export function findProcesses(procs: ProcInfo[], o: FindOptions): ProcInfo[] {
  const skip = new Set(o.skipPids ?? []);
  return procs.filter(p =>
    !skip.has(p.pid) &&
    p.cmd !== null &&
    (o.image === undefined || imageMatches(p.name, o.image)) &&
    o.match.test(p.cmd) &&
    !(o.exclude && o.exclude.test(p.cmd)) &&
    (o.includeInlineShells === true || !isInlineShell(p.cmd)));
}

/** Снять процесс. На Windows `process.kill` завершает его сразу (TerminateProcess), на POSIX шлёт сигнал. */
export function killPid(pid: number, force = false): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`плохой pid: ${pid}`);
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
}

export interface StartSpec {
  command: string;
  args?: string[];
  cwd?: string;
}

/** Запустить отвязанно от родителя: без оболочки, без окна, вывод в никуда (свой лог пишет обёртка или сам процесс). */
export function spawnDetached(spec: StartSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid ?? 0); });
  });
}
