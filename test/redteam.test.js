import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { initRepo } from './helpers.js';

// Regression tests for the multi-model red-team review: a hostile target or a careless caller
// trying to get past nuncius's own bookkeeping. Each test names the hole it keeps closed.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env;

const writeConfig = (extra = {}) =>
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({ codexBin: path.join(fixtures, 'fake-codex.js'), cursorBin: path.join(fixtures, 'fake-cursor.js'), sandbox: { passEnv: ['FAKE_*'] }, ...extra }),
  );

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-redteam-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  writeConfig();
});

const nuncius = (args, { cwd = repo, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), ...args], { env: { ...env, ...extraEnv }, cwd, encoding: 'utf8' });
const usage = () => {
  const p = path.join(env.NUNCIUS_HOME, 'usage.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
// A cursor-shaped target: a shell script whose last line prints the result object.
const probe = (body) => {
  const p = path.join(home, `probe-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\necho '{"type":"result","is_error":false,"result":"ok","duration_ms":1}'\n`);
  fs.chmodSync(p, 0o755);
  return p;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Run fn with this test's nuncius environment in process.env (for in-process calls into src/).
async function withEnv(fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { NUNCIUS_HOME: env.NUNCIUS_HOME, CODEX_HOME: env.CODEX_HOME });
  delete process.env.NUNCIUS_DEPTH;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('a target cannot signal processes outside its sandbox (its worker, or anything else)', () => {
  const outside = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    // $PPID is nuncius itself (sandbox-exec execs into the target): killing it would end the timeout and the usage record.
    writeConfig({ cursorBin: probe('kill -KILL $PPID; kill -TERM "$FAKE_PID"; true') });
    const r = nuncius(['cursor', 'x'], { extraEnv: { FAKE_PID: String(outside.pid) } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(alive(outside.pid), 'a process outside the sandbox survived');
    assert.equal(usage().length, 1, 'the run was recorded');
  } finally {
    outside.kill('SIGKILL');
  }
});

test('a daemon holding the output pipe open does not keep the task running', () => {
  // perl's setsid leaves the process group, so the group kill misses it; it keeps stdout open.
  writeConfig({ cursorBin: probe(`perl -MPOSIX -e 'if (!fork) { POSIX::setsid(); sleep 20; exit }'`) });
  const started = Date.now();
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 12000, `took ${Date.now() - started} ms`);
  assert.equal(usage().at(-1).ok, true);
});

test('a task whose worker died is counted as a run, and its target is stopped', async () => {
  await withEnv(async () => {
    const { submitTask, updateTask, readTask } = await import('../src/tasks.js');
    const t = await submitTask({ target: 'cursor', prompt: 'x', cwd: repo, project: 'p', agent: 'a' });
    assert.equal(t.state, 'queued', t.error);
    const dead = spawnSync('/usr/bin/true').pid; // a pid that is gone
    const target = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    updateTask(t.id, { state: 'running', startedAt: new Date(Date.now() - 60000).toISOString(), workerPid: dead, targetProcess: { pid: target.pid, bin: '/bin/sleep' } });
    // The next submit reaps it under the queue lock.
    await submitTask({ target: 'cursor', prompt: 'y', cwd: repo, project: 'p', agent: 'a' });
    assert.equal(readTask(t.id).state, 'failed');
    const rec = usage().find((r) => r.id === t.id);
    assert.ok(rec && rec.reaped && rec.wallMs >= 59000, JSON.stringify(rec));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(target.pid), false, 'the orphaned target was stopped');
  });
});

test('the reaper never signals a reused pid', async () => {
  await withEnv(async () => {
    const { submitTask, updateTask } = await import('../src/tasks.js');
    const t = await submitTask({ target: 'cursor', prompt: 'x', cwd: repo, project: 'p', agent: 'a' });
    const stranger = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      updateTask(t.id, { state: 'running', startedAt: new Date().toISOString(), workerPid: spawnSync('/usr/bin/true').pid, targetProcess: { pid: stranger.pid, bin: '/usr/local/bin/cursor-agent' } });
      await submitTask({ target: 'cursor', prompt: 'y', cwd: repo, project: 'p', agent: 'a' });
      assert.ok(alive(stranger.pid), 'a process running another binary was left alone');
    } finally {
      stranger.kill('SIGKILL');
    }
  });
});

// pgrep -f by a marker argument: none of these numbers occur in other tests.
const running = (marker) => spawnSync('/usr/bin/pgrep', ['-f', `sleep ${marker}$`], { encoding: 'utf8' }).stdout.trim();

test('a process the target started outside its process group does not outlive the task', () => {
  // Cursor's updater does this: spawn(..., { detached: true }). One stray stays in the worktree; the
  // other moves to / but runs a binary from the task's throw-away HOME.
  const outside = spawn('/bin/sleep', ['4711'], { detached: true, stdio: 'ignore', cwd: home });
  try {
    writeConfig({ cursorBin: probe([
      `perl -MPOSIX -e 'if (!fork) { POSIX::setsid(); exec "/bin/sleep", "4709" }'`,
      // (A copied system binary is killed by macOS on start; a script is not.)
      `printf 'while :; do /bin/sleep 1; done\\n' > "$HOME/stray"`,
      `(cd / && perl -MPOSIX -e 'if (!fork) { POSIX::setsid(); exec "/bin/sh", "$ENV{HOME}/stray", "4710" }')`,
      'sleep 1',
    ].join('\n')) });
    const r = nuncius(['cursor', 'x']);
    assert.equal(r.status, 0, r.stderr);
    // "stopped 2" below proves both strays were running when the target finished.
    assert.equal(running('4709'), '', 'the stray in the worktree was stopped');
    assert.equal(spawnSync('/usr/bin/pgrep', ['-f', 'stray 4710$'], { encoding: 'utf8' }).stdout.trim(), '', 'the stray running from the throw-away HOME was stopped');
    assert.ok(alive(outside.pid), 'a process outside the task was left alone');
    const tasks = path.join(env.NUNCIUS_HOME, 'tasks');
    const task = JSON.parse(fs.readFileSync(path.join(tasks, fs.readdirSync(tasks)[0]), 'utf8'));
    assert.match(task.warnings?.join(' ') ?? '', /stopped 2 process\(es\) cursor left running/);
  } finally {
    outside.kill('SIGKILL');
    spawnSync('/usr/bin/pkill', ['-KILL', '-f', '(sleep 4709|stray 4710)$']);
  }
});

test('the reaper stops strays in a dead task\'s own folders, and only there', async () => {
  await withEnv(async () => {
    const { submitTask, updateTask } = await import('../src/tasks.js');
    const t = await submitTask({ target: 'cursor', prompt: 'x', cwd: repo, project: 'p', agent: 'a' });
    const inside = path.join(`${env.NUNCIUS_HOME}-worktrees`, 'stray-test');
    const elsewhere = path.join(home, 'elsewhere'); // a damaged record pointing outside nuncius's roots
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const a = spawn('/bin/sleep', ['4712'], { detached: true, stdio: 'ignore', cwd: inside });
    const b = spawn('/bin/sleep', ['4713'], { detached: true, stdio: 'ignore', cwd: elsewhere });
    try {
      updateTask(t.id, { state: 'running', startedAt: new Date(Date.now() - 5000).toISOString(), workerPid: spawnSync('/usr/bin/true').pid, targetProcess: { pid: spawnSync('/usr/bin/true').pid, bin: '/bin/sleep', dirs: [inside, elsewhere] } });
      await submitTask({ target: 'cursor', prompt: 'y', cwd: repo, project: 'p', agent: 'a' });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(alive(a.pid), false, 'the stray in the task\'s worktree root was stopped');
      assert.ok(alive(b.pid), 'a folder outside nuncius\'s roots was ignored');
    } finally {
      a.kill('SIGKILL');
      b.kill('SIGKILL');
    }
  });
});

test('tasks submitted at the same moment from several processes cannot pass a run cap together', async () => {
  writeConfig({ budgets: { cursor: { maxRunsPerDay: 1 } }, concurrency: { perTarget: 10, total: 10 } });
  const script = `const { submitTask } = await import(${JSON.stringify(path.join(root, 'src', 'tasks.js'))});\n` +
    `const t = await submitTask({ target: 'cursor', prompt: 'x', cwd: ${JSON.stringify(repo)}, project: 'p', agent: 'a' });\n` +
    'console.log(t.state ?? t.error);';
  const runs = await Promise.all(
    Array.from({ length: 6 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out.trim()));
    })),
  );
  assert.deepEqual(runs.sort(), ['queued', 'refused', 'refused', 'refused', 'refused', 'refused']);
});

