import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectEvidence } from '../src/evidence.js';

// Model evidence from session files over the 20 MiB copy limit (images inlined as base64). The
// large files are generated here, never checked in.

const MiB = 1024 * 1024;
let home;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-evidence-test-')));
  process.env.NUNCIUS_HOME = path.join(home, 'data');
  fs.mkdirSync(path.join(home, 'data', 'runs'), { recursive: true });
});

const b64 = (bytes, fill = 7) => Buffer.alloc(Math.ceil((bytes * 3) / 4), fill).toString('base64').slice(0, bytes);
const line = (o) => JSON.stringify(o) + '\n';
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const imageLine = (i, size = 3 * MiB) =>
  line({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: `image ${i}` }, { type: 'input_image', image_url: `data:image/png;base64,${b64(size, i + 1)}` }] } });

test('codex: a rollout over 20 MiB still yields its model, from a trimmed copy', () => {
  const codexHomeDir = path.join(home, 'codex');
  const rollout = [
    line({ type: 'session_meta', payload: { id: 't1' } }),
    line({ type: 'turn_context', payload: { model: 'gpt-head' } }),
    ...Array.from({ length: 11 }, (_, i) => imageLine(i)),
    line({ type: 'event_msg', payload: { type: 'agent_message', message: 'short base64-ish words stay: abcdefABCDEF0123456789+/=' } }),
    line({ type: 'turn_context', payload: { model: 'gpt-tail' } }), // later turns are found too, not only the head
  ].join('');
  const file = write(path.join(codexHomeDir, 'sessions', '2026', '10', '31', 'rollout.jsonl'), rollout);
  assert.ok(fs.statSync(file).size > 30 * MiB);

  const e = collectEvidence({ id: 'big-codex', target: 'codex', codexHomeDir });
  assert.deepEqual(e.models, ['gpt-head', 'gpt-tail']);
  assert.equal(e.files.length, 1);
  assert.match(e.files[0], /rollout\.jsonl\.trimmed$/, 'the name says the copy is trimmed');
  assert.equal(e.trimmed.length, 1);
  const t = e.trimmed[0];
  assert.equal(t.file, e.files[0]);
  assert.equal(t.size, rollout.length);
  assert.equal(t.read, rollout.length);
  assert.equal(t.removed, 11 * 3 * MiB);
  assert.equal(t.truncated, false);

  // Every line is still JSON, and only the image payloads are gone.
  const copy = fs.readFileSync(e.files[0], 'utf8');
  assert.ok(copy.length < 10_000);
  const lines = copy.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 15);
  assert.equal(lines[2].payload.output[1].image_url, `data:image/png;base64,<nuncius: ${3 * MiB} base64 bytes removed>`);
  assert.equal(lines[2].payload.output[0].text, 'image 0');
  assert.equal(lines[13].payload.message, 'short base64-ish words stay: abcdefABCDEF0123456789+/=');
});

test('cursor: a chat store over 20 MiB still yields its model; small files are copied as they are', () => {
  const cursorHome = path.join(home, 'cursor');
  const chat = path.join(cursorHome, '.cursor', 'chats', 'h', 'c');
  // Like SQLite overflow pages: base64 cut into page-sized runs by binary page headers, with the
  // model fields early and late in the file.
  const page = (s) => Buffer.concat([Buffer.from([0, 0, 0x10, 0]), Buffer.from(s, 'latin1')]);
  const parts = [page('{"role":"assistant","providerOptions":{"cursor":{"modelName":"grok-early"}}}')];
  for (let i = 0; i < 6000; i++) parts.push(page(b64(4092, i % 250)));
  parts.push(page('{"role":"assistant","providerOptions":{"cursor":{"modelName":"grok-late"}}}'));
  const store = write(path.join(chat, 'store.db'), Buffer.concat(parts));
  assert.ok(fs.statSync(store).size > 20 * MiB);
  const meta = write(path.join(chat, 'meta.json'), '{"schemaVersion":1}');
  const transcript = line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } });
  write(path.join(cursorHome, '.cursor', 'projects', 'p', 'agent-transcripts', 'c', 'c.jsonl'), transcript);

  const e = collectEvidence({ id: 'big-cursor', target: 'cursor', cursorHome });
  assert.deepEqual(e.models, ['grok-early', 'grok-late']);
  assert.equal(e.files.length, 3, 'store, meta and transcript');
  assert.deepEqual(e.trimmed.map((t) => path.basename(t.file)), ['store.db.trimmed']);
  assert.equal(e.trimmed[0].removed, 6000 * 4092);
  const copy = fs.readFileSync(e.trimmed[0].file, 'latin1');
  assert.ok(copy.includes('"modelName":"grok-early"') && copy.includes('"modelName":"grok-late"'));
  // Files under the limit: the raw copy, byte for byte.
  assert.equal(fs.readFileSync(e.files.find((f) => f.endsWith('meta.json')), 'utf8'), fs.readFileSync(meta, 'utf8'));
  assert.equal(fs.readFileSync(e.files.find((f) => f.endsWith('c.jsonl')), 'utf8'), transcript);
  assert.deepEqual(e.actions, [{ tool: 'Shell', detail: 'ls' }]);
});

