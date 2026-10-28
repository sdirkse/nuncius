import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCursorModels } from '../src/targets.js';
import { initRepo } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env, server;

function writeConfig(extra = {}) {
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({ codexBin: path.join(fixtures, 'fake-codex.js'), cursorBin: path.join(fixtures, 'fake-cursor.js'), ...extra }),
  );
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-mcp-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true }); // exists after `codex login`; the sandbox does not let targets create it
  writeConfig();
});

afterEach(() => server?.kill());

// Start `nuncius mcp` and return a request() helper speaking newline-delimited JSON-RPC.
function startServer(clientName = 'claude-code', extraEnv = {}) {
  server = spawn('node', [path.join(root, 'bin', 'nuncius.js'), 'mcp'], { env: { ...env, ...extraEnv }, cwd: repo });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  server.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args) => {
    const msg = await request('tools/call', { name, arguments: args });
    return msg.result;
  };
  return request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' }, capabilities: {} }).then((init) => {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { init, request, call };
  });
}

test('initialize and tools/list expose the five tools', async () => {
  const { init, request } = await startServer();
  assert.equal(init.result.serverInfo.name, 'nuncius');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await request('tools/list');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_targets', 'run_task', 'get_task', 'wait_task', 'usage']);
  const unknown = await request('nope/method');
  assert.equal(unknown.error.code, -32601);
});

test('list_targets shows the installed targets, discovered models and configured aliases', async () => {
  writeConfig({ aliases: { strong: { target: 'codex' }, review: { target: 'other' } } });
  const { call } = await startServer('cursor-vscode');
  const res = (await call('list_targets', {})).structuredContent;
  assert.equal(res.caller, 'cursor');
  const cursor = res.targets.find((t) => t.name === 'cursor');
  assert.equal(cursor.is_caller, true);
  assert.deepEqual(cursor.models, ['composer-1.5', 'gpt-5.3-codex', 'sonnet-4.5']);
  // Codex's models come from `codex app-server` model/list, its default first.
  assert.deepEqual(res.targets.find((t) => t.name === 'codex').models, ['fake-sol', 'fake-luna']);
  assert.equal(res.aliases.strong.target, 'codex');
  assert.equal(res.aliases.review.target, 'codex', 'review never resolves to the caller');
  // Each target reports its CLI version; a verified one carries no note.
  assert.equal(cursor.version, '2026.10.16');
  assert.equal(cursor.version_note, undefined);
});

test('list_targets notes a CLI version outside the verified range', async () => {
  const { call } = await startServer('claude-code', { FAKE_VERSION: '2099.1.1' });
  const cursor = (await call('list_targets', {})).structuredContent.targets.find((t) => t.name === 'cursor');
  assert.equal(cursor.version, '2099.1.1');
  assert.match(cursor.version_note, /newer than the versions nuncius was verified with/);
});

test('without configured aliases there are none, and only installed, enabled targets are offered', async () => {
  writeConfig({ claudeBin: '/nope/claude', targets: { cursor: { enabled: false } } });
  const { init, call } = await startServer();
  assert.match(init.result.instructions, /Available here: Codex\./);
  assert.doesNotMatch(init.result.instructions, /alias/);
  const res = (await call('list_targets', {})).structuredContent;
  assert.deepEqual(res.aliases, {});
  writeConfig({ claudeBin: '/nope/claude', targets: { cursor: { enabled: false } }, aliases: { opus: { target: 'claude', model: 'opus' } } });
  const withAlias = (await call('list_targets', {})).structuredContent;
  assert.match(withAlias.aliases.opus.error, /claude is not available: \/nope\/claude not found on PATH/);
  assert.deepEqual(res.targets.map((t) => t.name), ['codex']);
  assert.deepEqual(res.unavailable.map((u) => [u.name, u.reason]), [['cursor', 'disabled in the config (targets.cursor.enabled)'], ['claude', '/nope/claude not found on PATH']]);
  const refused = await call('run_task', { target: 'cursor', prompt: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cursor is not available: disabled in the config/);
});

test('run_task finishes synchronously when quick', async () => {
  const { call } = await startServer();
  const res = await call('run_task', { target: 'codex', prompt: 'write tests', cwd: repo, agent: 'backend-dev' });
  assert.ok(!res.isError, res.content?.[0]?.text);
  const t = res.structuredContent;
  assert.equal(t.state, 'done');
  assert.equal(t.result.output, 'Done: write tests');
  assert.equal(t.result.usage.totalTokens, 12800);
  assert.equal(t.agent, 'backend-dev');
  assert.equal(t.result.rawStdout, undefined, 'raw output stays out of the tool result');
  const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].id, t.id);
  assert.equal(log[0].caller, 'claude-code');
});

