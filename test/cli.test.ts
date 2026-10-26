// CLI на подменённых списках процессов (--procs-from): система не опрашивается, ничего не снимается.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, tmpDir } from './helpers.ts';

const CLI = path.join(ROOT, 'src', 'cli.ts');
const fixture = (n: string) => path.join(ROOT, 'test', 'fixtures', n);
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 });

test('check: пример конфига годен, плохой — код 2 и список проблем', () => {
  const ok = cli(['check', path.join(ROOT, 'examples', 'watchdog.json')]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /конфиг в порядке: worker/);
  const bad = path.join(tmpDir(), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ processes: [{ name: 'x', match: '(' }] }));
  const r = cli(['check', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /processes\[0\]\.match: плохое регулярное выражение/);
});

test('watch --once --dry-run: говорит, что запустил бы, файлов не пишет, код 1', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'wd.json');
  fs.writeFileSync(cfg, JSON.stringify({ processes: [{ name: 'fake', match: 'fake\\.js', start: { command: 'node', args: ['fake.js'] } }] }));
  const r = cli(['watch', cfg, '--once', '--dry-run', '--procs-from', fixture('procs.empty.json')]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /\[dry-run\] ALERT fake: нет ни процесса, ни обёртки/);
  assert.match(r.stdout, /\[dry-run\] запустил бы: fake: node fake\.js/);
  assert.match(r.stdout, /сводка: fake down/);
  assert.deepEqual(fs.readdirSync(dir), ['wd.json']);
});

test('watch --once: всё на месте — код 0', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'wd.json');
  fs.writeFileSync(cfg, JSON.stringify({ processes: [{ name: 'worker', match: 'worker\\.js', exclude: '--once' }] }));
  const r = cli(['watch', cfg, '--once', '--dry-run', '--procs-from', fixture('procs.sample.json')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /сводка: worker ok/);
});

test('ps и kill --dry-run на подменённом списке', () => {
  const env = { PSK_PROCS_FROM: fixture('procs.sample.json') };
  const ps = cli(['ps', 'worker\\.js', '--image', 'node', '--count'], env);
  assert.equal(ps.stdout.trim(), '2');
  const kill = cli(['kill', 'run-forever\\.sh', '--dry-run'], env);
  assert.equal(kill.status, 0);
  assert.equal(kill.stdout.trim(), '[dry-run] снял бы pid 1001 bash.exe');
});

test('kill: слишком общий шаблон — код 2, ничего не снято', () => {
  const env = { PSK_PROCS_FROM: fixture('procs.sample.json') };
  for (const re of ['.*', 'x?', '']) {
    const r = cli(['kill', re], env);
    assert.equal(r.status, 2, re);
    assert.doesNotMatch(r.stdout, /снят/);
  }
  const many = cli(['kill', 'worker', '--max', '2'], env);
  assert.equal(many.status, 2);
  assert.match(many.stderr, /совпало 3 процессов, больше --max 2/);
  assert.doesNotMatch(many.stdout, /снят/);
  const fine = cli(['kill', 'worker', '--max', '3', '--dry-run'], env);
  assert.equal(fine.status, 0, fine.stderr);
});

test('check: match, совпадающий с пустой строкой, — ошибка', () => {
  const bad = path.join(tmpDir(), 'any.json');
  fs.writeFileSync(bad, JSON.stringify({ processes: [{ name: 'x', match: '.*', wrapper: { match: 'a?' } }] }));
  const r = cli(['check', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /processes\[0\]\.match: совпадает с пустой строкой/);
  assert.match(r.stderr, /processes\[0\]\.wrapper\.match: совпадает с пустой строкой/);
});

test('beat: свежий, несвежий, отсутствующий пульс', () => {
  const f = path.join(tmpDir(), 'w.hb');
  assert.equal(cli(['beat', f]).status, 1);
  fs.writeFileSync(f, String(Date.now()));
  assert.equal(cli(['beat', f, '--max-age', '30']).status, 0);
  assert.equal(cli(['beat', f, '--newer-than', String(Date.now() + 60_000)]).status, 1);
  fs.writeFileSync(f, String(Date.now() - 120_000));
  assert.equal(cli(['beat', f, '--max-age', '60']).status, 1);
});

test('неизвестная команда — код 2 и справка', () => {
  const r = cli(['nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /node src\/cli\.ts watch/);
});
