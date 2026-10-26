import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LogTail } from '../src/tail.ts';
import { tmpDir } from './helpers.ts';

test('старое содержимое пропускается, отдаются только новые полные строки', () => {
  const f = path.join(tmpDir(), 'app.log');
  fs.writeFileSync(f, 'старая строка\n');
  const t = new LogTail(f);
  assert.deepEqual(t.read(), []);
  fs.appendFileSync(f, 'один\r\nдва\nнедопи');
  assert.deepEqual(t.read(), ['один', 'два']);
  fs.appendFileSync(f, 'санная\n');
  assert.deepEqual(t.read(), ['недописанная']);
  assert.deepEqual(t.read(), []);
});

test('усечение файла: стал короче — читаем заново с начала', () => {
  const f = path.join(tmpDir(), 'app.log');
  fs.writeFileSync(f, 'aaaa\nbbbb\ncccc\n');
  const t = new LogTail(f);
  fs.writeFileSync(f, 'новый\n');
  assert.deepEqual(t.read(), ['новый']);
  assert.equal(t.resets, 1);
});

test('усечение и перезапись длиннее прежнего — замечается по первым байтам', () => {
  const f = path.join(tmpDir(), 'app.log');
  fs.writeFileSync(f, 'a\nb\n');
  const t = new LogTail(f);
  fs.writeFileSync(f, 'совсем другой и длинный\n');
  assert.deepEqual(t.read(), ['совсем другой и длинный']);
  assert.equal(t.resets, 1);
  fs.appendFileSync(f, 'дальше\n');
  assert.deepEqual(t.read(), ['дальше']);
  assert.equal(t.resets, 1, 'обычная дозапись — не усечение');
});

test('ротация: под тем же именем другой файл, даже если он уже длиннее прежнего', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'app.log');
  fs.writeFileSync(f, 'x\n');
  const t = new LogTail(f);
  fs.renameSync(f, `${f}.1`);
  fs.writeFileSync(f, 'первая после ротации\nвторая после ротации\n');
  const lines = t.read();
  assert.deepEqual(lines, ['первая после ротации', 'вторая после ротации']);
});

test('файла нет — пусто; появился — читается с начала', () => {
  const f = path.join(tmpDir(), 'later.log');
  const t = new LogTail(f);
  assert.deepEqual(t.read(), []);
  fs.writeFileSync(f, 'привет\n');
  assert.deepEqual(t.read(), ['привет']);
});

test('отставание больше maxChunk: перескок к концу без обрывка первой строки', () => {
  const f = path.join(tmpDir(), 'big.log');
  fs.writeFileSync(f, '');
  const t = new LogTail(f, { maxChunk: 64 });
  fs.appendFileSync(f, Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join('\n') + '\n');
  const lines = t.read();
  assert.ok(lines.length > 0 && lines.length < 50);
  for (const l of lines) assert.match(l, /^line-\d{3}$/);
  assert.equal(lines.at(-1), 'line-049');
  assert.ok(t.skippedBytes > 0);
});

test('многобайтовые символы на границе чтения не ломаются', () => {
  const f = path.join(tmpDir(), 'utf.log');
  fs.writeFileSync(f, '');
  const t = new LogTail(f);
  const buf = Buffer.from('ёжик\n');
  fs.appendFileSync(f, buf.subarray(0, 1));
  assert.deepEqual(t.read(), []);
  fs.appendFileSync(f, buf.subarray(1));
  assert.deepEqual(t.read(), ['ёжик']);
});
