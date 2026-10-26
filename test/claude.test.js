import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRepo } from './helpers.js';
import { hostAllowed, startProxy } from '../src/proxy.js';
import { claudeUsage } from '../src/runners/claude.js';
import { limitsFromStatusline } from '../src/claude-limits.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env;

const writeConfig = (extra = {}) =>
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({
      codexBin: path.join(fixtures, 'fake-codex.js'),
      cursorBin: path.join(fixtures, 'fake-cursor.js'),
      claudeBin: path.join(fixtures, 'fake-claude.js'),
      sandbox: { passEnv: ['FAKE_*'] },
      ...extra,
    }),
  );

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-claude-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude-config') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  writeConfig();
});

// install-/uninstall-statusline are refused from an agent (the test runner is one), so the tests
// call the same functions the command runs, with the same environment.
async function statuslineCmd(cmd, extraEnv = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { NUNCIUS_HOME: env.NUNCIUS_HOME, ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}), ...extraEnv });
  try {
    const m = await import('../src/statusline.js');
    const r = cmd === 'install-statusline' ? m.installStatusline() : m.uninstallStatusline();
    return { status: 0, stdout: `${r.message}\n` };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err) };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const nuncius = (args, { input, extraEnv = {} } = {}) =>
  spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), ...args], { env: { ...env, ...extraEnv }, cwd: repo, input, encoding: 'utf8' });
const lastTask = () => {
  const dir = path.join(env.NUNCIUS_HOME, 'tasks');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
};

test('claude target: runs headless with locked-down flags, logs tokens, commits work', () => {
  writeConfig({ sandbox: { passEnv: ['FAKE_*'], extraWritable: [home] } }); // the fake writes a diagnostic args file into the test home
  const argsFile = path.join(home, 'args.json');
  const r = nuncius(['claude', 'WRITE:c.txt', '--', '--model', 'haiku'], { extraEnv: { FAKE_ARGS_FILE: argsFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Claude did: WRITE:c.txt\n');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  for (const flag of ['-p', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--permission-prompts']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'WebFetch,WebSearch');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args.at(-2), '--');
  const t = lastTask();
  assert.deepEqual(t.worktree.files, ['c.txt']);
  // modelUsage across both models: input incl. cache = 2510 + 105, output 70.
  assert.equal(t.result.usage.totalTokens, 2510 + 105 + 70);
  assert.equal(t.result.usage.apiCostEstimateUsd, 0.0123);
  assert.ok(t.egress.allow.includes('api.anthropic.com'));
});

test('claude target: callers cannot pass permission flags', () => {
  for (const extra of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--allowedTools', 'WebFetch'], ['--mcp-config', 'x.json'], ['--settings', '{}']]) {
    const r = nuncius(['claude', 'x', '--', ...extra]);
    assert.equal(r.status, 2, extra.join(' '));
  }
});

test('claude usage falls back to `usage` when modelUsage is missing', () => {
  const u = claudeUsage({ usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } });
  assert.equal(u.totalTokens, 20);
  assert.equal(u.cachedInputTokens, 10);
});

test('statusline bridge records Claude limits and passes input to the previous statusline', () => {
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const input = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 42.5, resets_at: resets }, seven_day: { used_percentage: 10, resets_at: resets + 86400 } } });
  let r = nuncius(['statusline'], { input });
  assert.equal(r.stdout, 'Opus · 5h 43% · week 10%');
  const limits = JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'claude-limits.json'), 'utf8'));
  assert.equal(limits.primary.usedPercent, 42.5);
  assert.equal(limits.primary.resetsAt, new Date(resets * 1000).toISOString());

  writeConfig({ claude: { statuslineCommand: 'cat > /dev/null; echo my-own-statusline' } });
  r = nuncius(['statusline'], { input });
  assert.equal(r.stdout.trim(), 'my-own-statusline');

  // Garbage input never breaks the statusline.
  r = nuncius(['statusline'], { input: 'not json' });
  assert.equal(r.status, 0);
});

test('Claude budget: refused when the recorded 5h window is over the limit', () => {
  nuncius(['statusline'], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 95, resets_at: Math.floor(Date.now() / 1000) + 600 } } }) });
  const r = nuncius(['claude', 'x']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Claude 5-hour window at 95%/);
});