test('a second checkout of the same repository is the same project (and budget)', async () => {
  const { detectProject } = await import('../src/project.js');
  const other = path.join(home, 'some-other-name');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', other]);
  const saved = process.env.NUNCIUS_PROJECT;
  delete process.env.NUNCIUS_PROJECT;
  try {
    assert.equal(detectProject(other), 'repo');
    assert.equal(detectProject(path.join(repo)), 'repo');
  } finally {
    if (saved !== undefined) process.env.NUNCIUS_PROJECT = saved;
  }
  writeConfig({ budgets: { projects: { repo: { cursor: { maxRunsPerDay: 1 } } } } });
  assert.equal(nuncius(['cursor', 'x']).status, 0);
  const r = nuncius(['cursor', 'x'], { cwd: other });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /Project repo: Cursor runs today 1 >= cap 1/);
});

test('the queue has a size limit, and a prompt has a size limit', async () => {
  writeConfig({ concurrency: { perTarget: 1, total: 1, maxQueued: 2 } });
  await withEnv(async () => {
    const { submitTask, MAX_PROMPT_BYTES } = await import('../src/tasks.js');
    const sub = (prompt = 'x') => submitTask({ target: 'cursor', prompt, cwd: repo, project: 'p', agent: 'a' });
    assert.equal((await sub()).state, 'queued');
    assert.equal((await sub()).state, 'queued');
    const full = await sub();
    assert.match(full.error, /queue is full: 2 tasks are waiting/);
    assert.equal(fs.readdirSync(path.join(env.NUNCIUS_HOME, 'tasks')).filter((n) => n.endsWith('.json')).length, 2, 'no task file for the refused submit');
    assert.match((await sub('y'.repeat(MAX_PROMPT_BYTES + 1))).error, /limit is 1048576 \(1 MB\)/);
  });
});

test('a forged token count cannot poison the totals beyond one plausible run', () => {
  const p = path.join(home, 'tokens.sh');
  fs.writeFileSync(p, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\necho \'{"type":"turn.completed","usage":{"input_tokens":1e300,"output_tokens":1e300}}\'\n');
  fs.chmodSync(p, 0o755);
  writeConfig({ codexBin: p });
  assert.equal(nuncius(['codex', 'x']).status, 0);
  const s = JSON.parse(nuncius(['status', '--json']).stdout);
  // A run of under a minute can count at most the floor allowance (1M), not a billion.
  assert.ok(s.today.codexTokens <= 1e6, String(s.today.codexTokens));
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8')).usage.clamped, true);
});

test('token clamping leaves plausible counts alone and scales implausible ones by run time', async () => {
  const { clampRunUsage } = await import('../src/num.js');
  const real = { inputTokens: 577152, cachedInputTokens: 508416, outputTokens: 14380, totalTokens: 591532 };
  assert.deepEqual(clampRunUsage(real, 381000), real, 'a real 6-minute Codex run is untouched');
  const forged = clampRunUsage({ inputTokens: 1e9, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1e9 }, 120000);
  assert.equal(forged.totalTokens, 1e7, 'two minutes allow at most 10M');
});

test('the MCP server drops an oversized request line and keeps serving', async () => {
  const { lineReader } = await import('../src/mcp.js');
  const lines = [];
  let tooLong = 0;
  const feed = lineReader((l) => lines.push(l), () => tooLong++, 10);
  feed(Buffer.from('{"a":1}\n0123456789ABCDEF'));
  feed(Buffer.from('still the long line\n{"b":2}\n'));
  feed(Buffer.from('é'.slice(0, 1)));
  feed(Buffer.from('\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', 'é']);
  assert.equal(tooLong, 1);
});

// --- PR 4: config, dashboard and ops robustness ---

import { validateConfig } from '../src/settings.js';
import { createServer, isAllowedHost } from '../src/server.js';
import { serverInfo, createHandlers } from '../src/mcp.js';

test('a wrong-typed budget fails closed instead of silently switching off', async () => {
  // A string where a number is expected: the CLI would refuse it, and a hand-edit must too.
  assert.ok(validateConfig({ budgets: { cursor: { maxRunsPerDay: '1' } } }).length);
  // budgets as a whole set to a string would otherwise remove every budget.
  assert.ok(validateConfig({ budgets: 'none' }).length);
  assert.ok(validateConfig({ targets: { codex: { enabled: 'yes' } } }).length);
  // A valid config has no problems (fractional seconds are allowed; the CLI just writes whole ones).
  assert.deepEqual(validateConfig({ budgets: { cursor: { maxRunsPerDay: 500 } }, tasks: { timeoutSeconds: 0.5 } }), []);
  // loadConfig refuses a wrong-typed budget rather than running with no cap.
  const T = fs.mkdtempSync(path.join(home, 'cfg-'));
  fs.writeFileSync(path.join(T, 'config.json'), '{"budgets":{"cursor":{"maxRunsPerDay":"1"}}}');
  const saved = process.env.NUNCIUS_HOME;
  process.env.NUNCIUS_HOME = T;
  try {
    const { loadConfig } = await import('../src/config.js');
    assert.throws(() => loadConfig(), /wrong kind|maxRunsPerDay/);
  } finally {
    if (saved === undefined) delete process.env.NUNCIUS_HOME; else process.env.NUNCIUS_HOME = saved;
  }
});

