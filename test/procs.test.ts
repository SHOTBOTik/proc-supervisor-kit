import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ancestorPids, findProcesses, imageMatches, isInlineShell, listProcesses, parseCimJson, parseEtime, parsePs } from '../src/procs.ts';
import { ROOT } from './helpers.ts';

test('разбор вывода CIM: массив, одиночный объект, сырые управляющие символы', () => {
  const raw = '[{"pid":10,"name":"node.exe","cmd":"node a.js\tb","started":1700000000000},{"pid":11,"name":"System","cmd":null,"started":null}]';
  const list = parseCimJson(raw);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { pid: 10, ppid: null, name: 'node.exe', cmd: 'node a.js b', startedAt: 1700000000000 });
  assert.equal(list[1]?.cmd, null);
  assert.deepEqual(parseCimJson('{"pid":5,"name":"bash.exe","cmd":"bash x.sh"}').map(p => p.pid), [5]);
  assert.deepEqual(parseCimJson(''), []);
});

test('разбор ps и etime', () => {
  assert.equal(parseEtime('05:03'), 303);
  assert.equal(parseEtime('1:00:00'), 3600);
  assert.equal(parseEtime('2-00:00:01'), 172801);
  assert.equal(parseEtime('bad'), null);
  const now = 1_000_000_000;
  const list = parsePs('  101     7   01:40 /usr/bin/node worker.js --x\n    7     1 3-01:00:00 bash run-forever.sh node worker.js\n', now);
  assert.deepEqual(list[0], { pid: 101, ppid: 7, name: 'node', cmd: '/usr/bin/node worker.js --x', startedAt: now - 100_000 });
  assert.equal(list[1]?.name, 'bash');
});

test('образ: node совпадает с node.exe без учёта регистра', () => {
  assert.ok(imageMatches('NODE.EXE', 'node'));
  assert.ok(imageMatches('node', 'node.exe'));
  assert.ok(!imageMatches('nodemon', 'node'));
});

test('поиск: совпадение, исключение, свои pid, невидимые командные строки', () => {
  const procs = [
    { pid: 1, name: 'node.exe', cmd: 'node worker.js' },
    { pid: 2, name: 'node.exe', cmd: 'node worker.js --once' },
    { pid: 3, name: 'node.exe', cmd: null },
    { pid: 4, name: 'node.exe', cmd: 'node worker.js' },
  ];
  const found = findProcesses(procs, { match: /worker\.js/, image: 'node', exclude: /--once/, skipPids: [4] });
  assert.deepEqual(found.map(p => p.pid), [1]);
});

test('список из файла (PSK_PROCS_FROM / procsFrom) — без обращения к системе', () => {
  const list = listProcesses({ procsFrom: path.join(ROOT, 'test', 'fixtures', 'procs.sample.json') });
  assert.deepEqual(list.map(p => p.pid), [1001, 1002, 1003]);
});

test('предки: своя оболочка с тем же выражением в командной строке не снимается', () => {
  const procs = [
    { pid: 50, ppid: 1, name: 'bash.exe', cmd: 'bash -c "node cli.ts kill worker"' },
    { pid: 60, ppid: 50, name: 'node.exe', cmd: 'node cli.ts kill worker' },
    { pid: 70, ppid: 1, name: 'node.exe', cmd: 'node worker.js' },
    { pid: 1, ppid: 60, name: 'init', cmd: 'init' },
  ];
  assert.deepEqual(ancestorPids(procs, 60), [60, 50, 1], 'цикл в родителях не зацикливает');
  const found = findProcesses(procs, { match: /worker/, skipPids: ancestorPids(procs, 60) });
  assert.deepEqual(found.map(p => p.pid), [70]);
});

test('оболочки с командой в строке не считаются: в их тексте выражение — просто текст', () => {
  for (const cmd of [
    'bash -c "node cli.ts kill worker"',
    String.raw`"C:\Program Files\Git\usr\bin\bash.exe" -c "bash run-forever.sh node worker.js"`,
    '/bin/sh -lc "pkill worker"',
    'bash --login -c "x worker.js"',
    'cmd.exe /d /c "node worker.js"',
    'powershell.exe -NoProfile -Command "Get-Process worker"',
    'pwsh -c worker.js',
  ]) assert.ok(isInlineShell(cmd), cmd);
  for (const cmd of [
    'bash run-forever.sh --log w.log -- node worker.js',
    String.raw`"C:\Program Files\Git\usr\bin\bash.exe" ../run-forever.sh -- node worker.js`,
    'bash --rcfile x.rc run-forever.sh',
    'node worker.js -c 5',
    String.raw`C:\tools\crash.exe -c`,
  ]) assert.ok(!isInlineShell(cmd), cmd);
  const procs = [
    { pid: 1, name: 'bash.exe', cmd: 'bash -c "bash run-forever.sh worker.js"' },
    { pid: 2, name: 'bash.exe', cmd: 'bash run-forever.sh worker.js' },
  ];
  assert.deepEqual(findProcesses(procs, { match: /run-forever\.sh.*worker/ }).map(p => p.pid), [2]);
  assert.deepEqual(findProcesses(procs, { match: /run-forever\.sh.*worker/, includeInlineShells: true }).map(p => p.pid), [1, 2]);
});