test('run_task hands back an id when slow, wait_task collects the result', async () => {
  const { call } = await startServer();
  const started = (await call('run_task', { target: 'cursor', prompt: 'refactor SLEEP:1500', cwd: repo, wait_seconds: 0.2 })).structuredContent;
  assert.equal(started.state, 'running');
  assert.match(started.next, /wait_task/);
  const peek = (await call('get_task', { id: started.id })).structuredContent;
  assert.equal(peek.state, 'running');
  const done = (await call('wait_task', { id: started.id, timeout_seconds: 10 })).structuredContent;
  assert.equal(done.state, 'done');
  assert.equal(done.result.output, 'Cursor did: refactor SLEEP:1500');
});

test('a running task reports its progress; a finished one keeps it', async () => {
  const { call } = await startServer();
  const started = (await call('run_task', { target: 'cursor', prompt: 'refactor WRITE:a.txt SLEEP:2500', cwd: repo, wait_seconds: 0.2 })).structuredContent;
  assert.equal(started.state, 'running');
  // Progress is saved at most every few seconds; the first events arrive straight away.
  let peek;
  for (let i = 0; i < 40; i++) {
    peek = (await call('get_task', { id: started.id })).structuredContent;
    if (peek.progress?.commands) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(peek.state, 'running');
  assert.equal(peek.progress.timeoutSeconds, 1800);
  assert.equal(peek.progress.commands, 1);
  assert.equal(peek.progress.filesEdited, 1);
  assert.equal(peek.progress.lastActivity.what, 'edit a.txt');
  assert.equal(peek.progress.quiet, false);
  assert.match(peek.next, /^Still running: \d+ s of at most 30 min, last activity \d+ s ago\. Call wait_task/);
  assert.doesNotMatch(peek.next, /a\.txt/, 'target-controlled labels stay out of the hint');
  const done = (await call('wait_task', { id: started.id, timeout_seconds: 10 })).structuredContent;
  assert.equal(done.state, 'done');
  assert.equal(done.progress.filesEdited, 1);
  assert.ok(done.progress.elapsedSeconds >= 2);
  // The full activity log: a start marker, every step, and an end marker with the counts.
  const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${started.id}.activity.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((e) => e.kind), ['start', 'command', 'edit', 'end']);
  assert.equal(log[0].what, 'Started · Cursor');
  assert.equal(log.at(-1).what, 'Done · 2 steps · 1 file edited · 1 command');
});

test('queue respects the per-target limit and runs FIFO', async () => {
  writeConfig({ concurrency: { perTarget: 1, total: 4 } });
  const { call } = await startServer();
  const a = (await call('run_task', { target: 'codex', prompt: 'first SLEEP:1200', cwd: repo, wait_seconds: 0.3 })).structuredContent;
  const b = (await call('run_task', { target: 'codex', prompt: 'second', cwd: repo, wait_seconds: 0.3 })).structuredContent;
  assert.equal(a.state, 'running');
  assert.equal(b.state, 'queued');
  const q = (await call('usage', {})).structuredContent.queue;
  assert.deepEqual(q.perTarget.codex, { running: 1, queued: 1 });
  const bDone = (await call('wait_task', { id: b.id, timeout_seconds: 10 })).structuredContent;
  const aDone = (await call('get_task', { id: a.id })).structuredContent;
  assert.equal(bDone.state, 'done');
  assert.ok(Date.parse(bDone.startedAt) >= Date.parse(aDone.finishedAt), 'second task starts after the first finishes');
});