test('a non-object top-level config is refused', async () => {
  const T = fs.mkdtempSync(path.join(home, 'cfg2-'));
  fs.writeFileSync(path.join(T, 'config.json'), '[1,2,3]');
  const saved = process.env.NUNCIUS_HOME;
  process.env.NUNCIUS_HOME = T;
  try {
    const { loadConfig } = await import('../src/config.js');
    assert.throws(() => loadConfig(), /top level must be a JSON object/);
  } finally {
    if (saved === undefined) delete process.env.NUNCIUS_HOME; else process.env.NUNCIUS_HOME = saved;
  }
});

test('a broken config does not break the MCP handshake; the client still gets the tools', async () => {
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), '{"budgets":"none"}');
  await withEnv(async () => {
    const { handle } = createHandlers({ defaultCwd: repo });
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cursor' } } });
    assert.ok(init.instructions.includes('run_task'), 'instructions still delivered');
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.tools.length >= 4, 'tools listed');
    // But a tool call surfaces the config error rather than running with no budget.
    const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'usage', arguments: {} } });
    assert.ok(call.isError && /wrong kind|group of settings/.test(call.content[0].text), JSON.stringify(call));
  });
});

test('the dashboard survives a malformed request, bad records, and uppercase Host', async () => {
  // Poison the logs and task files the way a corrupt or partial write would.
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'null\n42\n{"tool":"codex","startedAt":"2026-10-20T00:00:00.000Z","ok":true}\n');
  const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', state: 'running', target: 'codex', prompt: null }));
  const saved = process.env.NUNCIUS_HOME;
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  // Grab a free port, then create the server bound to exactly it (the Host check uses this port).
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const token = 'test-token-0123456789';
  const server = createServer(port, token);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const get = (reqPath, host, tok = token) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, headers: { host: host ?? `127.0.0.1:${port}`, ...(tok ? { 'x-nuncius-token': tok } : {}) } }, (res) => {
      let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
  try {
    const summary = await get('/api/summary');
    assert.equal(summary.status, 200, 'bad records do not crash /api/summary');
    const bad = await get('//[::1]:bad/api/summary');
    assert.ok(bad.status === 400 || bad.status === 200, `malformed URL handled: ${bad.status}`);
    const upper = await get('/api/summary', `LOCALHOST:${port}`);
    assert.equal(upper.status, 200, 'uppercase Host is accepted');
    // Without the token (another account on this Mac reaching 127.0.0.1) the data API refuses.
    assert.equal((await get('/api/summary', undefined, null)).status, 401);
    assert.equal((await get('/api/tasks?page=1', undefined, null)).status, 401);
    assert.equal((await get('/api/live', undefined, null)).status, 401, 'the live view needs the token too');
    const live = await get('/api/live');
    assert.equal(live.status, 200, 'a damaged task file does not break /api/live');
    assert.deepEqual(Object.keys(JSON.parse(live.body)).sort(), ['activeTasks', 'generatedAt', 'queue']);
    // A task's activity log comes back cleaned, oldest first, and from a given line on.
    const logged = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(tasksDir, `${logged}.json`), JSON.stringify({ id: logged, state: 'done', target: 'cursor', prompt: 'p', startedAt: '2026-10-28T08:00:00.000Z', finishedAt: '2026-10-28T08:01:00.000Z', wallMs: 60000,
      progress: { startedAt: '2026-10-28T08:00:00.000Z', lastActivityAt: '2026-10-28T08:00:50.000Z', lastActivity: 'edit a.js', steps: 2, filesEdited: 1, commands: 1, logged: 2 } }));
    fs.mkdirSync(path.join(env.NUNCIUS_HOME, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${logged}.activity.jsonl`), [{ s: 0, kind: 'start', what: 'Started' }, { s: 5, kind: 'command', what: 'Shell: ls' }, { s: 50, kind: 'edit', what: 'edit a.js\u202e' }, { s: 60, kind: 'end', what: 'Done' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const detail = JSON.parse((await get(`/api/task?id=${logged}`)).body);
    assert.deepEqual(detail.activity.items.map((e) => e.what), ['Started', 'Shell: ls', 'edit a.js', 'Done']);
    const logText = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${logged}.activity.jsonl`), 'utf8');
    assert.equal(detail.activity.next, Buffer.byteLength(logText), 'next: the end of the last whole line');
    assert.equal(detail.activity.filesEdited, 1);
    assert.equal(detail.activity.elapsedSeconds, 60);
    // From a byte offset only the lines after it are read; a line still being written waits for the next read.
    const twoLines = Buffer.byteLength(logText.split('\n').slice(0, 2).join('\n') + '\n');
    const more = JSON.parse((await get(`/api/task?id=${logged}&from=${twoLines}`)).body);
    assert.deepEqual([more.activity.from, more.activity.items.map((e) => e.kind)], [twoLines, ['edit', 'end']]);
    assert.equal(JSON.parse((await get(`/api/task?id=${logged}&from=-3`)).body).activity.from, 0, 'odd offsets fall back to the start');
    assert.deepEqual(JSON.parse((await get(`/api/task?id=${logged}&from=999999`)).body).activity.items, [], 'past the end: nothing new');
    fs.appendFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${logged}.activity.jsonl`), '{"s":61,"kind":"note","wh');
    const partial = JSON.parse((await get(`/api/task?id=${logged}&from=${detail.activity.next}`)).body).activity;
    assert.deepEqual([partial.items, partial.next], [[], detail.activity.next]);
    fs.appendFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${logged}.activity.jsonl`), 'at":"late"}\n');
    assert.deepEqual(JSON.parse((await get(`/api/task?id=${logged}&from=${detail.activity.next}`)).body).activity.items.map((e) => e.what), ['late']);
    // The task window's 2-second poll: only the state and the new lines, behind the token too.
    assert.equal((await get(`/api/task/activity?id=${logged}`, undefined, null)).status, 401);
    const slim = JSON.parse((await get(`/api/task/activity?id=${logged}&from=${twoLines}`)).body);
    assert.deepEqual(Object.keys(slim).sort(), ['activity', 'id', 'state']);
    assert.deepEqual(slim.activity.items.map((e) => e.kind), ['edit', 'end', 'note']);
    assert.equal((await get('/api/task/activity?id=../../etc/passwd')).status, 404);
    // A running task's progress comes from its own file, which the worker writes without the queue lock.
    const running = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(path.join(tasksDir, `${running}.json`), JSON.stringify({ id: running, state: 'running', target: 'codex', prompt: 'p', workerPid: process.pid, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), progress: { steps: 0 } }));
    fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${running}.progress.json`), JSON.stringify({ startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), lastActivity: 'Shell: npm test', steps: 3, filesEdited: 1, commands: 2 }));
    const now = JSON.parse((await get('/api/live')).body).activeTasks.find((t) => t.id === running);
    assert.equal(now.progress.steps, 3);
    assert.equal(now.progress.lastActivity.what, 'Shell: npm test');
    // Once it finishes it leaves the live view, and stays gone (a finished task is not read again).
    fs.writeFileSync(path.join(tasksDir, `${running}.json`), JSON.stringify({ id: running, state: 'done', target: 'codex', prompt: 'p', createdAt: new Date().toISOString() }));
    for (let i = 0; i < 2; i++) assert.equal(JSON.parse((await get('/api/live')).body).activeTasks.some((t) => t.id === running), false);
    fs.rmSync(path.join(tasksDir, `${running}.json`));
    const tasks = await get('/api/tasks?page=9&size=25&q=%00%ff');
    assert.equal(tasks.status, 200, 'odd paging and search input is answered, not a crash');
    assert.deepEqual(Object.keys(JSON.parse(tasks.body)).sort(), ['items', 'page', 'pages', 'size', 'total']);
    assert.equal((await get('/api/task?id=00000000-0000-4000-8000-000000000000', undefined, 'wrong-token-0123456789')).status, 401);
    assert.equal((await get('/', undefined, null)).status, 200, 'the page itself (no data) still loads');
    // The server is still alive after all of that.
    assert.equal((await get('/api/summary')).status, 200, 'server still serving');
  } finally {
    server.close();
    if (saved === undefined) delete process.env.NUNCIUS_HOME; else process.env.NUNCIUS_HOME = saved;
  }
});

test('isAllowedHost rejects a non-loopback Host (DNS rebinding) and accepts loopback case-insensitively', () => {
  assert.equal(isAllowedHost('evil.example.com:7317', 7317), false);
  assert.equal(isAllowedHost('LocalHost:7317', 7317), true);
  assert.equal(isAllowedHost('127.0.0.1:7317', 7317), true);
});

test('usage reports a restart hint when the running version is older than the one on disk', () => {
  // With matching versions there is no hint.
  assert.equal(serverInfo().restartHint, undefined);
  assert.ok(typeof serverInfo().version === 'string');
});

// --- PR 3: sandbox read/write policy ---

import { buildProfile, sandboxAvailable } from '../src/sandbox.js';

// Run a shell command under a target's real sandbox profile; returns { code, stdout }.
function underSandbox(target, cmd, { runtimeDirs = [] } = {}) {
  const wt = fs.mkdtempSync(path.join(home, 'wt-'));
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  const profile = buildProfile({ worktree: wt, callerRepo: repo, target, proxyPort: 1, runtimeDirs, runCwd: wt });
  const sb = path.join(home, `p-${Math.random().toString(36).slice(2)}.sb`);
  fs.writeFileSync(sb, profile);
  const r = spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
  return { code: r.status, stdout: (r.stdout || '') + (r.stderr || ''), profile };
}

test('the profile never emits a bare allow-all write rule', () => {
  // An empty subpath list must not become "(allow file-write* )", which allows every write.
  for (const target of ['codex', 'cursor', 'claude']) {
    const profile = buildProfile({ worktree: path.join(home, 'wt'), callerRepo: repo, target, proxyPort: 1, runtimeDirs: [] });
    for (const line of profile.split('\n')) assert.ok(!/^\(allow file-\w+\*?\s*\)$/.test(line.trim()), `bare allow rule: ${line}`);
  }
});

test('a target cannot read the common secret stores, but the keychain stays readable', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const probes = {
    '.zsh_history': '~/.zsh_history',
    '.gitconfig': '~/.gitconfig',
    '.aws': '~/.aws',
    '.ssh': '~/.ssh',
    'Library/Cookies': '~/Library/Cookies',
  };
  for (const [name, p] of Object.entries(probes)) {
    const r = underSandbox('codex', `cat ${p} 2>&1 >/dev/null; ls ${p} >/dev/null 2>&1 && echo READABLE || echo denied`);
    assert.match(r.stdout, /denied/, `${name} should be denied: ${r.stdout}`);
  }
  // Keychain must stay readable, or Cursor and Claude cannot log in.
  const kc = underSandbox('codex', 'ls ~/Library/Keychains >/dev/null 2>&1 && echo ok || echo DENIED');
  assert.match(kc.stdout, /ok/, kc.stdout);
});

test('a target cannot write the real per-user temp or /private/tmp', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const mark = `nuncius-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const temp = underSandbox('codex', `echo x > "$(getconf DARWIN_USER_TEMP_DIR)${mark}" 2>&1 && echo WROTE || echo denied`);
  assert.match(temp.stdout, /denied/, temp.stdout);
  const t2 = underSandbox('codex', `echo x > /private/tmp/${mark} 2>&1 && echo WROTE || echo denied`);
  assert.match(t2.stdout, /denied/, t2.stdout);
  // Its own per-task runtime dir stays writable.
  const rt = fs.mkdtempSync(path.join(home, 'rt-'));
  const ok = underSandbox('codex', `echo x > ${path.join(rt, 'f')} 2>&1 && echo ok || echo DENIED`, { runtimeDirs: [rt] });
  assert.match(ok.stdout, /ok/, ok.stdout);
});

