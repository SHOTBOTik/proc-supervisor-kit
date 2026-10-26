import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { heartbeatAgeSec, heartbeatTime, writeHeartbeat } from '../src/heartbeat.ts';
import { tmpDir } from './helpers.ts';

const NOW = 1_800_000_000_000;

test('пульс: мс, секунды, ISO; нет файла — null', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.hb');
  assert.equal(heartbeatTime(f), null);
  assert.equal(heartbeatAgeSec(f, NOW), null);
  fs.writeFileSync(f, String(NOW - 30_000));
  assert.equal(heartbeatAgeSec(f, NOW), 30);
  fs.writeFileSync(f, String((NOW - 90_000) / 1000));
  assert.equal(heartbeatAgeSec(f, NOW), 90);
  fs.writeFileSync(f, new Date(NOW - 5_000).toISOString() + '\n');
  assert.equal(heartbeatAgeSec(f, NOW), 5);
});

test('протухание: возраст растёт, пульс из будущего — ноль', () => {
  const f = path.join(tmpDir(), 'b.hb');
  writeHeartbeat(f, NOW);
  assert.equal(heartbeatAgeSec(f, NOW + 61_000), 61);
  assert.equal(heartbeatAgeSec(f, NOW - 10_000), 0);
  assert.equal(fs.existsSync(`${f}.tmp`), false, 'временный файл не остаётся');
});

test('непонятное содержимое — берётся время изменения файла', () => {
  const f = path.join(tmpDir(), 'c.hb');
  fs.writeFileSync(f, 'ok');
  const t = (NOW - 120_000) / 1000;
  fs.utimesSync(f, t, t);
  assert.equal(Math.round(heartbeatAgeSec(f, NOW)!), 120);
});