test('tasks are killed after the timeout', async () => {
  writeConfig({ tasks: { timeoutSeconds: 0.5 } });
  const { call } = await startServer();
  const t = (await call('run_task', { target: 'cursor', prompt: 'forever SLEEP:5000', cwd: repo, wait_seconds: 10 })).structuredContent;
  assert.equal(t.state, 'timeout');
  assert.match(t.result.error, /timed out/);
  // What the target did before it was stopped is kept: in the progress and in its raw output.
  assert.equal(t.progress.commands, 1);
  const out = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${t.id}.out`), 'utf8');
  assert.match(out, /shellToolCall/);
  const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${t.id}.activity.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).kind, 'end');
  assert.match(log.at(-1).what, /^Timed out after \d+ s · 1 step · 0 files edited · 1 command$/);
});

test('nested nuncius calls are refused (recursion guard)', async () => {
  const { call } = await startServer('claude-code', { NUNCIUS_DEPTH: '1' });
  const t = (await call('run_task', { target: 'codex', prompt: 'x', cwd: repo })).structuredContent;
  assert.equal(t.state, 'refused');
  assert.match(t.result.error, /nested nuncius call/);
  const cli = spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), 'codex', 'x'], { env: { ...env, NUNCIUS_DEPTH: '1' }, cwd: repo, encoding: 'utf8' });
  assert.equal(cli.status, 3);
});

test('targets get NUNCIUS_DEPTH=1 in their environment', async () => {
  const probe = path.join(home, 'probe.sh');
  fs.writeFileSync(probe, '#!/bin/sh\necho "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"depth=$NUNCIUS_DEPTH\\",\\"duration_ms\\":1}"\n');
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const { call } = await startServer();
  const t = (await call('run_task', { target: 'cursor', prompt: 'x', cwd: repo })).structuredContent;
  assert.equal(t.result.output, 'depth=1');
});

test('bad input comes back as a tool error, not a crash', async () => {
  const { call } = await startServer();
  for (const args of [{ target: 'gemini', prompt: 'x' }, { target: 'codex', prompt: '' }, { target: 'codex', prompt: 'x', cwd: '/nope/missing' }, { target: 'codex', prompt: 'x', model: '--dangerously-bypass-approvals-and-sandbox' }]) {
    const res = await call('run_task', args);
    assert.equal(res.isError, true, JSON.stringify(args));
  }
  assert.equal((await call('get_task', { id: '../../etc/passwd' })).isError, true);
});

test('cursor model list parsing (real 2026-10 format) and compact summary', async () => {
  assert.deepEqual(parseCursorModels('Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\ngpt-5.3-codex-fast - Codex 5.3 Fast\ncomposer-2.5 - Composer 2.5\n'), ['auto', 'gpt-5.3-codex', 'gpt-5.3-codex-fast', 'composer-2.5']);
  const { modelSummary } = await import('../src/mcp.js');
  const many = Array.from({ length: 80 }, (_, i) => `m${i}-x`).flatMap((m) => [m, `${m}-fast`, `${m}-high`]);
  const s = modelSummary(many);
  assert.equal(s.models_total, 240);
  assert.equal(s.models.length, 30);
  assert.ok(s.models.every((m) => !m.endsWith('-fast')));
  assert.equal(modelSummary(many, true).models.length, 240);
});

test('cursor model list parsing', () => {
  assert.deepEqual(parseCursorModels('Available models:\n  * composer-1.5 (current)\n  - gpt-5.3-codex-low\nTip: use --model\n'), ['composer-1.5', 'gpt-5.3-codex-low']);
});

test('garbage depth values count as nested', async () => {
  for (const v of ['abc', '-1', '0.5', ' 1']) {
    const cli = spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), 'codex', 'x'], { env: { ...env, NUNCIUS_DEPTH: v }, cwd: repo, encoding: 'utf8' });
    assert.equal(cli.status, 3, `NUNCIUS_DEPTH=${JSON.stringify(v)}`);
  }
});

test('a target that unsets NUNCIUS_DEPTH is still caught by the process tree check', async () => {
  const probe = path.join(home, 'sneaky.sh');
  fs.writeFileSync(
    probe,
    `#!/bin/sh\nenv -u NUNCIUS_DEPTH "${process.execPath}" "${path.join(root, 'bin', 'nuncius.js')}" codex inner >/dev/null 2>&1\n` +
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"inner_exit=$?\\",\\"duration_ms\\":1}"\n',
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const { call } = await startServer();
  const t = (await call('run_task', { target: 'cursor', prompt: 'x', cwd: repo, wait_seconds: 20 })).structuredContent;
  // Inside the sandbox the nested nuncius cannot even reach its data dir, so it fails before submitting.
  assert.match(t.result.output, /inner_exit=[1-9]/);
  assert.equal(fs.readdirSync(path.join(env.NUNCIUS_HOME, 'tasks')).filter((n) => n.endsWith('.json')).length, 1, 'no inner task was created');
});