test('a Claude task may write only its own snapshot subdir and cwd file, not another session\'s', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const uid = process.getuid();
  fs.mkdirSync(`/private/tmp/claude-${uid}`, { recursive: true });
  // Its own cwd-keyed subdir is writable; another session's subdir under the same base is not.
  const victim = `/private/tmp/claude-${uid}/-Users-someone-else-project-${process.pid}`;
  fs.mkdirSync(victim, { recursive: true });
  try {
    const mine = underSandbox('claude', `mkdir -p "$(getconf DARWIN_USER_TEMP_DIR)" 2>/dev/null; echo x > ${victim}/evil 2>&1 && echo WROTE || echo denied`);
    assert.match(mine.stdout, /denied/, `another session's snapshot dir must be denied: ${mine.stdout}`);
  } finally {
    fs.rmSync(victim, { recursive: true, force: true });
  }
  // The per-shell cwd file shape is allowed for Claude, denied for Codex.
  const cwdFile = `/private/tmp/claude-reltest${process.pid}-cwd`;
  const claude = underSandbox('claude', `echo x > ${cwdFile} 2>&1 && echo ok || echo DENIED`);
  assert.match(claude.stdout, /ok/, claude.stdout);
  fs.rmSync(cwdFile, { force: true });
  const codex = underSandbox('codex', `echo x > /private/tmp/claude-reltest${process.pid}-cwd 2>&1 && echo WROTE || echo denied`);
  assert.match(codex.stdout, /denied/, codex.stdout);
});

// --- PR 2: apply and cleanup safety ---

test('the apply command disables hooks and does not activate a target .gitattributes filter', async () => {
  await withEnv(async () => {
    const { createWorktree, finishWorktree } = await import('../src/worktree.js');
    // The caller's repo has a post-commit hook and a named filter in its own config.
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks']);
    execFileSync('git', ['-C', repo, 'config', 'filter.demo.smudge', `sh -c 'echo SMUDGE >> ${home}/marks; cat'`]);
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(path.join(repo, '.githooks', 'post-commit'), `#!/bin/sh\necho HOOK >> ${home}/marks\n`, { mode: 0o755 });
    execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=', 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'hooks']);
    // A target adds a .gitattributes activating the filter.
    const wt = createWorktree({ cwd: repo, id: '22222222-0000-4000-8000-000000000001', target: 'codex' });
    fs.writeFileSync(path.join(wt.path, '.gitattributes'), '*.dat filter=demo\n');
    fs.writeFileSync(path.join(wt.path, 'payload.dat'), 'data\n');
    const done = finishWorktree(wt, { id: '22222222-0000-4000-8000-000000000001', target: 'codex', prompt: 'x' });
    assert.ok(done.sensitiveFiles.includes('.gitattributes'), 'the .gitattributes is flagged');
    fs.rmSync(path.join(home, 'marks'), { force: true });
    const r = spawnSync('/bin/sh', ['-c', done.apply], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(home, 'marks')), false, 'no hook and no filter ran on apply');
  });
});

