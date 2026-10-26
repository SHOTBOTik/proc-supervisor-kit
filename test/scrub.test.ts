// Все «секреты» здесь — заведомо фальшивые строки для проверки правил.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadEnvValues, scrubFiles, scrubText, userRules, DEFAULT_RULES } from '../src/scrub.ts';
import { tmpDir } from './helpers.ts';

const fake = (prefix: string, n: number) => prefix + 'x'.repeat(n);
// заголовок PEM собирается по частям, чтобы сам тест не выглядел как ключ для сканеров
const pemLine = (kind: string) => '-----' + kind + ' PRIVATE' + ' KEY-----';

test('встроенные правила: присваивания, заголовки, пароль в URL, ключи', () => {
  const lines = [
    `api_key=${fake('k', 20)}`,
    `"password": "${fake('p', 10)}"`,
    `Authorization: Bearer ${fake('t', 30)}`,
    `connect postgres://user:${fake('s', 8)}@db/app`,
    [pemLine('BEGIN'), fake('m', 40), pemLine('END')].join('\n'),
    `token: ${fake('ghp_', 36)}`,
  ];
  const { text, replaced } = scrubText(lines.join('\n'));
  assert.ok(replaced >= 6, `замен ${replaced}`);
  assert.doesNotMatch(text, /xxxxxxxx/);
  assert.match(text, /api_key=\[REDACTED\]/);
  assert.match(text, /postgres:\/\/user:\[REDACTED\]@db/);
  assert.match(text, /Bearer \[REDACTED\]/);
});

test('обычный текст не трогается', () => {
  const s = 'цикл 42: задач 3, пауза 5 с; token = getToken()';
  const { text } = scrubText('цикл 42: задач 3, пауза 5 с');
  assert.equal(text, 'цикл 42: задач 3, пауза 5 с');
  assert.ok(scrubText(s).text.startsWith('цикл 42'));
});

test('точные значения из env-файла и свои регулярки', () => {
  const dir = tmpDir();
  const env = path.join(dir, 'app.env');
  fs.writeFileSync(env, `# комментарий\nSERVICE_KEY="${fake('v', 12)}"\nSHORT=abc\nexport OTHER=${fake('w', 9)}\n`);
  const values = loadEnvValues(env);
  assert.equal(values.length, 2, 'короткие значения не берутся');
  const { text, replaced } = scrubText(`got ${fake('v', 12)} and ${fake('w', 9)} id=ACC-12345`, [...DEFAULT_RULES, ...userRules(['ACC-\\d+'])], values);
  assert.equal(text, 'got [REDACTED] and [REDACTED] id=[REDACTED]');
  assert.equal(replaced, 3);
});

test('scrubFiles: копия в архив вычищена, исходник удалён, отсутствующие пропущены, dry-run ничего не пишет', () => {
  const dir = tmpDir();
  const log = path.join(dir, 'app.log');
  fs.writeFileSync(log, `secret=${fake('z', 16)}\nok\n`);
  const to = path.join(dir, 'archive', 'logs');
  const dry = scrubFiles([log, path.join(dir, 'missing.log')], { to, dryRun: true });
  assert.equal(dry.length, 1);
  assert.equal(dry[0]?.replaced, 1);
  assert.equal(fs.existsSync(to), false);
  assert.ok(fs.existsSync(log));
  scrubFiles([log], { to });
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.readFileSync(path.join(to, 'app.log'), 'utf8'), 'secret=[REDACTED]\nok\n');
  assert.deepEqual(scrubFiles([log], { to }), [], 'повторный запуск — ничего не делает');
});