test('limits that already reset do not block', () => {
  assert.equal(limitsFromStatusline({}), null);
  nuncius(['statusline'], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(Date.now() / 1000) - 60 } } }) });
  assert.equal(nuncius(['claude', 'x']).status, 0);
});

test('install-statusline wraps the existing statusline and uninstall restores it', async () => {
  const settingsPath = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const original = { model: 'opus', statusLine: { type: 'command', command: 'echo mine', padding: 1 } };
  fs.writeFileSync(settingsPath, JSON.stringify(original));
  let r = await statuslineCmd('install-statusline');
  assert.match(r.stdout, /passes input on to your previous command: echo mine/);
  const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.match(installed.statusLine.command, /nuncius\.js' statusline$/);
  assert.equal(installed.statusLine.padding, 1);
  assert.equal(installed.model, 'opus');
  assert.match((await statuslineCmd('install-statusline')).stdout, /already installed/);
  r = await statuslineCmd('uninstall-statusline');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), original);
});

test('install-statusline refuses to overwrite settings it cannot parse', async () => {
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settingsPath = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settingsPath, '{ not json');
  const r = await statuslineCmd('install-statusline');
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ not json');
});

test('proxy: host patterns', () => {
  assert.ok(hostAllowed('api.anthropic.com', ['api.anthropic.com']));
  assert.ok(hostAllowed('api2.cursor.sh', ['*.cursor.sh']));
  assert.ok(hostAllowed('cursor.sh', ['*.cursor.sh']));
  assert.ok(!hostAllowed('evilcursor.sh', ['*.cursor.sh']));
  assert.ok(!hostAllowed('api.anthropic.com.evil.io', ['api.anthropic.com']));
});

test('proxy: tunnels allowed hosts, refuses others, IPs and plain http', async () => {
  const echo = net.createServer((s) => (s.on('error', () => {}), s.pipe(s))).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const port = echo.address().port;
  const proxy = await startProxy({ allow: ['localhost'], ports: [port] });
  const connect = (target) =>
    new Promise((resolve) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let buf = '';
      let tunneled = false;
      s.on('error', () => {});
      s.on('data', (d) => {
        if (tunneled) return (s.end(), resolve(`200:${d}`));
        buf += d;
        if (!buf.includes('\r\n\r\n')) return;
        if (buf.startsWith('HTTP/1.1 200')) {
          tunneled = true;
          s.write('ping');
        } else (s.end(), resolve(buf.split('\r\n')[0]));
      });
    });
  assert.equal(await connect(`localhost:${port}`), '200:ping');
  assert.match(await connect(`127.0.0.1:${port}`), /403/, 'raw IPs are refused');
  assert.match(await connect('example.com:443'), /403/);
  assert.match(await connect(`localhost:${port + 1}`), /403/, 'only listed ports');
  assert.deepEqual([...proxy.seen.allowed], [`localhost:${port}`]);
  // A tunnel that is still open must not keep close() (and the task) hanging.
  const open = net.connect(proxy.port, '127.0.0.1', () => open.write(`CONNECT localhost:${port} HTTP/1.1\r\n\r\n`));
  open.on('error', () => {});
  await new Promise((r) => open.once('data', r));
  await proxy.close();
  await new Promise((r) => open.once('close', r));
  echo.close();
});