test('a repo .gitattributes cannot run a filter driver while nuncius snapshots it', async () => {
  await withEnv(async () => {
    const { createWorktree } = await import('../src/worktree.js');
    execFileSync('git', ['-C', repo, 'config', 'filter.demo.clean', `sh -c 'echo CLEAN >> ${home}/marks; cat'`]);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=demo\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    fs.rmSync(path.join(home, 'marks'), { force: true });
    const wt = createWorktree({ cwd: repo, id: '22222222-0000-4000-8000-000000000002', target: 'codex' });
    assert.equal(fs.existsSync(path.join(home, 'marks')), false, 'no clean/smudge filter ran during the snapshot');
    assert.ok(fs.existsSync(wt.path));
  });
});

test('the sensitive-file list covers CI pipelines and Python entry points', async () => {
  const { sensitiveFiles } = await import('../src/worktree.js');
  const names = ['.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml', '.buildkite/pipeline.yml', 'setup.py', 'conftest.py', 'pyproject.toml', 'src/app.js'];
  assert.deepEqual(sensitiveFiles(names).sort(), names.slice(0, 7).sort());
});

test('cleanup saves edits made in a worktree after the task finished', async () => {
  await withEnv(async () => {
    const { createWorktree, finishWorktree } = await import('../src/worktree.js');
    const { cleanup } = await import('../src/cleanup.js');
    const id = '22222222-0000-4000-8000-000000000003';
    const wt = createWorktree({ cwd: repo, id, target: 'codex' });
    fs.writeFileSync(path.join(wt.path, 'from-task.txt'), 'task work\n');
    const done = finishWorktree(wt, { id, target: 'codex', prompt: 'x' });
    // The user then edits the kept worktree by hand.
    fs.writeFileSync(path.join(done.path, 'from-task.txt'), 'edited by the user after the task\n');
    fs.writeFileSync(path.join(done.path, 'user-note.txt'), 'keep me\n');
    const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify({ id, prompt: 'x', state: 'done', createdAt: '2000-01-01T00:00:00.000Z', finishedAt: '2000-01-01T00:00:00.000Z', target: 'codex', worktree: done }));
    const actions = cleanup({ days: 7 });
    const act = actions.find((a) => a.id === id);
    assert.ok(act.savedCommit, 'post-task edits were saved');
    assert.equal(act.branchDeleted, false, 'the branch is kept because it holds unsaved work');
    const note = execFileSync('git', ['-C', repo, 'show', `${done.branch}:user-note.txt`], { encoding: 'utf8' });
    assert.equal(note, 'keep me\n');
    const edited = execFileSync('git', ['-C', repo, 'show', `${done.branch}:from-task.txt`], { encoding: 'utf8' });
    assert.equal(edited, 'edited by the user after the task\n');
  });
});

test('the apply alternative (git apply) is a valid shell command', async () => {
  await withEnv(async () => {
    const { createWorktree, finishWorktree } = await import('../src/worktree.js');
    const id = '22222222-0000-4000-8000-000000000004';
    const wt = createWorktree({ cwd: repo, id, target: 'codex' });
    fs.writeFileSync(path.join(wt.path, 'added.txt'), 'added\n');
    const done = finishWorktree(wt, { id, target: 'codex', prompt: 'x' });
    // Both strings parse and run as single commands (no inline "(or: ...)" prose).
    for (const cmd of [done.apply, done.applyPatch]) {
      const parse = spawnSync('/bin/sh', ['-n', '-c', cmd], { encoding: 'utf8' });
      assert.equal(parse.status, 0, `${cmd}\n${parse.stderr}`);
    }
    // git apply writes the file to the caller's working tree.
    execFileSync('git', ['-C', repo, 'reset', '-q', '--hard', 'HEAD']);
    const r = spawnSync('/bin/sh', ['-c', done.applyPatch], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(repo, 'added.txt'), 'utf8'), 'added\n');
  });
});

// --- apply path (second red-team round) ---

test('a repo whose filter or merge driver runs repo code flags every changed file (fails closed)', async () => {
  await withEnv(async () => {
    const { createWorktree, finishWorktree } = await import('../src/worktree.js');
    // The caller's repo already uses a filter driver whose script loads another file from the repo.
    fs.mkdirSync(path.join(repo, 'tools', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tools', 'smudge.sh'), '#!/bin/sh\n. tools/lib/helper.sh\ncat\n', { mode: 0o755 });
    fs.writeFileSync(path.join(repo, 'tools', 'lib', 'helper.sh'), ':\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tools']);
    execFileSync('git', ['-C', repo, 'config', 'filter.custom.smudge', './tools/smudge.sh']);
    const id = '33333333-0000-4000-8000-000000000001';
    const wt = createWorktree({ cwd: repo, id, target: 'codex' });
    // The target changes only the file the driver script loads, which no driver command names.
    fs.writeFileSync(path.join(wt.path, 'tools', 'lib', 'helper.sh'), 'touch /tmp/x\n');
    fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'plain\n');
    const done = finishWorktree(wt, { id, target: 'codex', prompt: 'x' });
    assert.deepEqual([...done.sensitiveFiles].sort(), ['notes.txt', 'tools/lib/helper.sh']);
    assert.deepEqual(done.repoDrivers, ['filter.custom.smudge ./tools/smudge.sh']);
  });
});

test('repoDrivers: only known installed tools with plain arguments are trusted', async () => {
  const { repoDrivers } = await import('../src/worktree.js');
  const set = (k, v) => execFileSync('git', ['-C', repo, 'config', k, v]);
  set('filter.lfs.process', 'git-lfs filter-process');
  set('filter.lfs.smudge', 'git-lfs smudge -- %f');
  set('filter.crypt.smudge', '/opt/homebrew/bin/git-crypt smudge');
  set('merge.ours.driver', 'true');
  assert.deepEqual(repoDrivers(repo), []);
  // Everything else counts as repo code, including a script that does not exist yet (the task may add
  // it), an interpreter that resolves an extension itself, flags with attached paths, and expansions.
  set('filter.a.clean', 'sh run.sh');
  set('filter.b.clean', 'node filter');
  set('filter.c.clean', 'ruby -Itools x');
  set('filter.d.clean', '$(git rev-parse --show-toplevel)/x');
  set('filter.e.clean', '"git-crypt" smudge');
  set('merge.f.driver', `${repo}/git-lfs %O %A %B`);
  assert.deepEqual(repoDrivers(repo).map((l) => l.split(' ')[0]).sort(), ['filter.a.clean', 'filter.b.clean', 'filter.c.clean', 'filter.d.clean', 'filter.e.clean', 'merge.f.driver']);
});

