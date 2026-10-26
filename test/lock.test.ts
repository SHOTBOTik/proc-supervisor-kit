import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { takeLock } from '../src/lock.ts';
import { tmpDir } from './helpers.ts';

test('замок: взять, занят живым — null, протух — перехватить, снять', () => {
  const f = path.join(tmpDir(), 'w.lock');
  const lock = takeLock(f);
  assert.ok(lock);
  assert.equal(fs.readFileSync(f, 'utf8'), String(process.pid));
  lock.release();
  assert.equal(fs.existsSync(f), false);

  fs.writeFileSync(f, '999999');
  assert.equal(takeLock(f, { isAlive: () => true }), null, 'чужой живой pid — второй экземпляр не стартует');
  assert.equal(fs.readFileSync(f, 'utf8'), '999999', 'чужой замок не тронут');

  const stolen = takeLock(f, { isAlive: () => false });
  assert.ok(stolen, 'мёртвый pid — замок протух');
  assert.equal(fs.readFileSync(f, 'utf8'), String(process.pid));
  stolen.release();
});

test('замок с мусором внутри считается протухшим', () => {
  const f = path.join(tmpDir(), 'g.lock');
  fs.writeFileSync(f, 'не число');
  const lock = takeLock(f, { isAlive: () => true });
  assert.ok(lock);
  lock.release();
});

test('release не трогает чужой замок', () => {
  const f = path.join(tmpDir(), 'o.lock');
  const lock = takeLock(f)!;
  fs.writeFileSync(f, '12345');
  lock.release();
  assert.equal(fs.readFileSync(f, 'utf8'), '12345');
});
