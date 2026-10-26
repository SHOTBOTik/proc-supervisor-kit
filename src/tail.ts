// Хвост чужого лога: отдаёт только новые полные строки. Замечает усечение и ротацию — тогда читает файл с начала.
// Признаки: файл стал короче прочитанного; под тем же именем другой файл (inode); изменились первые байты файла
// (усекли и успели дописать больше, чем было).
import fs from 'node:fs';

export interface LogTailOptions {
  /** Читать с начала файла, а не с текущего конца (по умолчанию — с конца: старое не алертим). */
  fromStart?: boolean;
  /** Больше этого за раз не читаем: при отставании перескакиваем к концу. */
  maxChunk?: number;
}

const HEAD_BYTES = 64;

export class LogTail {
  readonly file: string;
  private readonly maxChunk: number;
  private pos = 0;
  private ino: bigint | null = null;
  private head: Buffer = Buffer.alloc(0);
  private rest: Buffer = Buffer.alloc(0);
  /** Сколько раз замечено усечение или ротация. */
  resets = 0;
  /** Сколько байт пропущено из-за отставания. */
  skippedBytes = 0;

  constructor(file: string, o: LogTailOptions = {}) {
    this.file = file;
    this.maxChunk = o.maxChunk ?? 1024 * 1024;
    const st = this.stat();
    if (st) {
      this.ino = st.ino;
      this.head = this.readAt(0, Math.min(HEAD_BYTES, Number(st.size)));
      if (!o.fromStart) this.pos = Number(st.size);
    }
  }

  private stat(): fs.BigIntStats | null {
    try { return fs.statSync(this.file, { bigint: true }); } catch { return null; }
  }

  private readAt(pos: number, len: number): Buffer {
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { return buf.subarray(0, fs.readSync(fd, buf, 0, len, pos)); } finally { fs.closeSync(fd); }
  }

  private reset(): void { this.pos = 0; this.rest = Buffer.alloc(0); this.head = Buffer.alloc(0); this.resets++; }

  read(): string[] {
    const st = this.stat();
    if (!st) { this.pos = 0; this.ino = null; this.head = Buffer.alloc(0); this.rest = Buffer.alloc(0); return []; }
    const size = Number(st.size);
    const rotated = this.ino !== null && st.ino !== 0n && st.ino !== this.ino;
    this.ino = st.ino;
    if (rotated || size < this.pos) this.reset();
    else if (this.head.length > 0 && !this.readAt(0, this.head.length).equals(this.head)) this.reset();
    if (this.head.length < HEAD_BYTES && size > this.head.length) this.head = this.readAt(0, Math.min(HEAD_BYTES, size));
    if (size === this.pos) return [];
    let dropFirst = false;
    if (size - this.pos > this.maxChunk) {
      this.skippedBytes += size - this.maxChunk - this.pos;
      this.pos = size - this.maxChunk; this.rest = Buffer.alloc(0); dropFirst = true;
    }
    const chunk = this.readAt(this.pos, size - this.pos);
    this.pos += chunk.length;
    const buf = Buffer.concat([this.rest, chunk]);
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) { this.rest = buf.length > this.maxChunk ? Buffer.alloc(0) : buf; return []; }
    this.rest = Buffer.from(buf.subarray(nl + 1));
    const lines = buf.subarray(0, nl).toString('utf8').split('\n').map(l => l.replace(/\r$/, ''));
    if (dropFirst) lines.shift(); // начало первой строки осталось в пропущенном куске
    return lines.filter(l => l.length > 0);
  }
}