test('MCP callers cannot pick the project used for budgets', async () => {
  const { call } = await startServer();
  const t = (await call('run_task', { target: 'codex', prompt: 'x', cwd: repo, project: 'someone-else' })).structuredContent;
  assert.equal(t.project, 'repo');
});

test('recursion guard: a target that unsets the depth and points NUNCIUS_HOME elsewhere is still refused', async () => {
  const probe = path.join(home, 'nested.sh');
  const fakeHome = path.join(home, 'attacker-home');
  fs.writeFileSync(
    probe,
    `#!/bin/sh\nmkdir -p "${fakeHome}"\n` +
      `env -u NUNCIUS_DEPTH NUNCIUS_HOME="${fakeHome}" "${process.execPath}" "${path.join(root, 'bin', 'nuncius.js')}" codex inner >"${home}/inner.out" 2>&1\n` +
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"inner_exit=$?\\",\\"duration_ms\\":1}"\n',
  );
  fs.chmodSync(probe, 0o755);
  // nuncius's own code must be readable for the nested run to start at all: this repo may sit in the home
  // folder, which targets cannot read. The canary must still stop a nuncius installed elsewhere.
  writeConfig({ cursorBin: probe, sandbox: { extraWritable: [home], extraReadable: [root] } }); // the probe writes the nested run's output into the test home
  const { call } = await startServer();
  const t = (await call('run_task', { target: 'cursor', prompt: 'x', cwd: repo, wait_seconds: 30 })).structuredContent;
  assert.equal(t.result.output, 'inner_exit=3', fs.readFileSync(path.join(home, 'inner.out'), 'utf8'));
  assert.match(fs.readFileSync(path.join(home, 'inner.out'), 'utf8'), /nested nuncius call/);
});

