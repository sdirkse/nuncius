import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/spawn.js';
import { parseCursorJson } from '../src/runners/cursor.js';

const node = (script) => run(process.execPath, ['-e', script], { cwd: process.cwd() });

test('onLine: lines across chunks, the last line without a newline, and an oversized line dropped whole', async () => {
  const seen = [];
  // One line written in three pieces, a 9 MB line, then a last line with no newline after it.
  const script = `
    const w = (s) => new Promise((r) => process.stdout.write(s, r));
    (async () => {
      await w('{"a":'); await w('1}\\nsecond'); await w(' line\\n');
      await w('x'.repeat(9 * 1024 * 1024) + 'TAIL\\n');
      await w('last');
    })();`;
  const res = await run(process.execPath, ['-e', script], { cwd: process.cwd(), onLine: (l) => seen.push(l) });
  assert.equal(res.code, 0);
  assert.deepEqual(seen, ['{"a":1}', 'second line', 'last'], 'no part of the long line, not even its tail, is handed on');
});

test('onLine is optional and a throwing listener does not break the run', async () => {
  assert.equal((await node('console.log("x")')).stdout, 'x\n');
  const res = await run(process.execPath, ['-e', 'console.log("a"); console.log("b")'], { cwd: process.cwd(), onLine: () => { throw new Error('x'); } });
  assert.equal(res.code, 0);
});

test('parseCursorJson: the result event; without one, the last error object', () => {
  const events = (...e) => e.map((o) => JSON.stringify(o)).join('\n');
  assert.equal(parseCursorJson(events({ type: 'system' }, { type: 'result', result: 'ok' }, { type: 'assistant' })).result, 'ok');
  const failed = parseCursorJson(events({ type: 'system' }, { type: 'error', message: 'quota exceeded' }, { type: 'assistant' }));
  assert.equal(failed.message, 'quota exceeded');
  assert.equal(parseCursorJson(events({ type: 'system' }, { type: 'assistant' })), null, 'a broken-off run without an error has nothing to report');
  assert.equal(parseCursorJson('not json\n{bad'), null);
});
