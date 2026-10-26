// Лог с ротацией по размеру: file → file.1 → file.2 …, старше keep — удаляется.
import fs from 'node:fs';
import path from 'node:path';

export interface RotatingLogOptions {
  maxBytes?: number;
  /** Сколько старых файлов держать (file.1 … file.N). */
  keep?: number;
  now?: () => number;
}

export class RotatingLog {
  readonly file: string;
  readonly maxBytes: number;
  readonly keep: number;
  private readonly now: () => number;

  constructor(file: string, o: RotatingLogOptions = {}) {
    this.file = file;
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.keep = Math.max(1, o.keep ?? 2);
    this.now = o.now ?? Date.now;
  }

  /** Дописать строку с меткой времени UTC. */
  write(text: string): void {
    const line = `${new Date(this.now()).toISOString()} ${text.replace(/\r?\n/g, ' | ')}\n`;
    this.rotateIfNeeded(Buffer.byteLength(line));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, line);
  }

  rotateIfNeeded(incoming = 0): boolean {
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { return false; }
    if (size === 0 || size + incoming <= this.maxBytes) return false;
    try { fs.rmSync(`${this.file}.${this.keep}`, { force: true }); } catch { /* занят — перезапишется ниже */ }
    for (let i = this.keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch { /* такого ещё нет */ }
    }
    fs.renameSync(this.file, `${this.file}.1`);
    return true;
  }
}
