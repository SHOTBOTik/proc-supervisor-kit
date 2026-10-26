// Файл пульса: процесс раз в цикл пишет в него текущее время. Сторож читает его возраст.
import fs from 'node:fs';
import path from 'node:path';

/** Время последнего пульса, мс от эпохи: число из файла (мс или секунды) или ISO-время, иначе время изменения файла. Нет файла — null. */
export function heartbeatTime(file: string): number | null {
  let text: string, st: fs.Stats;
  try { st = fs.statSync(file); text = fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const v = Number(text);
    if (v >= 1e12 && v < 1e14) return Math.floor(v); // миллисекунды
    if (v >= 1e9 && v < 1e11) return Math.floor(v * 1000); // секунды
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) { // ISO-время
    const iso = Date.parse(text);
    if (Number.isFinite(iso)) return iso;
  }
  return st.mtimeMs;
}

/** Возраст пульса в секундах; время из будущего (часы сбились) считается нулём. */
export function heartbeatAgeSec(file: string, now = Date.now()): number | null {
  const t = heartbeatTime(file);
  return t === null ? null : Math.max(0, (now - t) / 1000);
}

/** Записать пульс атомарно: во временный файл и переименованием на место — сторож не прочтёт половину. */
export function writeHeartbeat(file: string, now = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, String(now));
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, String(now)); fs.rmSync(tmp, { force: true }); }
}