test('removing a worktree keeps its branch when someone committed on it afterwards', async () => {
  await withEnv(async () => {
    const { createWorktree, finishWorktree, removeWorktree } = await import('../src/worktree.js');
    const id = '33333333-0000-4000-8000-000000000002';
    const wt = createWorktree({ cwd: repo, id, target: 'codex' });
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'task\n');
    const done = finishWorktree(wt, { id, target: 'codex', prompt: 'x' });
    // A person adds a commit on the task branch after nuncius recorded its commit.
    fs.writeFileSync(path.join(done.path, 'b.txt'), 'later\n');
    execFileSync('git', ['-C', done.path, 'add', '-A']);
    execFileSync('git', ['-C', done.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'later work']);
    assert.equal(removeWorktree(done, { deleteBranch: true }), false);
    const tip = execFileSync('git', ['-C', repo, 'rev-parse', `refs/heads/${done.branch}`], { encoding: 'utf8' }).trim();
    assert.notEqual(tip, done.commit, 'the later commit is still on the branch');
    // Without later commits the branch goes as before.
    const id2 = '44444444-0000-4000-8000-000000000003';
    const wt2 = createWorktree({ cwd: repo, id: id2, target: 'codex' });
    fs.writeFileSync(path.join(wt2.path, 'c.txt'), 'task\n');
    const done2 = finishWorktree(wt2, { id: id2, target: 'codex', prompt: 'x' });
    assert.equal(removeWorktree(done2, { deleteBranch: true }), true);
  });
});

test('a target cannot listen on an IP socket (inbound connections would bypass the proxy)', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const r = underSandbox('codex', `/usr/bin/python3 -c 'import socket; s=socket.socket(); s.bind(("${host}", 0)); s.listen(1); print("LISTENING")' 2>&1 || true`);
    assert.doesNotMatch(r.stdout, /LISTENING/, `${host}: ${r.stdout}`);
    assert.match(r.stdout, /Operation not permitted/, r.stdout);
  }
});

// --- budget and config gaps (second red-team round) ---

test('a wrong shape under budgets.projects or aliases is refused, not ignored', () => {
  for (const own of [
    { budgets: { projects: { myapp: 'none' } } },
    { budgets: { projects: { myapp: { cursor: 'none' } } } },
    { budgets: { projects: { myapp: { cursor: { maxRunsPerDya: 3 } } } } },
    { budgets: { projects: { 'my app': { cursor: { maxRunsPerDay: 3 } } } } },
    { aliases: { fast: null } },
  ]) assert.ok(validateConfig(own).length > 0, `accepted: ${JSON.stringify(own)}`);
  assert.deepEqual(validateConfig({ budgets: { projects: { myapp: { cursor: { maxRunsPerDay: 3 } } } }, aliases: { fast: { target: 'codex' } } }), []);
});

test('a forged target-reported duration does not count toward the minute budget', async () => {
  const { totalsFor } = await import('../src/summary.js');
  const t = totalsFor([{ tool: 'cursor', startedAt: new Date().toISOString(), ok: true, wallMs: 1000, usage: { durationMs: 1e12 } }]);
  assert.equal(t.cursorAgentMs, 1000);
});

test('a damaged task file neither blocks new tasks nor gets rewritten', () => {
  const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  // A running task with no prompt: reap() used to throw on it inside the queue lock.
  fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify({ id, state: 'running', target: 'cursor', startedAt: '2000-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(tasksDir, '22222222-2222-4222-8222-222222222222.json'), 'null');
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(tasksDir, 'undefined.json')));
});

// --- git version gate ---

import { parseGitVersion } from '../src/worktree.js';

test('parseGitVersion reads plain and vendor git version strings', () => {
  assert.deepEqual(parseGitVersion('git version 2.54.0 (Apple Git-157)\n'), [2, 54, 0]);
  assert.deepEqual(parseGitVersion('git version 2.41.0.windows.1'), [2, 41, 0]);
  assert.deepEqual(parseGitVersion('git version 2.40'), [2, 40, 0]);
  assert.equal(parseGitVersion('hub version 1'), null);
});

test('a task is refused on git older than 2.41, before any worktree is made', () => {
  // A git that reports 2.40.0 and otherwise behaves like the real one.
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const bin = fs.mkdtempSync(path.join(home, 'oldgit-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "git version 2.40.0"; exit 0; }\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const r = nuncius(['cursor', 'x'], { extraEnv: { PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /git 2\.40\.0 is too old: nuncius needs git 2\.41\.0 or newer/);
  const wts = path.join(env.NUNCIUS_HOME + '-worktrees');
  assert.ok(!fs.existsSync(wts) || fs.readdirSync(wts).length === 0, 'no worktree created');
  // The same run with the real git goes through.
  assert.equal(nuncius(['cursor', 'x']).status, 0);
});

// --- nuncius doctor ---

test('nuncius doctor proves the sandbox on this machine', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const r = nuncius(['doctor', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(out.ok, true);
  for (const target of ['codex', 'cursor', 'claude']) {
    const mine = out.checks.filter((c) => c.group === `${target} sandbox`);
    assert.ok(mine.length >= 8, `${target}: ${mine.length} checks`);
    assert.ok(mine.every((c) => c.status === 'ok' || c.status === 'skip'), JSON.stringify(mine));
    assert.equal(mine.find((c) => /control/.test(c.name)).status, 'ok');
  }
});

test('nuncius doctor fails when the config loosens the sandbox', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  writeConfig({ sandbox: { passEnv: ['FAKE_*'], extraWritable: ['/private/tmp'] } });
  const r = nuncius(['doctor', '--json']);
  assert.equal(r.status, 1, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  const tmp = out.checks.filter((c) => c.name === 'cannot write to the shared /tmp');
  assert.equal(tmp.length, 3);
  assert.ok(tmp.every((c) => c.status === 'fail'), JSON.stringify(tmp));
  // The probe file it managed to write is gone again.
  assert.deepEqual(fs.readdirSync('/private/tmp').filter((n) => n.startsWith('nuncius-doctor-')), []);
});

// --- small gaps (second red-team round) ---

test('a huge answer is cut before it reaches the caller; the full output stays in runs/', () => {
  writeConfig({ cursorBin: probe(`node -e 'console.log(JSON.stringify({ type: "result", is_error: false, result: "x".repeat(400000), duration_ms: 1 }))'; exit 0`) });
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
  const [file] = fs.readdirSync(tasksDir).filter((n) => n.endsWith('.json'));
  const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8'));
  assert.ok(task.result.output.length < 300 * 1024, `stored ${task.result.output.length}`);
  assert.match(task.result.output, /\[nuncius: answer cut at 262144 of 400000 characters; the full output is in .*\.out\]$/);
  assert.ok(r.stdout.length < 300 * 1024, 'the CLI prints the capped answer too');
  const raw = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${task.id}.out`), 'utf8');
  assert.ok(raw.length > 400000, 'full output kept');
});

test('inherited GIT_DIR / GIT_WORK_TREE cannot point nuncius at another repository', () => {
  const other = initRepo(path.join(home, 'other'));
  const branches = (r) => execFileSync('git', ['-C', r, 'branch', '--list', 'nuncius/*'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  const r = nuncius(['cursor', 'x'], { extraEnv: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cursor · repo ·/, 'the project is the repo nuncius was run in');
  assert.equal(branches(other), '', 'nothing created in the other repository');
  const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
  const [file] = fs.readdirSync(tasksDir).filter((n) => n.endsWith('.json'));
  const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8'));
  assert.equal(task.worktree.root, fs.realpathSync(repo), 'the worktree was made from the repo nuncius was run in');
});

test('a queued task whose worker pid now belongs to another program does not block the queue', () => {
  const stranger = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  try {
    const tasksDir = path.join(env.NUNCIUS_HOME, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const id = '55555555-0000-4000-8000-000000000001';
    // An older queued task for the same target, its worker pid reused by an unrelated live process.
    fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify({ id, prompt: 'x', state: 'queued', target: 'cursor', createdAt: new Date(Date.now() - 60000).toISOString(), queuedAt: new Date(Date.now() - 60000).toISOString(), workerPid: stranger.pid }));
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), 'cursor', 'x'], { env, cwd: repo, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `blocked behind the stale task: ${r.signal ?? ''} ${r.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tasksDir, `${id}.json`), 'utf8')).state, 'failed');
  } finally {
    stranger.kill();
  }
});

