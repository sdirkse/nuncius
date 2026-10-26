import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findDirectCall } from '../hooks/require-nuncius.js';
import { isAllowedHost } from '../src/server.js';
import { underAgent } from '../src/tasks.js';
import { initRepo } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex'), NUNCIUS_AGENT: 'tester' };
  delete env.NUNCIUS_PROJECT;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true }); // exists after `codex login`; the sandbox does not let targets create it
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({ codexBin: path.join(fixtures, 'fake-codex.js'), cursorBin: path.join(fixtures, 'fake-cursor.js'), budgets: { cursor: { maxRunsPerDay: 2 } }, sandbox: { passEnv: ['FAKE_*'], extraWritable: [home] } }),
  );
});

const aiRun = (args, extraEnv = {}) =>
  spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), ...args], { env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8' });
const log = () => fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('codex run prints final answer and logs tokens + rate limits', () => {
  const r = aiRun(['codex', '--project', 'unbound', 'write tests']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Done: write tests\n');
  assert.match(r.stderr, /12\.800 tokens · 5h 34% · week 12%/);
  const [rec] = log();
  assert.equal(rec.project, 'unbound');
  assert.equal(rec.agent, 'tester');
  assert.equal(rec.usage.totalTokens, 12800);
  assert.equal(rec.limits.primary.usedPercent, 34);
  assert.equal(rec.limits.primary.windowMinutes, 300);
});

test('codex refused when Codex reports its 5h window over the budget; agents cannot --force', () => {
  // Nuncius asks Codex itself (app-server, outside the sandbox) before it starts a task.
  const refused = aiRun(['codex', 'second'], { FAKE_CODEX_PRIMARY: '95' });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /5-hour window at 95%/);
  // Without a terminal (how agents run it) --force is refused, and the refusal does not offer it.
  assert.doesNotMatch(refused.stderr, /--force/);
  const noTty = aiRun(['codex', '--force', 'third'], { FAKE_CODEX_PRIMARY: '95' });
  assert.equal(noTty.status, 2);
  assert.match(noTty.stderr, /only works when you type it yourself in a terminal/);
});

// From a person's terminal (a pty via script(1)) --force overrides the budget. When the suite itself
// runs under an agent (Claude Code, Codex, Cursor), nuncius rightly refuses, so this only runs outside one.
test('--force overrides the budget from a terminal', { skip: underAgent() && 'the test runner is under an agent CLI; run npm test from a plain terminal' }, () => {
  const plainEnv = { ...env, FAKE_CODEX_PRIMARY: '95' };
  delete plainEnv.CLAUDECODE;
  const tty = spawnSync('/usr/bin/script', ['-q', '/dev/null', process.execPath, path.join(root, 'bin', 'nuncius.js'), 'codex', '--force', 'third'], { env: plainEnv, cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(tty.status, 0, tty.stdout);
  assert.deepEqual(log().map((r) => [r.ok, !!r.refused]), [[true, false]]);
});

test('cursor run logs duration and enforces runs per day', () => {
  const r = aiRun(['cursor', '--project', 'site', 'refactor']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Cursor did: refactor\n');
  assert.equal(log()[0].usage.durationMs, 95000);
  assert.equal(log()[0].usage.totalTokens, 4200, 'input + cache read + output');
  assert.equal(aiRun(['cursor', 'again']).status, 0);
  const third = aiRun(['cursor', 'third']);
  assert.equal(third.status, 3);
  assert.match(third.stderr, /Cursor runs today 2 >= daily cap 2/);
});

test('failures are logged with the error', () => {
  const r = aiRun(['cursor', 'FAIL please']);
  assert.equal(r.status, 1);
  assert.equal(log()[0].ok, false);
  assert.match(log()[0].error, /not logged in/);
});

test('a target whose CLI is missing is refused up front, not queued', () => {
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), JSON.stringify({ codexBin: '/nope/codex' }));
  const r = aiRun(['codex', 'hi']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /codex is not available: \/nope\/codex not found on PATH/);
  assert.equal(fs.existsSync(path.join(env.NUNCIUS_HOME, 'tasks')), false, 'nothing was queued');
});

test('project defaults to git repo name', () => {
  const other = initRepo(path.join(home, 'my-repo'));
  fs.mkdirSync(path.join(other, 'sub'));
  const r = spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), 'codex', 'x'], { env, cwd: path.join(other, 'sub'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(log()[0].project, 'my-repo');
});

test('status --json summarises per project', () => {
  aiRun(['codex', '--project', 'a', 'x']);
  aiRun(['cursor', '--project', 'b', 'y']);
  const s = JSON.parse(aiRun(['status', '--json']).stdout);
  assert.deepEqual(s.projects.map((p) => p.name).sort(), ['a', 'b']);
  assert.equal(s.today.codexTokens, 12800);
  assert.equal(s.today.cursorRuns, 1);
  assert.equal(s.daily.length, 7);
});

test('hook blocks direct runs and allows nuncius + housekeeping', () => {
  for (const cmd of ['codex exec "fix it"', 'cd x && codex "do it"', 'FOO=1 cursor-agent -p "hi"', 'npx @openai/codex exec hi', '/opt/homebrew/bin/codex exec y',
    'bash -c "codex exec hi"', 'sh -lc \'cursor-agent -p hi\'', 'echo $(codex exec hi)', 'echo `codex exec hi`',
    '(cd x && codex exec hi)', 'xargs codex exec < f', '\\codex exec hi', 'eval "codex exec hi"',
    'env -i codex exec hi', 'env -u HOME codex exec hi', 'sudo -u bob codex exec hi', 'nice -n 10 codex exec hi',
    'xargs -I {} codex exec {}', 'env -S "codex exec hi"', 'timeout 60 cursor-agent -p hi', 'nohup -- codex exec hi',
    'sudo --user=bob codex exec hi', 'env --unset HOME codex exec hi', "env -S'codex exec hi'", 'env --split-string=codex exec',
    'claude -p "fix it"', 'claude --print hi', 'cd x && claude -p hi', 'bash -c "claude -p hi"', 'claude --model haiku -p hi',
    'timeout 1.5m codex exec hi', 'timeout inf codex exec hi', 'nice --adjustment 5 codex exec hi', 'xargs --max-args 1 codex exec', 'sudo -u nuncius codex exec hi', 'bash -c "nuncius codex hi"'])
    assert.ok(findDirectCall(cmd), cmd);
  for (const cmd of ['nuncius codex "fix it"', 'codex --version', 'codex login', 'cursor-agent status', 'grep codex README.md', 'echo cursor-agent', 'sudo codex --version', 'npx @openai/codex login', 'claude', 'claude mcp list', 'claude --version', 'nuncius claude "hi"'])
    assert.equal(findDirectCall(cmd), null, cmd);
});

test('hook emits deny JSON', () => {
  const r = spawnSync('node', [path.join(root, 'hooks', 'require-nuncius.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'codex exec "hi"' } }),
    encoding: 'utf8',
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const ok = spawnSync('node', [path.join(root, 'hooks', 'require-nuncius.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'nuncius codex "hi"' } }),
    encoding: 'utf8',
  });
  assert.equal(ok.stdout, '');
});

test('dashboard only answers loopback Host headers', () => {
  for (const h of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317']) assert.ok(isAllowedHost(h, 4317), h);
  for (const h of ['evil.example:4317', 'localhost:9999', 'localhost.evil.example:4317', undefined]) assert.ok(!isAllowedHost(h, 4317), String(h));
});

test('prompt that looks like a flag is passed after --', () => {
  const argsFile = path.join(home, 'args.json');
  const r = aiRun(['codex', '--dangerously-bypass-approvals-and-sandbox'], { FAKE_ARGS_FILE: argsFile });
  assert.equal(r.status, 0, r.stderr);
  let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(args.slice(0, -1), ['exec', '--json', '--sandbox', 'danger-full-access', '--']);
  assert.ok(args.at(-1).endsWith('Task:\n--dangerously-bypass-approvals-and-sandbox'));
  aiRun(['cursor', '--yolo'], { FAKE_ARGS_FILE: argsFile });
  args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(args.slice(0, -1), ['-p', '--output-format', 'json', '--force', '--disable-auto-update', '--']);
  assert.ok(args.at(-1).endsWith('Task:\n--yolo'));
});

test('allowed extra args pass through, everything else is refused', () => {
  const argsFile = path.join(home, 'args.json');
  const ok = aiRun(['codex', 'hi', '--', '--model', 'gpt-5-codex', '-c', 'model_reasoning_effort=high'], { FAKE_ARGS_FILE: argsFile });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')).slice(0, -1), ['exec', '--json', '--sandbox', 'danger-full-access', '--model', 'gpt-5-codex', '-c', 'model_reasoning_effort=high', '--']);
  assert.equal(aiRun(['cursor', 'hi', '--', '--model=sonnet-4']).status, 0);
  for (const [tool, extra] of [
    ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
    ['codex', ['--sandbox', 'danger-full-access']],
    ['codex', ['-s', 'danger-full-access']],
    ['codex', ['-c', 'sandbox_mode=danger-full-access']],
    ['codex', ['--profile', 'yolo']],
    ['codex', ['--model', '--dangerously-bypass-approvals-and-sandbox']],
    ['codex', ['--model']],
    ['cursor', ['--force']],
    ['cursor', ['-f']],
    ['cursor', ['-c', 'model_reasoning_effort=high']],
  ]) {
    const r = aiRun([tool, 'hi', '--', ...extra]);
    assert.equal(r.status, 2, `${tool} ${extra.join(' ')}`);
    assert.match(r.stderr, /not allowed|invalid value/);
  }
  // Refused args never reach the target, so nothing is logged for them.
  assert.equal(log().length, 2);
});

test('a top-level nuncius run through a shell is not mistaken for a nested call', () => {
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${path.join(root, 'bin', 'nuncius.js')}" codex "hello from a shell"`], { env, cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /nested nuncius call/);
});
