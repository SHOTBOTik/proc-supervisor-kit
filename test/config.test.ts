import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig, resolveConfig, validateConfig } from '../src/config.ts';
import { ROOT } from './helpers.ts';

const base = () => ({ processes: [{ name: 'w', match: 'w\\.js' }] });

test('пример из examples/ проходит проверку, пути — от каталога конфига', () => {
  const file = path.join(ROOT, 'examples', 'watchdog.json');
  const cfg = loadConfig(file);
  const dir = path.dirname(file);
  assert.equal(cfg.processes.length, 1);
  const w = cfg.processes[0]!;
  assert.equal(w.heartbeat?.file, path.join(dir, 'worker.hb'));
  assert.equal(w.start?.cwd, dir);
  assert.equal(cfg.log, path.join(dir, 'watchdog.log'));
  assert.ok(w.match.test('node worker.js'));
  assert.ok(w.exclude?.test('node worker.js --once'));
});

test('умолчания', () => {
  const cfg = resolveConfig(base(), '/x');
  assert.equal(cfg.intervalSec, 60);
  assert.equal(cfg.dedupWindowSec, 600);
  const p = cfg.processes[0]!;
  assert.equal(p.image, 'node');
  assert.equal(p.wrapper, null);
  assert.equal(p.start, null);
});

test('минимальный конфиг годен', () => {
  assert.deepEqual(validateConfig(base()), []);
});

test('ошибки: всё перечислено, без падения на первой', () => {
  const problems = validateConfig({
    intervalSec: 0,
    extra: true,
    processes: [
      { name: 'a', match: '([' },
      { name: 'a', match: 'ok', heartbeat: { file: 'a.hb' }, start: { args: [1] }, typo: 1 },
      { match: 'x', tail: { alert: 'y' } },
    ],
  });
  const text = problems.join('\n');
  for (const needle of [
    'неизвестный ключ «extra»',
    'intervalSec: нужно число ≥ 1',
    'processes[0].match: плохое регулярное выражение',
    'processes[1].name: имя «a» уже есть',
    'processes[1].heartbeat.maxAgeSec: обязательно',
    'processes[1].start.command: обязательно',
    'processes[1].start.args: нужен массив строк',
    'processes[1]: неизвестный ключ «typo»',
    'processes[2].name: обязательно',
    'processes[2].tail.file: обязательно',
  ]) assert.ok(text.includes(needle), `ожидалось: ${needle}\nесть:\n${text}`);
});

test('пустой список процессов и не объект — ошибки', () => {
  assert.deepEqual(validateConfig([]), ['корень должен быть объектом']);
  assert.deepEqual(validateConfig({ processes: [] }), ['processes: нужен непустой массив']);
});

test('resolveConfig бросает ConfigError со списком проблем; битый JSON — тоже ConfigError', () => {
  assert.throws(() => resolveConfig({ processes: [{}] }, '.'), (e: unknown) => e instanceof ConfigError && e.problems.length >= 2);
  const f = path.join(ROOT, 'test', 'fixtures', 'broken.json');
  fs.writeFileSync(f, '{ "processes": [');
  try { assert.throws(() => loadConfig(f), ConfigError); } finally { fs.rmSync(f); }
});