// --- untested CLI versions ---

test('an untested CLI version: doctor warns, and later runs carry a note, but nothing is refused', async () => {
  // Before any check has read the version, a run starts no extra process and prints no note.
  const before = nuncius(['cursor', 'x'], { extraEnv: { FAKE_VERSION: '2099.1.1' } });
  assert.equal(before.status, 0, before.stderr);
  assert.doesNotMatch(before.stderr, /\[nuncius\] note:/);
  assert.equal(fs.existsSync(path.join(env.NUNCIUS_HOME, 'cli-versions.json')), false, 'the run did not start the CLI to read its version');
  const doc = JSON.parse(nuncius(['doctor', '--json'], { extraEnv: { FAKE_VERSION: '2099.1.1' } }).stdout);
  const cursor = doc.checks.find((c) => c.group === 'targets' && c.name.startsWith('cursor'));
  assert.equal(cursor.status, 'warn');
  assert.equal(doc.ok, true, 'a warning is not a failure');
  // Doctor read the version, so every later run of that binary notes it, and still runs.
  const after = nuncius(['cursor', 'x']);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stderr, /\[nuncius\] note: Cursor 2099\.1\.1 is newer than the versions nuncius was verified with/);
});

// --- git inside tasks ---

test('a target can run git in its worktree (the denied global git config is not fatal)', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  // ~/.gitconfig is denied to targets; git used to stop with "unable to access" on every command.
  // (This reproduces only where ~/.gitconfig exists, as on most developer machines.)
  // Codex and Claude run with the real $HOME (Cursor gets a throw-away one), so a Codex-shaped target.
  const p = path.join(home, 'git-codex.sh');
  fs.writeFileSync(p, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\n{ git log --oneline -1; git status --short; } > gitout.txt 2>&1\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n', { mode: 0o755 });
  writeConfig({ codexBin: p });
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const branch = /changes on (nuncius\/codex\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  const out = execFileSync('git', ['-C', repo, 'show', `${branch}:gitout.txt`], { encoding: 'utf8' });
  assert.doesNotMatch(out, /fatal|unable to access/, out);
  assert.match(out, /^[0-9a-f]{7,} /m, 'git log printed the commit');
});

// --- home folder: read allowlist ---

test('the home folder is closed to targets except the task, its git data, toolchains and allowed paths', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  // A fake home with known contents (buildProfile reads $HOME).
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(home, 'fakehome-')));
  const put = (rel, body = 'x') => { fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true }); fs.writeFileSync(path.join(fake, rel), body); };
  put('notes.txt'); put('.zshrc'); put('.cache/hf/token'); put('repo/.env'); put('repo/.git/HEAD', 'ref: refs/heads/main\n');
  put('.cargo/bin/cargo'); put('.cargo/credentials.toml'); put('tools/bin/mytool'); put('allowed/data.txt');
  fs.mkdirSync(path.join(fake, 'wt', '.git'), { recursive: true });
  put('wt/file.txt', 'in worktree');
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = fake;
  process.env.PATH = `${path.join(fake, 'tools', 'bin')}:${saved.PATH}`;
  let profile;
  try {
    profile = buildProfile({ worktree: path.join(fake, 'wt'), callerRepo: path.join(fake, 'repo'), gitDir: path.join(fake, 'repo', '.git'), target: 'codex', proxyPort: 1, runtimeDirs: [], runCwd: path.join(fake, 'wt'), config: { extraReadable: [path.join(fake, 'allowed')] } });
  } finally {
    Object.assign(process.env, saved);
  }
  const sb = path.join(home, 'home-allowlist.sb');
  fs.writeFileSync(sb, profile);
  const can = (cmd) => spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', `${cmd} >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'utf8', cwd: path.join(fake, 'wt') }).stdout.trim();
  const readable = {
    'the worktree': can('cat file.txt'),
    'getcwd in the worktree': can('/bin/pwd -P'),
    "the repo's git dir": can(`cat ${fake}/repo/.git/HEAD`),
    'a PATH folder in home': can(`cat ${fake}/tools/bin/mytool`),
    'a toolchain folder': can(`cat ${fake}/.cargo/bin/cargo`),
    'sandbox.extraReadable': can(`cat ${fake}/allowed/data.txt`),
  };
  const closed = {
    'a file in home': can(`cat ${fake}/notes.txt`),
    'listing home': can(`ls ${fake}`),
    'shell config': can(`cat ${fake}/.zshrc`),
    "the repo's ignored .env": can(`cat ${fake}/repo/.env`),
    'a credential in a toolchain folder': can(`cat ${fake}/.cargo/credentials.toml`),
    '~/.cache': can(`cat ${fake}/.cache/hf/token`),
  };
  for (const [what, r] of Object.entries(readable)) assert.equal(r, 'yes', `should be readable: ${what}`);
  for (const [what, r] of Object.entries(closed)) assert.equal(r, 'no', `should be closed: ${what}`);
});

test('a target cannot even start a nuncius that lives in the home folder', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  // First line of defence before the canary: nuncius's own code is unreadable when it is installed in
  // the home folder (as this checkout is on a developer machine). Skipped when it is not.
  if (!root.startsWith(os.homedir() + path.sep)) return;
  writeConfig({ cursorBin: probe(`"${process.execPath}" "${path.join(root, 'bin', 'nuncius.js')}" codex inner > nested.out 2>&1`) });
  const r = nuncius(['cursor', 'x']);
  const branch = /changes on (nuncius\/cursor\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  const out = execFileSync('git', ['-C', repo, 'show', `${branch}:nested.out`], { encoding: 'utf8' });
  assert.match(out, /Cannot find module|Operation not permitted/, out);
});