test('sandbox: targets cannot open direct connections, only the proxy', async () => {
  const server = net.createServer((s) => s.end('hello')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const probe = path.join(home, 'netprobe.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nimport net from 'node:net';\n` +
      `const s = net.connect(${port}, '127.0.0.1');\n` +
      `const done = (r) => { console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: r + ' proxy=' + (process.env.HTTPS_PROXY ? 'set' : 'unset') })); process.exit(0); };\n` +
      `s.on('connect', () => done('direct=OPEN')); s.on('error', (e) => done('direct=' + e.code));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const r = await new Promise((resolve) => {
    const c = spawn('node', [path.join(root, 'bin', 'nuncius.js'), 'cursor', 'x'], { env, cwd: repo });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out));
  });
  server.close();
  assert.match(r, /direct=(EPERM|EACCES)/);
  assert.match(r, /proxy=set/);
});

test('MCP: claude is a target, and `review` from Claude Code never picks claude', async () => {
  writeConfig({ aliases: { review: { target: 'other' } } });
  const server = spawn('node', [path.join(root, 'bin', 'nuncius.js'), 'mcp'], { env, cwd: repo });
  const lines = [];
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) (lines.push(JSON.parse(buf.slice(0, i))), (buf = buf.slice(i + 1)));
  });
  const send = (o) => server.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' }, capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_targets', arguments: {} } });
  while (!lines.find((l) => l.id === 2)) await new Promise((r) => setTimeout(r, 20));
  server.kill();
  const res = lines.find((l) => l.id === 2).result.structuredContent;
  const claude = res.targets.find((t) => t.name === 'claude');
  assert.equal(claude.is_caller, true);
  assert.deepEqual(claude.models, ['opus', 'sonnet', 'fable', 'haiku']);
  assert.equal(claude.limits, null);
  assert.match(claude.limits_hint, /install-statusline/);
  assert.notEqual(res.aliases.review.target, 'claude');
});

test('sandbox: targets cannot resolve hostnames themselves (no DNS exfiltration channel)', async () => {
  const probe = path.join(home, 'dnsprobe.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nimport dns from 'node:dns';\n` +
      `dns.lookup('nuncius-dns-probe.example.com', (e, a) => {\n` +
      `  console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: 'dns=' + (e ? e.code : 'RESOLVED:' + a) }));\n` +
      `});\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const out = await new Promise((resolve) => {
    const c = spawn('node', [path.join(root, 'bin', 'nuncius.js'), 'cursor', 'x'], { env, cwd: repo });
    let s = '';
    c.stdout.on('data', (d) => (s += d));
    c.on('close', () => resolve(s));
  });
  assert.match(out, /dns=(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPERM)/);
});

test('sandbox profile has no DNS socket allow and denies resolver services', async () => {
  const { buildProfile } = await import('../src/sandbox.js');
  for (const proxyPort of [undefined, 4321]) {
    const p = buildProfile({ worktree: repo, target: 'claude', proxyPort });
    assert.ok(!/allow network-outbound \(remote unix-socket/.test(p));
    assert.match(p, /deny mach-lookup .*com\.apple\.dnssd\.service/);
    const allows = p.split('\n').filter((l) => l.startsWith('(allow network-outbound'));
    assert.deepEqual(allows, proxyPort ? [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`] : []);
  }
});

test('sandbox: a CLAUDE_CONFIG_DIR under a temp dir is still not writable', async () => {
  const { buildProfile } = await import('../src/sandbox.js');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const profile = buildProfile({ worktree: repo, target: 'claude' });
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', `echo '{"hooks":{}}' > "${settings}"`], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(settings));
});

test('limit parsing drops malformed values instead of throwing', async () => {
  const { toIso, mergeLimits } = await import('../src/codex-limits.js');
  for (const v of ['not-a-date', 1e20, NaN, Infinity, -5, {}, null]) assert.equal(toIso(v), null, String(v));
  assert.equal(limitsFromStatusline({ rate_limits: { five_hour: { used_percentage: 'lots', resets_at: 'x' } } }), null);
  const l = limitsFromStatusline({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 'garbage' } } });
  assert.deepEqual(l.primary, { usedPercent: 50, windowMinutes: 300, resetsAt: null });
  // Merging trusted readings: the highest window that has not reset yet wins.
  const now = Date.now();
  const soon = new Date(now + 3600000).toISOString();
  const m = mergeLimits(
    { source: 'codex account', observedAt: new Date(now).toISOString(), primary: { usedPercent: 40, windowMinutes: 300, resetsAt: soon }, secondary: null },
    { source: 'codex sessions', observedAt: new Date(now - 60000).toISOString(), primary: { usedPercent: 90, windowMinutes: 300, resetsAt: new Date(now - 1000).toISOString() }, secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt: soon } },
  );
  assert.equal(m.primary.usedPercent, 40, 'a window that already reset does not count');
  assert.equal(m.secondary.usedPercent, 20);
  assert.equal(m.source, 'codex account + codex sessions');
});

test('a malformed rollout from a task still records usage', () => {
  const r = nuncius(['codex', 'x'], { extraEnv: { FAKE_CODEX_PRIMARY: 'abc', FAKE_CODEX_ROLLOUT_PRIMARY: 'abc' } });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).usage.totalTokens, 12800);
});