test('recursion guard: a detached (reparented) nested nuncius is caught by the canary', async () => {
  const out = path.join(home, 'detached.out');
  const probe = path.join(home, 'detach.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport fs from 'node:fs';\n` +
      `const env = { ...process.env, NUNCIUS_HOME: ${JSON.stringify(path.join(home, 'attacker-home2'))} };\ndelete env.NUNCIUS_DEPTH;\n` +
      // Grandchild: detached shell that waits until its parent is gone (reparented to launchd), then runs nuncius.
      `const c = spawn('/bin/sh', ['-c', 'sleep 1; ' + JSON.stringify(process.execPath) + ' ' + ${JSON.stringify(JSON.stringify(path.join(root, 'bin', 'nuncius.js')))} + ' codex inner > ' + ${JSON.stringify(JSON.stringify(out))} + ' 2>&1; echo "exit=$?" >> ' + ${JSON.stringify(JSON.stringify(out))}], { detached: true, stdio: 'ignore', env, cwd: ${JSON.stringify(home)} });\n` +
      `c.unref();\nconsole.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: 'spawned' }));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe, sandbox: { extraWritable: [home], extraReadable: [root] } }); // the detached probe writes the nested run's output into the test home; nuncius's code readable (see above)
  const { call } = await startServer();
  await call('run_task', { target: 'cursor', prompt: 'x', cwd: repo, wait_seconds: 30 });
  for (let i = 0; i < 100 && !(fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('exit=')); i++) await new Promise((r) => setTimeout(r, 100));
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /exit=3/, text);
  assert.match(text, /nested nuncius call/);
});

test('initialize hands every client the delegation workflow', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { createHandlers, instructions } = await import('../src/mcp.js');
  const { handle } = createHandlers({ defaultCwd: repo });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cursor' } } });
  assert.equal(init.instructions, instructions());
  for (const step of ['list_targets', 'run_task', 'wait_task', 'worktree.review', 'sensitiveFiles', 'untrusted']) assert.ok(init.instructions.includes(step), step);
  // Aliases come from the config: the text names the ones that exist, not a fixed list.
  assert.match(instructions({ aliases: { quick: { target: 'cursor' }, second: { target: 'other' } } }), /alias: quick, second \(never picks your own tool\)/);
  assert.doesNotMatch(instructions({ aliases: {} }), /alias/);
});

test('initialize only agrees to protocol versions it implements', async () => {
  const { request } = await startServer();
  const ask = async (v) => (await request('initialize', { protocolVersion: v, clientInfo: { name: 'x' }, capabilities: {} })).result.protocolVersion;
  assert.equal(await ask('2025-03-26'), '2025-03-26');
  assert.equal(await ask('2099-01-01'), '2025-06-18');
  assert.equal(await ask(undefined), '2025-06-18');
});

test('usage includes Claude limits, or why they are missing', async () => {
  const { call } = await startServer();
  const res = (await call('usage', {})).structuredContent;
  assert.ok('claudeLimits' in res);
  assert.equal(res.claudeLimits, null);
  assert.match(res.claudeLimitsHint, /install-statusline|has not run|Pro and Max/);
});

test('list_targets: limits are an object or null for every target, with a hint when missing', async () => {
  const { call } = await startServer();
  const res = (await call('list_targets', {})).structuredContent;
  const claude = res.targets.find((t) => t.name === 'claude');
  assert.equal(claude.limits, null);
  assert.equal(typeof claude.limits_hint, 'string');
});

test('run_task: wait_seconds null means the default, and agent names are cleaned and capped', async () => {
  writeConfig({ tasks: { syncWaitSeconds: 30 } });
  const { call } = await startServer();
  const res = (await call('run_task', { target: 'codex', prompt: 'x', wait_seconds: null, agent: `a\nb${'z'.repeat(200)}` })).structuredContent;
  assert.equal(res.state, 'done', 'null waited the default instead of returning at once');
  assert.equal(res.agent.length, 64);
  assert.doesNotMatch(res.agent, /\n/);
  const odd = (await call('run_task', { target: 'codex', prompt: 'y', agent: { not: 'a string' } })).structuredContent;
  assert.equal(odd.agent, 'claude-code');
});

test('the server keeps answering while a task snapshot is being made', async () => {
  // Many untracked files make createWorktree slow; a ping sent meanwhile must not wait for it.
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x'.repeat(2000));
  const { request } = await startServer();
  const started = Date.now();
  const run = request('tools/call', { name: 'run_task', arguments: { target: 'codex', prompt: 'x', wait_seconds: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  const pingAt = Date.now();
  await request('ping');
  const pinged = Date.now();
  const res = await run;
  const done = Date.now();
  assert.ok(res.result.structuredContent.id, JSON.stringify(res));
  assert.ok(pinged - pingAt < (done - started) / 2 || done - started < 100, `ping took ${pinged - pingAt} ms while run_task took ${done - started} ms`);
});

test('a cancelled wait stops and gets no reply; the task runs on', async () => {
  const slow = path.join(home, 'slow-codex.sh');
  fs.writeFileSync(slow, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\nsleep 3\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n');
  fs.chmodSync(slow, 0o755);
  writeConfig({ codexBin: slow });
  const { request, call } = await startServer();
  const first = await call('run_task', { target: 'codex', prompt: 'x', wait_seconds: 0 });
  const id = first.structuredContent.id;
  let replied = false;
  request('tools/call', { name: 'wait_task', arguments: { id, timeout_seconds: 60 } }).then(() => (replied = true));
  await new Promise((r) => setTimeout(r, 200));
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }) + '\n');
  const later = await call('wait_task', { id, timeout_seconds: 30 });
  assert.equal(later.structuredContent.state, 'done', 'the task itself was not cancelled');
  assert.equal(replied, false, 'the cancelled request got no reply');
});