test('zsh here-documents work inside a task (TMPPREFIX points at the task\'s own temp)', { skip: (!sandboxAvailable() || !fs.existsSync('/bin/zsh')) && 'needs sandbox-exec and zsh' }, () => {
  writeConfig({ cursorBin: probe("/bin/zsh -c 'cat <<EOF\nheredoc-ok\nEOF' > heredoc.out 2>&1") });
  const r = nuncius(['cursor', 'x']);
  const branch = /changes on (nuncius\/cursor\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  assert.equal(execFileSync('git', ['-C', repo, 'show', `${branch}:heredoc.out`], { encoding: 'utf8' }).trim(), 'heredoc-ok');
});

// --- allowlist review follow-ups ---

test('a target\'s git works without reading the repository config (remote tokens stay hidden)', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://user:SECRET-TOKEN@example.com/r.git']);
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', 'echo FSMONITOR-RAN']);
  const p = path.join(home, 'git-codex.sh');
  fs.writeFileSync(p, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\n{ git log --oneline -1; git status --short; git remote -v; git config --get core.fsmonitor; cat "$(git rev-parse --git-common-dir)/config"; echo end; } > gitout.txt 2>&1\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n', { mode: 0o755 });
  writeConfig({ codexBin: p });
  const r = nuncius(['codex', 'x']);
  const branch = /changes on (nuncius\/codex\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  const out = execFileSync('git', ['-C', repo, 'show', `${branch}:gitout.txt`], { encoding: 'utf8' });
  assert.match(out, /^[0-9a-f]{7,} /m, `git log works:\n${out}`);
  assert.doesNotMatch(out, /SECRET-TOKEN|example\.com|FSMONITOR|fatal/, out);
});

test('a broad PATH entry or a CLI installed directly in the home folder opens nothing extra', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(home, 'fakehome2-')));
  fs.writeFileSync(path.join(fake, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(fake, 'Documents', 'work'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'Documents', 'work', 'secret.txt'), 'x');
  fs.writeFileSync(path.join(fake, 'mycli'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(fake, '.cargo'), { recursive: true });
  fs.writeFileSync(path.join(fake, '.cargo', 'config.toml'), '[registries.x]\ntoken = "t"\n');
  fs.mkdirSync(path.join(fake, 'wt', '.git'), { recursive: true });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = fake;
  process.env.PATH = `${fake}:${path.join(fake, 'Documents')}:${saved.PATH}`;
  let profile;
  try {
    profile = buildProfile({ worktree: path.join(fake, 'wt'), target: 'codex', proxyPort: 1, runtimeDirs: [], runCwd: path.join(fake, 'wt'), targetBin: path.join(fake, 'mycli') });
  } finally {
    Object.assign(process.env, saved);
  }
  const sb = path.join(home, 'narrow.sb');
  fs.writeFileSync(sb, profile);
  const can = (cmd) => spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', `${cmd} >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'utf8', cwd: path.join(fake, 'wt') }).stdout.trim();
  assert.equal(can(`cat ${fake}/mycli`), 'yes', 'the CLI file itself stays readable');
  assert.equal(can(`cat ${fake}/notes.txt`), 'no', 'PATH=$HOME does not open the home folder');
  assert.equal(can(`cat ${fake}/Documents/work/secret.txt`), 'no', 'PATH=~/Documents does not open it');
  assert.equal(can(`cat ${fake}/.cargo/config.toml`), 'no', 'cargo config (registry tokens) is closed');
});

test('a PATH folder or toolchain folder that links to the home folder opens nothing', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(home, 'fakehome3-')));
  fs.writeFileSync(path.join(fake, 'notes.txt'), 'x');
  fs.symlinkSync(fake, path.join(fake, 'bin')); // ~/bin -> ~
  fs.symlinkSync(fake, path.join(fake, '.nvm')); // a toolchain folder -> ~
  fs.mkdirSync(path.join(fake, 'wt', '.git'), { recursive: true });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = fake;
  process.env.PATH = `${path.join(fake, 'bin')}:${saved.PATH}`;
  let profile;
  try {
    profile = buildProfile({ worktree: path.join(fake, 'wt'), target: 'codex', proxyPort: 1, runtimeDirs: [], runCwd: path.join(fake, 'wt') });
  } finally {
    Object.assign(process.env, saved);
  }
  const sb = path.join(home, 'links.sb');
  fs.writeFileSync(sb, profile);
  const r = spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', `cat ${fake}/notes.txt >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'utf8', cwd: path.join(fake, 'wt') }).stdout.trim();
  assert.equal(r, 'no');
});

test('per-worktree git config (config.worktree) stays closed and git still works', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  execFileSync('git', ['-C', repo, 'config', 'extensions.worktreeConfig', 'true']);
  execFileSync('git', ['-C', repo, 'config', '--worktree', 'remote.origin.url', 'https://user:WT-SECRET@example.com/r.git']);
  const p = path.join(home, 'git-codex.sh');
  fs.writeFileSync(p, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\n{ git log --oneline -1; git config --get remote.origin.url; cat "$(git rev-parse --git-common-dir)/../.git/config.worktree" "$(git rev-parse --git-dir)/config.worktree"; echo end; } > gitout.txt 2>&1\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n', { mode: 0o755 });
  writeConfig({ codexBin: p });
  const r = nuncius(['codex', 'x']);
  const branch = /changes on (nuncius\/codex\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  const out = execFileSync('git', ['-C', repo, 'show', `${branch}:gitout.txt`], { encoding: 'utf8' });
  assert.match(out, /^[0-9a-f]{7,} /m, out);
  assert.doesNotMatch(out, /WT-SECRET|fatal/, out);
});

test('no opened folder may contain the home folder (links to / or /Users, extraReadable, the CLI folder)', { skip: !sandboxAvailable() && 'needs sandbox-exec' }, () => {
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(home, 'fakehome4-')));
  fs.writeFileSync(path.join(fake, 'notes.txt'), 'x');
  fs.symlinkSync('/', path.join(fake, '.nvm')); // a toolchain folder -> /
  fs.symlinkSync(path.dirname(fake), path.join(fake, '.volta')); // -> the folder that contains home
  fs.mkdirSync(path.join(fake, 'wt', '.git'), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = fake;
  let profile;
  try {
    // A CLI whose real file sits in the folder that contains home, and an extraReadable of '/'.
    const cli = path.join(path.dirname(fake), `cli-${path.basename(fake)}`);
    fs.writeFileSync(cli, '#!/bin/sh\n');
    profile = buildProfile({ worktree: path.join(fake, 'wt'), target: 'codex', proxyPort: 1, runtimeDirs: [], runCwd: path.join(fake, 'wt'), targetBin: cli, config: { extraReadable: ['/'] } });
  } finally {
    process.env.HOME = saved;
  }
  const sb = path.join(home, 'ancestors.sb');
  fs.writeFileSync(sb, profile);
  const r = spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', `cat ${fake}/notes.txt >/dev/null 2>&1 && echo yes || echo no`], { encoding: 'utf8', cwd: path.join(fake, 'wt') }).stdout.trim();
  assert.equal(r, 'no');
});
