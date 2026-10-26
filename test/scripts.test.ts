// Скрипты bash: синтаксис и дымовые прогоны. Запускаются только фейковые процессы (node -e …).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, tmpDir } from './helpers.ts';

const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
const hasBash = probe.status === 0 && probe.stdout.trim() === 'ok';
const skip = hasBash ? false : 'bash не найден в PATH — скрипты не проверить';
/** bash в Windows понимает пути с прямыми слэшами. */
const fwd = (p: string) => p.replace(/\\/g, '/');
const script = (name: string) => fwd(path.join(ROOT, name));

function bash(args: string[], env: Record<string, string> = {}, timeout = 30_000) {
  return spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout });
}

for (const name of ['run-forever.sh', 'deploy.sh']) {
  test(`bash -n ${name}`, { skip }, () => {
    const r = bash(['-n', script(name)]);
    assert.equal(r.status, 0, r.stderr);
  });
}

test('run-forever.sh: код 3 — обёртка выходит и не перезапускает', { skip }, () => {
  const log = fwd(path.join(tmpDir(), 'w.log'));
  const r = bash([script('run-forever.sh'), '--log', log, '--name', 'fake', '--', 'node', '-e', 'console.log("фейк работает"); process.exit(3)']);
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0]!, /\[run-forever\] fake: старт: node -e/);
  assert.equal(lines[1], 'фейк работает');
  assert.match(lines[2]!, /fake: стоп: код 3 .*обёртка выходит/);
});

test('run-forever.sh: падение — перезапуск с растущей паузой до предела, потом код 3', { skip }, () => {
  const dir = tmpDir();
  const log = fwd(path.join(dir, 'w.log'));
  const counter = fwd(path.join(dir, 'count'));
  // фейк: первые три запуска падают с кодом 1, четвёртый выходит с кодом 3
  const fake = 'const fs=require("fs");const f=process.argv[1];let n=0;try{n=+fs.readFileSync(f,"utf8")}catch{};fs.writeFileSync(f,String(n+1));process.exit(n>=3?3:1)';
  const t0 = Date.now();
  const r = bash([script('run-forever.sh'), '--log', log, '--', 'node', '-e', fake, counter], { RF_MIN_DELAY: '0', RF_MAX_DELAY: '1', RF_RESET_AFTER: '60' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '4');
  const text = fs.readFileSync(log, 'utf8');
  assert.equal(text.match(/: старт: /g)?.length, 4);
  assert.deepEqual([...text.matchAll(/перезапуск через (\d+) с/g)].map(m => m[1]), ['0', '1', '1'], 'пауза растёт и упирается в RF_MAX_DELAY');
  assert.ok(Date.now() - t0 < 20_000);
});

test('run-forever.sh: без команды — код 2 и подсказка', { skip }, () => {
  const r = bash([script('run-forever.sh')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run-forever\.sh \[--log FILE\]/);
});

test('deploy.sh --dry-run: все шаги по порядку, ничего не меняется', { skip }, () => {
  const procs = fwd(path.join(ROOT, 'test', 'fixtures', 'procs.empty.json'));
  const before = fs.readdirSync(path.join(ROOT, 'examples')).sort();
  const r = bash([script('deploy.sh'), '--config', script('examples/deploy.conf'), '--dry-run'], { PSK_PROCS_FROM: procs }, 60_000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  let pos = -1;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const at = r.stdout.indexOf(`== ${n}. `);
    assert.ok(at > pos, `шаг ${n} на месте и по порядку`);
    pos = at;
  }
  assert.match(r.stdout, /\[dry-run\] DRY=1 node worker\.js --once/);
  assert.match(r.stdout, /сухой прогон окончен, ничего не изменено/);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'examples')).sort(), before, 'в examples/ ничего не появилось');
});

test('deploy.sh --dry-run с examples/deploy.conf: снимает сторожа вместе с обёрткой, редактор не трогает', { skip }, () => {
  // запуск как в README: сторож и worker — каждый под run-forever.sh (у bash после fork две копии с одной командной строкой)
  const procs = fwd(path.join(ROOT, 'test', 'fixtures', 'procs.readme.json'));
  const r = bash([script('deploy.sh'), '--config', script('examples/deploy.conf'), '--dry-run'], { PSK_PROCS_FROM: procs }, 60_000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pids = [...r.stdout.matchAll(/снял бы pid (\d+)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual(pids, [2001, 2002, 2003, 2004, 2005], r.stdout);
});

test('deploy.sh: процессы не остановились — стоп до любых изменений', { skip }, () => {
  const dir = tmpDir();
  // процесс, который «не снимается»: он есть только в подменённом списке; pid 2147483001 не бывает ни в Windows (там pid кратны 4), ни в Linux — kill его не найдёт
  const procs = path.join(dir, 'procs.json');
  fs.writeFileSync(procs, JSON.stringify([{ pid: 2147483001, name: 'node.exe', cmd: 'node never-dies.js' }]));
  const conf = path.join(dir, 'deploy.conf');
  fs.writeFileSync(conf, "STOP_MATCH=( 'never-dies\\.js' )\nFILES=( app.js )\nSTOP_SETTLE=0\nSTART=( node app.js )\n");
  fs.writeFileSync(path.join(dir, 'app.js'), '');
  const r = bash([script('deploy.sh'), '--config', fwd(conf)], { PSK_PROCS_FROM: fwd(procs) }, 60_000);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /осталось процессов: 1/);
  assert.match(r.stdout, /СТОП: процессы не остановлены/);
  assert.equal(fs.existsSync(path.join(dir, 'archive')), false, 'бэкап не начат');
});

test('deploy.sh: неудача после бэкапа — команды отката с образом и кавычками разбираются bash обратно', { skip }, () => {
  const dir = tmpDir();
  const procs = fwd(path.join(ROOT, 'test', 'fixtures', 'procs.empty.json'));
  const re = String.raw`psk-no-such-'proc'\.js`;
  fs.writeFileSync(path.join(dir, 'deploy.conf'), [
    String.raw`STOP_MATCH=( "psk-no-such-'proc'\\.js" )`,
    'STOP_IMAGE=( node )',
    'FILES=( app.js )',
    'ENTRIES=( bad.js )',
    'STOP_SETTLE=0',
    `START=( node "app with 'space'.js" )`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.js'), '');
  fs.writeFileSync(path.join(dir, 'bad.js'), 'this is not javascript (');
  const r = bash([script('deploy.sh'), '--config', fwd(path.join(dir, 'deploy.conf'))], { PSK_PROCS_FROM: procs }, 60_000);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /СТОП: bad\.js не проходит node --check/);
  const lines = r.stdout.split('\n').map(l => l.trim());
  // строка подсказки — готовая команда: bash разбирает её на те же аргументы
  const argv = (line: string) => bash(['-c', `printf '%s\\n' ${line}`]).stdout.split('\n').slice(0, -1);
  const kill = argv(lines.find(l => l.startsWith('node ') && l.includes(' kill '))!);
  assert.deepEqual(kill.slice(2), ['kill', re, '--image', 'node']);
  const spawn = argv(lines.find(l => l.startsWith('node ') && l.includes(' spawn '))!);
  assert.deepEqual(spawn.slice(-3), ['--', 'node', "app with 'space'.js"]);
});
