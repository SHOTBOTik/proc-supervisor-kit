import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RotatingLog } from '../src/logfile.ts';
import { tmpDir } from './helpers.ts';

test('лог ротируется по размеру и держит не больше keep старых файлов', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'w.log');
  const log = new RotatingLog(f, { maxBytes: 200, keep: 2, now: () => 0 });
  for (let i = 0; i < 30; i++) log.write(`строка ${i} ${'x'.repeat(20)}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['w.log', 'w.log.1', 'w.log.2']);
  for (const name of files) assert.ok(fs.statSync(path.join(dir, name)).size <= 200, `${name} не больше предела`);
  const last = fs.readFileSync(f, 'utf8').trim().split('\n').pop()!;
  assert.match(last, /^1970-01-01T00:00:00\.000Z строка 29 x+$/);
  const prev = fs.readFileSync(`${f}.1`, 'utf8');
  assert.ok(prev.length > 0, 'в .1 лежит предыдущий кусок');
});

test('пока размер не превышен — ротации нет', () => {
  const f = path.join(tmpDir(), 'a.log');
  const log = new RotatingLog(f, { maxBytes: 10_000 });
  log.write('один'); log.write('два');
  assert.equal(log.rotateIfNeeded(), false);
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(fs.existsSync(`${f}.1`), false);
});

test('строка, которая одна больше предела, всё равно пишется', () => {
  const f = path.join(tmpDir(), 'b.log');
  const log = new RotatingLog(f, { maxBytes: 50 });
  log.write('z'.repeat(100));
  log.write('z'.repeat(100));
  assert.ok(fs.readFileSync(f, 'utf8').includes('z'.repeat(100)));
  assert.ok(fs.existsSync(`${f}.1`));
});
