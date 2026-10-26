import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Alerter, dedupKey, timesRu } from '../src/alerts.ts';

function setup(windowMs = 600_000) {
  let now = 1_000_000;
  const out: string[] = [];
  const a = new Alerter({ windowMs, now: () => now, sink: t => out.push(t) });
  return { a, out, advance: (ms: number) => { now += ms; } };
}

test('одинаковый алерт внутри окна подавляется, после окна уходит со счётчиком повторов', () => {
  const { a, out, advance } = setup();
  assert.equal(a.alert('нет пульса'), true);
  advance(60_000); assert.equal(a.alert('нет пульса'), false);
  advance(60_000); assert.equal(a.alert('нет пульса'), false);
  assert.deepEqual(out, ['нет пульса']);
  advance(600_000);
  assert.equal(a.alert('нет пульса'), true);
  assert.deepEqual(out, ['нет пульса', 'нет пульса (повторилось 2 раза)']);
  assert.equal(a.suppressedTotal, 2);
});

test('числа не мешают дедупликации, разные тексты — разные алерты', () => {
  const { a, out } = setup();
  a.alert('worker: нет пульса 12 мин');
  a.alert('worker: нет пульса 13 мин');
  a.alert('other: нет пульса 13 мин');
  assert.deepEqual(out, ['worker: нет пульса 12 мин', 'other: нет пульса 13 мин']);
  assert.equal(dedupKey('pid 123, 4.5 с'), 'pid #, # с');
});

test('flush сообщает число повторов, даже если алерт больше не приходил', () => {
  const { a, out, advance } = setup(10_000);
  a.alert('x'); a.alert('x'); a.alert('x'); a.alert('x'); a.alert('x');
  advance(5_000); a.flush();
  assert.deepEqual(out, ['x']);
  advance(5_000); a.flush();
  assert.equal(out.length, 2);
  assert.match(out[1]!, /^x \(повторилось 4 раза за \d+ мин\)$/);
  advance(1); a.alert('x');
  assert.deepEqual(out.slice(2), ['x'], 'после flush окно начинается заново, без двойного счёта');
});

test('без повторов flush молчит; окно 0 — без дедупликации', () => {
  const { a, out, advance } = setup(0);
  a.alert('y'); a.alert('y'); advance(1); a.flush();
  assert.deepEqual(out, ['y', 'y']);
});

test('многострочный текст становится одной строкой', () => {
  const { a, out } = setup();
  a.alert('a\nb\r\nc');
  assert.deepEqual(out, ['a | b | c']);
});

test('склонение «раз»', () => {
  assert.equal(timesRu(1), '1 раз');
  assert.equal(timesRu(2), '2 раза');
  assert.equal(timesRu(5), '5 раз');
  assert.equal(timesRu(12), '12 раз');
  assert.equal(timesRu(22), '22 раза');
  assert.equal(timesRu(111), '111 раз');
});