test('small files keep the old behaviour: raw copy, no trimmed record', () => {
  const codexHomeDir = path.join(home, 'codex');
  const small = line({ type: 'turn_context', payload: { model: 'gpt-small' } }) + imageLine(0, 4096);
  write(path.join(codexHomeDir, 'sessions', 's.jsonl'), small);
  const e = collectEvidence({ id: 'small', target: 'codex', codexHomeDir });
  assert.deepEqual(e.models, ['gpt-small']);
  assert.equal(e.trimmed, undefined);
  assert.equal(path.basename(e.files[0]), 's.jsonl');
  assert.equal(fs.readFileSync(e.files[0], 'utf8'), small);
});

test('runs across read chunks: short ones are kept whole, long ones removed', () => {
  const codexHomeDir = path.join(home, 'codex');
  // A short base64 run straddling the 1 MiB chunk boundary, a long one straddling the next.
  const head = line({ type: 'turn_context', payload: { model: 'gpt-x' } });
  const pad1 = ' '.repeat(MiB - head.length - 50);
  const shortRun = b64(100, 3);
  const pad2 = ' '.repeat(MiB - 50 - 10);
  const body = `${head}${pad1}"${shortRun}"${pad2}"${b64(5000, 4)}" "${b64(19 * MiB, 5)}"\n`;
  write(path.join(codexHomeDir, 'sessions', 'r.jsonl'), body);
  const e = collectEvidence({ id: 'chunks', target: 'codex', codexHomeDir });
  assert.deepEqual(e.models, ['gpt-x']);
  const copy = fs.readFileSync(e.files[0], 'utf8');
  assert.ok(copy.includes(`"${shortRun}"`));
  assert.ok(copy.includes('"<nuncius: 5000 base64 bytes removed>"'));
  const markers = `<nuncius: 5000 base64 bytes removed><nuncius: ${19 * MiB} base64 bytes removed>`;
  assert.equal(e.trimmed[0].removed, 5000 + 19 * MiB);
  assert.equal(copy.length, body.length - 5000 - 19 * MiB + markers.length);
});

test('hard limits: a file that stays too big is cut at 20 MiB, a huge one is not read', () => {
  const codexHomeDir = path.join(home, 'codex');
  // 25 MiB of text without base64 payloads: kept up to the limit, the rest is not read.
  const text = line({ type: 'turn_context', payload: { model: 'gpt-cut' } }) + line({ type: 'event_msg', payload: { text: 'a b '.repeat(25 * MiB / 4) } });
  write(path.join(codexHomeDir, 'sessions', 'a', 'text.jsonl'), text);
  // Over the 256 MiB scan limit (sparse, so it costs no disk): skipped without reading.
  const huge = path.join(codexHomeDir, 'sessions', 'b', 'huge.jsonl');
  write(huge, line({ type: 'turn_context', payload: { model: 'gpt-huge' } }));
  fs.truncateSync(huge, 257 * MiB);

  const t0 = Date.now();
  const e = collectEvidence({ id: 'limits', target: 'codex', codexHomeDir });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(e.models, ['gpt-cut']);
  assert.equal(e.files.length, 1);
  assert.equal(e.trimmed[0].truncated, true);
  assert.equal(e.trimmed[0].read, 21 * MiB);
  assert.equal(fs.statSync(e.files[0]).size, 20 * MiB);
});

test('large files get the same link checks: no symlinks, no hard links', () => {
  const codexHomeDir = path.join(home, 'codex');
  const outside = write(path.join(home, 'outside', 'secret.jsonl'), line({ type: 'turn_context', payload: { model: 'LEAKED' } }) + imageLine(0, 21 * MiB));
  const sessions = path.join(codexHomeDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.symlinkSync(outside, path.join(sessions, 'link.jsonl'));
  fs.linkSync(outside, path.join(sessions, 'hard.jsonl'));
  const e = collectEvidence({ id: 'links', target: 'codex', codexHomeDir });
  assert.deepEqual(e.models, []);
  assert.deepEqual(e.files, []);
});
