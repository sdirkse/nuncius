import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Retention: prompts, answers, raw output and patches of finished tasks go after retention.days;
// the usage numbers stay; a task with an open worktree or still running keeps everything.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
let home;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-retention-test-')));
  process.env.NUNCIUS_HOME = path.join(home, 'data');
  fs.mkdirSync(path.join(home, 'data', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data', 'runs'), { recursive: true });
});

const data = (...p) => path.join(home, 'data', ...p);
function task(n, { state = 'done', daysAgo, worktree } = {}) {
  const t = { id: id(n), prompt: `secret prompt ${n}`, state, target: 'codex', createdAt: iso(daysAgo), finishedAt: state === 'running' ? undefined : iso(daysAgo), result: { output: `answer ${n}` }, ...(worktree ? { worktree } : {}) };
  fs.writeFileSync(data('tasks', `${t.id}.json`), JSON.stringify(t));
  fs.writeFileSync(data('runs', `${t.id}.out`), 'raw');
  fs.writeFileSync(data('runs', `${t.id}.patch`), 'diff');
  fs.mkdirSync(data('runs', `${t.id}-evidence`));
  return t.id;
}
const exists = (...p) => fs.existsSync(data(...p));
const usage = () => fs.readFileSync(data('usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('old task content goes, the numbers stay, open worktrees and running tasks keep everything', async () => {
  const wt = fs.mkdtempSync(path.join(home, 'wt-'));
  const oldDone = task(1, { daysAgo: 10 });
  const oldOpen = task(2, { daysAgo: 10, worktree: { path: wt, removed: false } });
  const oldRunning = task(3, { state: 'running', daysAgo: 10 });
  const recent = task(4, { daysAgo: 2 });
  const orphan = id(5);
  fs.writeFileSync(data('runs', `${orphan}.out`), 'raw');
  fs.utimesSync(data('runs', `${orphan}.out`), new Date(now - 10 * DAY), new Date(now - 10 * DAY));
  fs.writeFileSync(data('usage.jsonl'), [
    { id: oldDone, tool: 'codex', startedAt: iso(10), ok: true, usage: { totalTokens: 500 }, wallMs: 1000, promptPreview: 'secret prompt 1', cwd: '/Users/me/p' },
    { id: id(6), tool: 'codex', startedAt: iso(9), ok: false, error: 'refused: budget', promptPreview: 'secret 6' },
    { id: oldOpen, tool: 'codex', startedAt: iso(10), ok: true, promptPreview: 'secret prompt 2' },
    { id: recent, tool: 'codex', startedAt: iso(2), ok: true, promptPreview: 'secret prompt 4' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const { pruneOldContent } = await import('../src/retention.js');
  const r = pruneOldContent({ config: { retention: { days: 7 } } });
  assert.deepEqual({ tasks: r.tasks, runFiles: r.runFiles, usageRecords: r.usageRecords }, { tasks: 1, runFiles: 4, usageRecords: 2 });

  assert.ok(!exists('tasks', `${oldDone}.json`) && !exists('runs', `${oldDone}.out`) && !exists('runs', `${oldDone}.patch`) && !exists('runs', `${oldDone}-evidence`));
  assert.ok(!exists('runs', `${orphan}.out`), 'an old run file without a task record goes too');
  for (const kept of [oldOpen, oldRunning, recent]) assert.ok(exists('tasks', `${kept}.json`) && exists('runs', `${kept}.patch`), kept);

  const [a, b, c, d] = usage();
  assert.deepEqual(a, { id: oldDone, tool: 'codex', startedAt: iso(10), ok: true, usage: { totalTokens: 500 }, wallMs: 1000, contentRemoved: true }, 'numbers kept, content gone');
  assert.equal(b.refused, true, 'a refused run stays a refused run without its error text');
  assert.equal(b.error, undefined);
  assert.equal(c.promptPreview, 'secret prompt 2', 'a task with an open worktree keeps its preview');
  assert.equal(d.promptPreview, 'secret prompt 4');
  assert.deepEqual(pruneOldContent({ config: { retention: { days: 7 } } }), { days: 7, tasks: 0, runFiles: 0, usageRecords: 0 }, 'a second run has nothing left to do');
});

test('retention none keeps everything, 0 keeps nothing once a task ends, dry runs change nothing', async () => {
  const { pruneOldContent } = await import('../src/retention.js');
  const done = task(1, { daysAgo: 400 });
  const running = task(2, { state: 'running', daysAgo: 400 });
  assert.equal(pruneOldContent({ config: { retention: { days: null } } }).tasks, 0);
  assert.ok(exists('tasks', `${done}.json`));
  const fresh = task(3, { daysAgo: 0.01 });
  assert.equal(pruneOldContent({ config: { retention: { days: 0 } }, dryRun: true }).tasks, 2);
  assert.ok(exists('tasks', `${done}.json`) && exists('tasks', `${fresh}.json`), 'dry run removed nothing');
  assert.equal(pruneOldContent({ config: { retention: { days: 0 } } }).tasks, 2);
  assert.ok(!exists('tasks', `${fresh}.json`) && exists('tasks', `${running}.json`), 'a running task is never pruned');
});

test('the retention setting accepts days, 0 and none, and refuses anything else', async () => {
  const { validateConfig } = await import('../src/settings.js');
  for (const days of [7, 0, null, 30]) assert.deepEqual(validateConfig({ retention: { days } }), [], String(days));
  for (const days of ['7', -1, true]) assert.ok(validateConfig({ retention: { days } }).length, String(days));
});

test('an append waits for a rewrite holding the usage lock and is not lost', async () => {
  // Another process holds the lock for 600 ms (as a retention rewrite would) ...
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { withUsageLock } = await import(${JSON.stringify(path.join(root, 'src', 'log.js'))});
    withUsageLock(() => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); });
  `], { env: process.env });
  await new Promise((r) => holder.stdout.once('data', r));
  // ... and an append in this process waits for it, then lands.
  const { appendUsage } = await import('../src/log.js');
  const t0 = Date.now();
  appendUsage({ id: 'x', tool: 'codex', startedAt: new Date().toISOString(), ok: true });
  assert.ok(Date.now() - t0 >= 300, 'the append waited for the lock');
  await new Promise((r) => holder.on('exit', r));
  assert.equal(usage().length, 1);
  assert.equal(exists('usage.lock'), false, 'the lock is released');
});
