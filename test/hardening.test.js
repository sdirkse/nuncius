import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRepo } from './helpers.js';

// Regression tests for the hardening review: each test names the behaviour it pins down.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env;

const writeConfig = (extra = {}) =>
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({ codexBin: path.join(fixtures, 'fake-codex.js'), cursorBin: path.join(fixtures, 'fake-cursor.js'), sandbox: { passEnv: ['FAKE_*'] }, ...extra }),
  );

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-hard-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  writeConfig();
});

const nuncius = (args, { cwd = repo, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), ...args], { env: { ...env, ...extraEnv }, cwd, encoding: 'utf8' });
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

const tasks = () => {
  const dir = path.join(env.NUNCIUS_HOME, 'tasks');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
const usage = () => fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// A cursor-shaped probe: a shell script whose last line prints the result object.
const probe = (body, result = 'ok') => {
  const p = path.join(home, `probe-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\necho "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"${result}\\",\\"duration_ms\\":1}"\n`);
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

// --- Sandbox and environment ---

test('targetEnv drops secrets from the caller environment and keeps what the target needs', async () => {
  const { targetEnv } = await import('../src/sandbox.js');
  const src = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', CURSOR_API_KEY: 'c', MY_VAR: '1', MY_OTHER: '2' };
  assert.deepEqual(Object.keys(targetEnv('claude', src)).sort(), ['ANTHROPIC_API_KEY', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'HOME', 'LC_ALL', 'PATH']);
  assert.deepEqual(Object.keys(targetEnv('codex', src)).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'HOME', 'LC_ALL', 'OPENAI_API_KEY', 'PATH']);
  assert.equal(targetEnv('codex', { ...src, GIT_CONFIG_GLOBAL: '/h/evil' }, ['GIT_*']).GIT_CONFIG_GLOBAL, '/dev/null', 'never the caller\'s global git config');
  assert.deepEqual(Object.keys(targetEnv('cursor', src, ['MY_*'])).sort(), ['CURSOR_API_KEY', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1', 'HOME', 'LC_ALL', 'MY_OTHER', 'MY_VAR', 'PATH']);
});

test('a target sees neither nuncius\'s secrets nor the shared TMPDIR', () => {
  writeConfig({ cursorBin: probe('T=${GITHUB_TOKEN:-unset}; echo hi > "$TMPDIR/x" && W=writable || W=denied', 'token=$T tmp=$W:$TMPDIR') });
  const r = nuncius(['cursor', 'x'], { extraEnv: { GITHUB_TOKEN: 'ghp_secret', TMPDIR: os.tmpdir() } });
  const [token, tmp] = r.stdout.trim().split(' ');
  assert.equal(token, 'token=unset', r.stderr);
  const [state, dir] = tmp.slice(4).split(':');
  assert.equal(state, 'writable');
  assert.notEqual(path.resolve(dir), path.resolve(os.tmpdir()));
  assert.ok(dir.includes('tmp-'), dir);
  assert.ok(!fs.existsSync(dir), 'the per-task TMPDIR is removed afterwards');
});

test('real() resolves a path that does not exist yet through its existing ancestors', async () => {
  const { real } = await import('../src/sandbox.js');
  const missing = path.join(os.tmpdir(), 'nuncius-not-there', 'deeper');
  assert.equal(real(missing), path.join(fs.realpathSync(os.tmpdir()), 'nuncius-not-there', 'deeper'));
});

test('the profile denies launchd job creation', async () => {
  const { buildProfile } = await import('../src/sandbox.js');
  assert.match(buildProfile({ worktree: repo, target: 'codex' }), /\(deny job-creation\)/);
});

// --- Processes ---

test('run(): background processes die with the target, and UTF-8 split across writes stays intact', async () => {
  const { run } = await import('../src/spawn.js');
  const pidFile = path.join(home, 'bg.pid');
  const script = `(sleep 30 & echo $! > "${pidFile}"); node -e 'const b=Buffer.from("é");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)'`;
  const res = await run('/bin/sh', ['-c', script], { cwd: home });
  assert.equal(res.stdout, 'é');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, 'the background sleep was killed');
});

test('run(): a timeout kills the whole process group, not only the direct child', async () => {
  const { run } = await import('../src/spawn.js');
  const pidFile = path.join(home, 'child.pid');
  const res = await run('/bin/sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: home, timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

// --- Caller surfaces ---

test('names like "constructor" or "__proto__" are not targets, aliases or tools', async () => {
  const { isTarget, resolveTarget } = await import('../src/targets.js');
  for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(isTarget(n), false, n);
    assert.ok(resolveTarget(n, { config: { aliases: {} } }).error, n);
  }
  const { createHandlers } = await import('../src/mcp.js');
  const { handle } = createHandlers({ defaultCwd: repo });
  await assert.rejects(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'constructor', arguments: {} } }), /unknown tool/);
});

test('the MCP server answers invalid requests (null, arrays, numbers) and keeps running', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), 'mcp'], {
    env, cwd: repo, encoding: 'utf8', timeout: 10000,
    input: ['null', '[]', '42', '{"jsonrpc":"2.0","id":7,"method":"ping"}', ''].join('\n'),
  });
  const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(replies.slice(0, 3).map((x) => x.error.code), [-32600, -32600, -32600]);
  assert.deepEqual(replies[3], { jsonrpc: '2.0', id: 7, result: {} });
});

test('summary: a "__proto__" agent or project is just a name, nothing is polluted', async () => {
  const { summarise } = await import('../src/summary.js');
  const now = new Date();
  const s = summarise([{ tool: 'codex', project: '__proto__', agent: '__proto__', startedAt: now.toISOString(), ok: true, wallMs: 5, usage: { totalTokens: 10 } }], { now });
  assert.deepEqual(s.projects.map((p) => [p.name, p.codexTokens]), [['__proto__', 10]]);
  assert.deepEqual(s.agents.map((a) => a.name), ['__proto__']);
  assert.equal({}.runs, undefined);
});

test('summary: refused or unstarted runs do not count, forged usage numbers are ignored, Cursor time has a floor', async () => {
  const { totalsFor } = await import('../src/summary.js');
  const t = totalsFor([
    { tool: 'claude', ok: false, refused: true },
    { tool: 'claude', ok: false, started: false },
    { tool: 'codex', ok: true, wallMs: 10, usage: { totalTokens: -1e9, inputTokens: NaN, outputTokens: '5' } },
    { tool: 'cursor', ok: true, wallMs: 60000, usage: { durationMs: 1, totalTokens: 7 } },
  ]);
  assert.equal(t.claudeRuns, 0);
  assert.equal(t.notRun, 2);
  assert.equal(t.codexTokens, 0);
  assert.equal(t.cursorAgentMs, 60000);
  assert.equal(t.cursorTokens, 7);
});

test('the hook catches background, keyword and `agent` forms of direct calls', async () => {
  const { findDirectCall } = await import('../hooks/require-nuncius.js');
  for (const c of ['codex exec x &', 'sleep 1 & codex exec hi', 'if codex exec x; then :; fi', '! codex exec x', 'while true; do cursor-agent -p hi; done', 'agent -p hi', 'cat <(codex exec x)'])
    assert.ok(findDirectCall(c), c);
  for (const c of ['agent status', 'grep agent x', 'echo hi 2>&1', 'nuncius codex hi', 'nuncius status', 'grep -- --force nuncius.md']) assert.equal(findDirectCall(c), null, c);
  // Budget overrides, plain or with a terminal faked by script/unbuffer.
  for (const c of ['nuncius codex --force hi', 'script -q /dev/null nuncius codex --force hi', 'unbuffer node bin/nuncius.js claude --force x', 'cd x && nuncius cursor --force=1 y', 'nuncius codex --for""ce x', "nuncius codex --fo\\rce x", "n'uncius' codex '--force' x"])
    assert.equal(findDirectCall(c)?.tool, 'nuncius --force', c);
});

test('nuncius refuses --force under an agent even on a terminal, whatever the shell did to the argument', async () => {
  const { underAgent } = await import('../src/tasks.js');
  assert.equal(underAgent({ CLAUDECODE: '1' }, []), true);
  assert.equal(underAgent({}, ['/bin/zsh', 'node /opt/homebrew/bin/claude --resume']), true);
  assert.equal(underAgent({}, ['/bin/zsh', '/usr/local/bin/codex exec x']), true);
  assert.equal(underAgent({}, null), true, 'fails closed without ps');
  assert.equal(underAgent({}, ['/bin/zsh -l', '/Applications/iTerm.app/Contents/MacOS/iTerm2']), false);
  // A terminal faked with script(1), with the flag built by the shell: still refused under CLAUDECODE.
  const r = spawnSync('/bin/sh', ['-c', `F=--for; /usr/bin/script -q /dev/null "${process.execPath}" "${path.join(root, 'bin', 'nuncius.js')}" codex "\${F}ce" x`], {
    env: { ...env, CLAUDECODE: '1' }, cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not from an agent/);
});

test('blocked models are refused before anything runs', () => {
  writeConfig({ targets: { codex: { blockedModels: ['gpt-9*'] } } });
  const r = nuncius(['codex', 'x', '--', '--model', 'GPT-9-turbo']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /model "GPT-9-turbo" is blocked for codex/);
  assert.equal(nuncius(['codex', 'x', '--', '--model', 'gpt-8']).status, 0);
});

test('review and apply commands quote paths for the shell', async () => {
  const { shQuote } = await import('../src/worktree.js');
  const evil = path.join(home, `it's $(touch pwned) \`x\``);
  const out = execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(evil)}`], { cwd: home }).toString();
  assert.equal(out, evil);
  assert.equal(fs.existsSync(path.join(home, 'pwned')), false);
});

test('install-statusline keeps a symlinked settings.json a symlink, with its mode', async () => {
  const cfg = path.join(home, 'claude-config');
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(cfg);
  fs.mkdirSync(dotfiles);
  fs.writeFileSync(path.join(dotfiles, 'settings.json'), '{"theme":"dark"}\n', { mode: 0o640 });
  fs.chmodSync(path.join(dotfiles, 'settings.json'), 0o640);
  fs.symlinkSync(path.join(dotfiles, 'settings.json'), path.join(cfg, 'settings.json'));
  const r = await statuslineCmd('install-statusline', { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(cfg, 'settings.json')).isSymbolicLink());
  const settings = JSON.parse(fs.readFileSync(path.join(dotfiles, 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.match(settings.statusLine.command, /statusline$/);
  assert.equal(fs.statSync(path.join(dotfiles, 'settings.json')).mode & 0o777, 0o640);
});

test('nuncius tasks escapes terminal control characters in project names and prompts', () => {
  nuncius(['cursor', '--project', 'p\x1b[31m', 'hello\x1b]0;x\x07']);
  const out = nuncius(['tasks']).stdout;
  assert.doesNotMatch(out, /\x1b/);
  assert.match(out, /\\u001b/);
});

// --- Correctness ---

test('the recursion guard recognises installed `nuncius` links and paths with spaces', async () => {
  const { NUNCIUS_TASK_CMD } = await import('../src/tasks.js');
  assert.match('node /opt/homebrew/bin/nuncius __worker 1234', NUNCIUS_TASK_CMD);
  assert.match('/usr/local/bin/node /Users/a b/nuncius/bin/nuncius.js codex hi', NUNCIUS_TASK_CMD);
  assert.doesNotMatch('/bin/sh -c nuncius codex hi', NUNCIUS_TASK_CMD);
  assert.doesNotMatch('node /x/nuncius status', NUNCIUS_TASK_CMD);
});

test('a task whose worktree took long to create is not reaped before its worker starts', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  process.env.CODEX_HOME = env.CODEX_HOME;
  const { submitTask, updateTask, readTask } = await import('../src/tasks.js');
  const t = await submitTask({ target: 'codex', prompt: 'x', cwd: repo, project: 'p', agent: 'a' });
  assert.equal(t.state, 'queued', t.error);
  updateTask(t.id, { createdAt: new Date(Date.now() - 120000).toISOString() }); // created 2 min ago, queued just now
  const r = nuncius(['__worker', t.id]);
  assert.equal(readTask(t.id).state, 'done', r.stderr);
});

test('a running task far past its timeout stops holding its slot', () => {
  writeConfig({ tasks: { timeoutSeconds: 1 }, concurrency: { perTarget: 1, total: 1 } });
  fs.mkdirSync(path.join(env.NUNCIUS_HOME, 'tasks'), { recursive: true });
  // A live process that looks like a nuncius worker (nuncius checks the pid's command, not just the pid).
  const fakeNuncius = path.join(env.NUNCIUS_HOME, 'nuncius.js');
  fs.writeFileSync(fakeNuncius, 'setTimeout(() => {}, 60000);\n');
  const worker = spawn(process.execPath, [fakeNuncius, '__worker', '11111111-1111-4111-8111-111111111111'], { stdio: 'ignore' });
  try {
    const hung = { id: '11111111-1111-4111-8111-111111111111', target: 'codex', prompt: 'hung', state: 'running', workerPid: worker.pid, createdAt: new Date(Date.now() - 600000).toISOString(), startedAt: new Date(Date.now() - 600000).toISOString() };
    fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'tasks', `${hung.id}.json`), JSON.stringify(hung));
    const r = nuncius(['codex', 'next']);
    assert.equal(r.status, 0, r.stderr);
    const after = tasks().find((t) => t.id === hung.id);
    assert.equal(after.state, 'failed');
    assert.match(after.result.error, /did not finish within the task timeout/);
    // Its activity log ends with what happened to it, about ten minutes in.
    const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'runs', `${hung.id}.activity.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.at(-1).kind, 'end');
    assert.match(log.at(-1).what, /^Stopped: worker did not finish within the task timeout · 0 steps/);
    assert.ok(log.at(-1).s >= 599, String(log.at(-1).s));
  } finally {
    worker.kill();
  }
});

test('a lock left by a dead process is taken over', () => {
  const lock = path.join(env.NUNCIUS_HOME, 'queue.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), '999999:dead');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lock, old, old);
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(lock), false);
});

test('an error after the target ran still ends the task as failed, with one usage record', () => {
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'runs'), 'not a dir'); // nuncius cannot write runs/<id>.out
  const r = nuncius(['codex', 'x']);
  assert.notEqual(r.status, 0);
  const t = tasks().at(-1);
  assert.equal(t.state, 'failed');
  assert.equal(usage().filter((u) => u.id === t.id).length, 1);
  // The run broke off after it started: the record still gets its time and its last progress.
  assert.ok(t.wallMs >= 0);
  assert.equal(t.progress.commands, 0);
});

test('a scratch file the target made immutable does not break the task', () => {
  writeConfig({ cursorBin: probe('mkdir "$TMPDIR/d" && echo x > "$TMPDIR/d/f" && /usr/bin/chflags uchg "$TMPDIR/d/f"; echo "$TMPDIR" > "' + path.join(home, 'tmpdir') + '"'), sandbox: { passEnv: ['FAKE_*'], extraWritable: [home] } });
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(usage().length, 1);
  const dir = fs.readFileSync(path.join(home, 'tmpdir'), 'utf8').trim();
  assert.equal(fs.existsSync(dir) || fs.existsSync(`${dir}.sealed`), false, 'the scratch dir was removed anyway');
});

test('a Codex login refresh inside a task is reported', () => {
  fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), '{"tokens":{}}');
  const fake = path.join(home, 'codex-probe.sh');
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\nrm -f "$CODEX_HOME/auth.json"; echo "{}" > "$CODEX_HOME/auth.json"\n' +
    'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\'\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n');
  fs.chmodSync(fake, 0o755);
  writeConfig({ codexBin: fake });
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Codex rewrote its login/);
  assert.equal(fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"tokens":{}}', 'the real login is untouched');
});

test('git output nuncius reports ignores user diff config, in-tree .gitattributes and renames', async () => {
  const gitconfig = path.join(home, 'gitconfig');
  fs.writeFileSync(gitconfig, '[diff]\n\tnoprefix = true\n\trenames = true\n\texternal = /bin/false\n[color]\n\tui = always\n');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'line one\nline two\nline three\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'old'], { cwd: repo });
  writeConfig({ cursorBin: probe('mv old.txt new.txt; echo "* -diff" > .gitattributes; ln -s /etc .claude') });
  const r = nuncius(['cursor', 'x'], { extraEnv: { GIT_CONFIG_GLOBAL: gitconfig } });
  assert.equal(r.status, 0, r.stderr);
  const wt = tasks().at(-1).worktree;
  assert.deepEqual([...wt.files].sort(), ['.claude', '.gitattributes', 'new.txt', 'old.txt']);
  assert.ok(wt.sensitiveFiles.includes('.claude'), 'a symlinked .claude is flagged');
  assert.match(wt.diffStat, /new\.txt +\| 3 \+\+\+/);
  const patch = fs.readFileSync(wt.patchPath, 'utf8');
  assert.match(patch, /^diff --git a\/new\.txt b\/new\.txt$/m);
  assert.doesNotMatch(patch, /\x1b\[/);
});

test('an untracked nested repository does not break the snapshot', () => {
  initRepo(path.join(repo, 'vendor', 'lib'));
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked\n');
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const t = tasks().at(-1);
  assert.ok(t.worktree.skippedUntracked.some((p) => p.startsWith('vendor/')), JSON.stringify(t.worktree.skippedUntracked));
});

test('cleanup saves the work of a failed task on its branch before removing the checkout', () => {
  const failing = path.join(home, 'fail.sh');
  fs.writeFileSync(failing, '#!/bin/sh\necho wip > work.txt\nexit 1\n');
  fs.chmodSync(failing, 0o755);
  writeConfig({ cursorBin: failing });
  assert.notEqual(nuncius(['cursor', 'x']).status, 0);
  const t = tasks().at(-1);
  assert.equal(t.state, 'failed');
  const r = nuncius(['cleanup', '--days', '0']);
  assert.match(r.stdout, /saved its unfinished work as [0-9a-f]{12}/, r.stdout);
  assert.equal(fs.existsSync(t.worktree.path), false);
  assert.equal(execFileSync('git', ['show', `${t.worktree.branch}:work.txt`], { cwd: repo }).toString(), 'wip\n');
});

test('a failed task without a worktree does not point at one', async () => {
  const { publicTask } = await import('../src/tasks.js');
  const out = publicTask({ id: 'x', state: 'failed', target: 'codex', prompt: 'p', createdAt: '', worktree: { branch: 'b', path: '/gone', removed: true } });
  assert.equal(out.next, undefined);
});

test('Cursor runs without a usage object report tokens as unknown, not zero', async () => {
  const { cursorUsage } = await import('../src/runners/cursor.js');
  assert.equal(cursorUsage({ duration_ms: 5 }).totalTokens, null);
  assert.equal(cursorUsage({ usage: { inputTokens: 2, outputTokens: 3 } }).totalTokens, 5);
});

// --- install-hook ---

test('install-hook adds the guard once, keeps other hooks, and uninstall-hook removes only its own entry', async () => {
  const cfg = path.join(home, 'claude-hooks');
  fs.mkdirSync(cfg);
  const other = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [other] } }));
  const run = (cmd) => nuncius([cmd], { extraEnv: { CLAUDE_CONFIG_DIR: cfg } });
  const read = () => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));

  assert.match(run('install-hook').stdout, /PreToolUse hook added/);
  assert.match(run('install-hook').stdout, /already installed/);
  const groups = read().hooks.PreToolUse;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], other);
  assert.equal(groups[1].matcher, 'Bash');
  const command = groups[1].hooks[0].command;
  assert.ok(fs.existsSync(path.join(cfg, 'settings.json.nuncius-hook-backup')));

  // The installed command really runs the hook and denies a direct call.
  const denied = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ tool_input: { command: 'codex exec hi' } }), encoding: 'utf8' });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ tool_input: { command: 'nuncius codex hi' } }), encoding: 'utf8' });
  assert.equal(allowed.stdout, '');

  // Removing the guard is refused from an agent (simulated with Claude Code's marker, so the test
  // means the same from a plain terminal as under an agent); the function itself works.
  const refused = nuncius(['uninstall-hook'], { extraEnv: { CLAUDE_CONFIG_DIR: cfg, CLAUDECODE: '1' } });
  assert.match(refused.stderr, /only works when you run it yourself/);
  assert.equal(read().hooks.PreToolUse.length, 2, 'the hook is still installed');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const { uninstallHook } = await import('../src/hook-install.js');
  assert.match(uninstallHook().message, /removed the nuncius hook/);
  assert.deepEqual(read(), { theme: 'dark', hooks: { PreToolUse: [other] } });
  assert.match(uninstallHook().message, /not installed/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('nuncius dashboard on a busy port says so instead of crashing', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    const r = nuncius(['dashboard', '--port', String(port)]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`port ${port} is already in use`));
    assert.doesNotMatch(r.stderr, /Unhandled 'error' event/);
  } finally {
    blocker.close();
  }
});

// --- Dashboard and automatic cleanup ---

test('the dashboard summary says which targets this user has', async () => {
  writeConfig({ claudeBin: '/nope/claude', targets: { cursor: { enabled: false } } });
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { buildSummary } = await import('../src/server.js');
  const s = buildSummary({ days: 7 });
  assert.deepEqual(s.targets.map((t) => [t.name, t.available]), [['codex', true], ['cursor', false], ['claude', false]]);
  assert.match(nuncius(['status']).stdout, /Targets: codex ✓ · cursor – disabled in the config \(targets\.cursor\.enabled\) · claude – \/nope\/claude not found on PATH/);
});

test('applied worktrees are removed automatically; unapplied ones stay', async () => {
  writeConfig({ cursorBin: probe('echo applied > a.txt') });
  assert.equal(nuncius(['cursor', 'one']).status, 0);
  writeConfig({ cursorBin: probe('echo pending > b.txt') });
  assert.equal(nuncius(['cursor', 'two']).status, 0);
  const [applied, pending] = tasks();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', applied.worktree.commit], { cwd: repo, stdio: 'ignore' });
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { autoCleanup } = await import('../src/cleanup.js');
  const removed = autoCleanup({ force: true });
  assert.deepEqual(removed.map((a) => a.id), [applied.id]);
  assert.equal(fs.existsSync(applied.worktree.path), false);
  assert.equal(fs.existsSync(pending.worktree.path), true);
});

test('the task detail endpoint returns the full prompt and refuses anything that is not a task id', async () => {
  const long = `Goal: ${'x'.repeat(400)} END`;
  assert.equal(nuncius(['codex', long]).status, 0);
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { taskDetail } = await import('../src/server.js');
  const t = taskDetail(tasks().at(-1).id);
  assert.equal(t.prompt, long);
  assert.equal(t.usage.totalTokens, 12800);
  for (const bad of ['../config', '', null, '__proto__']) assert.equal(taskDetail(bad), null, String(bad));
});

test('summary splits tokens per tool into input, cached and output', async () => {
  const { totalsFor } = await import('../src/summary.js');
  const t = totalsFor([
    { tool: 'claude', ok: true, usage: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120 } },
    { tool: 'cursor', ok: true, usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 3, totalTokens: 13 } },
  ]);
  assert.deepEqual([t.claudeInputTokens, t.claudeCachedTokens, t.claudeOutputTokens, t.claudeTokens], [100, 60, 20, 120]);
  assert.deepEqual([t.cursorInputTokens, t.cursorCachedTokens, t.cursorOutputTokens, t.cursorTokens], [10, 5, 3, 13]);
});

// --- Claude limits bridge ---

test('the bridge records each run, so nuncius can say why Claude limits are missing', async () => {
  const { claudeLimitsHint } = await import('../src/claude-limits.js');
  assert.match(claudeLimitsHint({ installed: false, seen: null }), /nuncius install-statusline/);
  assert.match(claudeLimitsHint({ installed: true, seen: null }), /has not run yet/);
  assert.match(claudeLimitsHint({ installed: true, seen: { at: 'x', rateLimits: false } }), /Pro and Max/);
  writeConfig({ claudeBin: path.join(fixtures, 'fake-claude.js') }); // status explains missing limits only when Claude is installed
  const run = (input) => spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), 'statusline'], { env, input, encoding: 'utf8' });
  run(JSON.stringify({ model: { display_name: 'Opus' } })); // e.g. an API-key session: no rate_limits
  const seen = JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'statusline-seen.json'), 'utf8'));
  assert.equal(seen.rateLimits, false);
  assert.deepEqual(Object.keys(seen).sort(), ['at', 'rateLimits']);
  // The bridge installed in a test Claude config, not whatever the real ~/.claude has.
  const claudeConfig = { CLAUDE_CONFIG_DIR: path.join(home, 'claude-config') };
  fs.mkdirSync(claudeConfig.CLAUDE_CONFIG_DIR);
  const statusLine = { type: 'command', command: `'${process.execPath}' '${path.join(root, 'bin', 'nuncius.js')}' statusline` };
  fs.writeFileSync(path.join(claudeConfig.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ statusLine }));
  assert.match(nuncius(['status'], { extraEnv: claudeConfig }).stdout, /Claude Code sent no limits/);
  run(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 4102444800 } } }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'statusline-seen.json'), 'utf8')).rateLimits, true);
});

test('commands written into settings.json use a node path that survives upgrades', async () => {
  const { stableNode } = await import('../src/claude-settings.js');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, `/nowhere:${bin}`), path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, '/nowhere'), process.execPath);
});

test('install-statusline refreshes a bridge installed with an outdated command', async () => {
  const cfg = path.join(home, 'claude-old');
  fs.mkdirSync(cfg);
  const old = `'/opt/old/node' '${path.join(root, 'bin', 'nuncius.js')}' statusline`;
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: old, padding: 1 } }));
  const r = await statuslineCmd('install-statusline', { CLAUDE_CONFIG_DIR: cfg });
  assert.match(r.stdout, /updated the bridge command/);
  const sl = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')).statusLine;
  assert.notEqual(sl.command, old);
  assert.equal(sl.padding, 1);
  assert.match((await statuslineCmd('install-statusline', { CLAUDE_CONFIG_DIR: cfg })).stdout, /already installed/);
});

// --- Even budgets ---

test('every tool has the same daily caps, across all projects and per project', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { checkBudget } = await import('../src/budget.js');
  const now = new Date();
  const rec = (tool, project, tokens, wallMs) => ({ tool, project, ok: true, startedAt: now.toISOString(), wallMs, usage: { totalTokens: tokens } });
  const records = [rec('codex', 'p', 100, 60000), rec('claude', 'p', 200, 120000), rec('cursor', 'p', 300, 180000), rec('cursor', 'q', 999, 1000)];
  const none = { maxTokensPerDay: null, maxRunsPerDay: null, maxAgentMinutesPerDay: null, max5HourPercent: null, maxWeeklyPercent: null };
  const config = (budgets) => ({ budgets: { codex: { ...none }, claude: { ...none }, cursor: { ...none }, projects: {}, ...budgets } });
  const check = (tool, budgets, project = 'p') => checkBudget({ tool, project, config: config(budgets), records, now, codexLimits: null });

  // Global: runs for Codex (new), minutes for Claude (new), tokens for Cursor.
  assert.match(check('codex', { codex: { ...none, maxRunsPerDay: 1 } }).join(), /Codex runs today 1 >= daily cap 1/);
  assert.match(check('claude', { claude: { ...none, maxAgentMinutesPerDay: 2 } }).join(), /Claude agent time today 2 min >= daily cap 2 min/);
  assert.match(check('cursor', { cursor: { ...none, maxTokensPerDay: 1000 } }).join(), /Cursor tokens today 1299 >= daily cap 1000/);

  // Per project, every kind for every tool, counting only that project: the same shape as the global caps.
  for (const [tool, key, cap, re] of [
    ['codex', 'maxTokensPerDay', 100, /Project p: Codex tokens today 100 >= cap 100/],
    ['codex', 'maxAgentMinutesPerDay', 1, /Project p: Codex agent time today 1 min >= cap 1 min/],
    ['claude', 'maxRunsPerDay', 1, /Project p: Claude runs today 1 >= cap 1/],
    ['cursor', 'maxTokensPerDay', 300, /Project p: Cursor tokens today 300 >= cap 300/],
    ['cursor', 'maxAgentMinutesPerDay', 3, /Project p: Cursor agent time today 3 min >= cap 3 min/],
  ]) assert.match(check(tool, { projects: { p: { [tool]: { [key]: cap } } } }).join(), re, `${tool}.${key}`);
  assert.deepEqual(check('cursor', { projects: { p: { cursor: { maxTokensPerDay: 301 } } } }), [], 'project q does not count for p');

  // Not a number: no cap. A project named __proto__ is just a name.
  assert.deepEqual(check('codex', { codex: { ...none, maxRunsPerDay: '1' } }), []);
  assert.deepEqual(check('codex', { projects: {} }, '__proto__'), []);
});

// --- Configuration file ---

test('nuncius creates an empty config.json, and nuncius config prints the effective settings', () => {
  fs.rmSync(path.join(env.NUNCIUS_HOME, 'config.json'));
  const before = nuncius(['config', '--json']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), 'utf8'), '{}\n', 'only what the user changes is stored');
  const defaults = JSON.parse(before.stdout);
  assert.equal(defaults.budgets.cursor.maxRunsPerDay, 100);
  assert.deepEqual(defaults.aliases, {});
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), JSON.stringify({ budgets: { cursor: { maxRunsPerDay: 7 } } }));
  const after = JSON.parse(nuncius(['config', '--json']).stdout);
  assert.equal(after.budgets.cursor.maxRunsPerDay, 7);
  assert.equal(after.budgets.cursor.maxAgentMinutesPerDay, 180, 'defaults fill in what the file leaves out');
});

test('settings files with the old names keep working', async () => {
  const { upgradeLegacy } = await import('../src/config.js');
  const old = {
    codexBin: '/x/codex', dashboardPort: 9000,
    budgets: { codex: { maxPrimaryPercent: 70, maxSecondaryPercent: 80 }, projects: { app: { cursorRunsPerDay: 5, claudeTokensPerDay: 1000 } } },
  };
  assert.deepEqual(upgradeLegacy(old), {
    targets: { codex: { bin: '/x/codex' } }, dashboard: { port: 9000 },
    budgets: { codex: { max5HourPercent: 70, maxWeeklyPercent: 80 }, projects: { app: { cursor: { maxRunsPerDay: 5 }, claude: { maxTokensPerDay: 1000 } } } },
  });
  // A new name in the same file wins over its old one.
  assert.equal(upgradeLegacy({ dashboardPort: 1, dashboard: { port: 2 } }).dashboard.port, 2);
  // End to end: an old-style per-project cap still refuses.
  writeConfig({ budgets: { projects: { repo: { codexRunsPerDay: 1 } } } });
  assert.equal(nuncius(['codex', 'one']).status, 0);
  const second = nuncius(['codex', 'two']);
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /Project repo: Codex runs today 1 >= cap 1/);
});

// --- nuncius config / nuncius setup ---

test('settings: set, get, add, remove, unset; only changes are stored; bad values and unknown keys are refused', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), '{}\n');
  const S = await import('../src/settings.js');
  const file = () => JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), 'utf8'));

  assert.equal(S.setSetting('budgets.cursor.maxRunsPerDay', '50'), 50);
  assert.equal(S.setSetting('budgets.codex.max5HourPercent', 'none'), null);
  assert.equal(S.setSetting('targets.claude.enabled', 'no'), false);
  S.setSetting('budgets.projects.my.app.claude.maxTokensPerDay', '2000000'); // a project name with a dot
  S.setSetting('aliases.second.target', 'other');
  assert.deepEqual(S.changeList('sandbox.passEnv', ['NPM_TOKEN', 'CI_*']), ['NPM_TOKEN', 'CI_*']);
  assert.deepEqual(S.changeList('sandbox.passEnv', ['CI_*'], { remove: true }), ['NPM_TOKEN']);
  assert.deepEqual(file(), {
    budgets: { cursor: { maxRunsPerDay: 50 }, codex: { max5HourPercent: null }, projects: { 'my.app': { claude: { maxTokensPerDay: 2000000 } } } },
    targets: { claude: { enabled: false } },
    aliases: { second: { target: 'other' } },
    sandbox: { passEnv: ['NPM_TOKEN'] },
  });
  const got = S.getSetting('budgets.cursor.maxRunsPerDay');
  assert.deepEqual([got.value, got.default, got.changed], [50, 100, true]);
  assert.ok(S.listSettings().some((r) => r.key === 'budgets.projects.my.app.claude.maxTokensPerDay' && r.value === 2000000));

  assert.equal(S.unsetSetting('budgets.cursor.maxRunsPerDay'), true);
  assert.equal(S.getSetting('budgets.cursor.maxRunsPerDay').value, 100);
  assert.equal(file().budgets.cursor, undefined, 'empty objects leave the file too');
  assert.equal(S.unsetSetting('aliases.second'), true);

  assert.throws(() => S.setSetting('budgets.cursor.maxRunsPerDay', '"100"'), /expected a whole number/);
  assert.throws(() => S.setSetting('budgets.claude.max5HourPercent', '150'), /from 0 to 100/);
  assert.throws(() => S.setSetting('budgets.cursor.max5HourPercent', '90'), /unknown setting/, 'Cursor has no subscription window');
  assert.throws(() => S.setSetting('budgets.cursor.maxRunsPrDay', '1'), /Did you mean: budgets\.cursor\.maxRunsPerDay/);
  assert.throws(() => S.setSetting('sandbox.extraWritable', 'relative/path'), /not an absolute path/);
  assert.throws(() => S.setSetting('aliases.x.model', 'gpt'), /set the alias's tool first/);
});

test('statusline install and removal are refused from an agent, and the hook blocks them', async () => {
  for (const cmd of ['install-statusline', 'uninstall-statusline']) {
    const r = nuncius([cmd], { extraEnv: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: path.join(home, 'cc') } });
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /only works when you run it yourself/);
  }
  assert.equal(fs.existsSync(path.join(home, 'cc', 'settings.json')), false, 'nothing was written');
  const { findDirectCall } = await import('../hooks/require-nuncius.js');
  for (const c of ['nuncius uninstall-statusline', 'nuncius install-statusline', 'node bin/nuncius.js uninstall-statusline']) assert.equal(findDirectCall(c)?.tool, 'nuncius settings', c);
});

test('nuncius config refuses changes from an agent but lets it read', () => {
  const r = nuncius(['config', 'set', 'budgets.cursor.maxRunsPerDay', '1'], { extraEnv: { CLAUDECODE: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only works when you run it yourself/);
  const read = nuncius(['config', 'get', 'budgets.cursor.maxRunsPerDay'], { extraEnv: { CLAUDECODE: '1' } });
  assert.equal(read.status, 0);
  assert.match(read.stdout, /budgets\.cursor\.maxRunsPerDay = 100 {2}\(default\)/);
  assert.match(nuncius(['config', 'list', 'cursor']).stdout, /minutes of task run time per day/);
});

test('nuncius setup walks through tools, budgets and connections, and prints each command', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const fakeHome = path.join(home, 'user-home');
  fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude');
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), JSON.stringify({ targets: Object.fromEntries(['codex', 'cursor', 'claude'].map((t) => [t, { bin: path.join(fixtures, `fake-${t}.js`) }])) }));
  const { runSetup } = await import('../src/setup.js');
  const answers = [
    '', 'n', '', // use Codex, not Cursor, use Claude
    '70', '', '', // Codex: 5-hour window 70%, keep weekly (80) and the run cap
    '', '', '0', '20', // Claude: keep both windows; 0 tasks a day gets the hint, then 20
    'y', 'y', 'n', // connect Claude Code and Codex; Cursor can call nuncius too, but not now
    'y', 'y', 'n', // statusline, skill, no hook
  ];
  const asked = [];
  const out = [];
  const calls = [];
  const done = await runSetup({
    ask: async (q) => (asked.push(q), answers.shift() ?? ''),
    say: (s) => out.push(s),
    sh: (cmd, args) => (calls.push([cmd, ...args]), { status: args[1] === 'get' ? 1 : 0, stdout: '', stderr: '' }),
    home: fakeHome,
  });
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(answers.length, 0, `unanswered: ${asked.slice(-3).join(' | ')}`);
  const own = JSON.parse(fs.readFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), 'utf8'));
  assert.equal(own.targets.cursor.enabled, false);
  assert.deepEqual(own.budgets.codex, { max5HourPercent: 70 }, 'the weekly window kept its default, so it is not stored');
  assert.deepEqual(own.budgets.claude, { maxRunsPerDay: 20 });
  // Every budget question says what can be entered; a 0 gets the explanation instead of being stored.
  assert.ok(asked.filter((q) => /budgets?|window|tasks per day|run time/.test(q)).every((q) => /Enter = .* · /.test(q)));
  assert.ok(asked.some((q) => /weekly window \(resets after days/.test(q)));
  assert.ok(out.some((l) => /0 would refuse every Claude task\./.test(l)));
  assert.ok(out.some((l) => /No limit\?  nuncius config set budgets\.claude\.maxRunsPerDay none/.test(l)));
  assert.ok(done.includes('nuncius config set targets.cursor.enabled false'));
  assert.ok(done.includes('nuncius config set budgets.codex.max5HourPercent 70'));
  assert.ok(calls.some((c) => c.join(' ').startsWith('claude mcp add --scope user nuncius --')));
  assert.ok(calls.some((c) => c.join(' ').startsWith('codex mcp add nuncius --')));
  assert.ok(fs.lstatSync(path.join(fakeHome, '.claude', 'skills', 'nuncius')).isSymbolicLink());
  assert.match(JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', 'settings.json'), 'utf8')).statusLine.command, /statusline$/);
  // Cursor is not a target here, but it can still call nuncius, so connecting it is offered (declined).
  assert.ok(asked.some((q) => /Connect Cursor/.test(q)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers['nuncius'], undefined);
  assert.ok(out.some((l) => /Later: nuncius status/.test(l)));
});

test('nuncius setup needs a person at a terminal', () => {
  const r = nuncius(['setup']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs a terminal/);
});

test('a 0 that would block everything is refused with what was probably meant; meaningful 0s are allowed', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'config.json'), '{}\n');
  const S = await import('../src/settings.js');
  assert.throws(() => S.setSetting('budgets.cursor.maxRunsPerDay', '0'), (err) =>
    /^0 would refuse every Cursor task\.\n {2}No limit\? {2}nuncius config set budgets\.cursor\.maxRunsPerDay none\n {2}Not use Cursor at all\? {2}nuncius config set targets\.cursor\.enabled false$/.test(err.message));
  assert.throws(() => S.setSetting('budgets.codex.max5HourPercent', '0'), /0% would let no Codex task start/);
  assert.throws(() => S.setSetting('budgets.projects.app.claude.maxTokensPerDay', '0'), (err) => /in project app/.test(err.message) && !/enabled false/.test(err.message));
  assert.throws(() => S.setSetting('tasks.timeoutSeconds', '0'), /expected seconds, 1 or more/);
  assert.equal(S.setSetting('tasks.syncWaitSeconds', '0'), 0, '0 = return the task id at once');
  assert.equal(S.setSetting('worktrees.keepDays', '0'), 0);
  assert.equal(S.setSetting('tasks.modelCacheSeconds', '0'), 0);
  assert.equal(S.valuesOf(S.spec('budgets.cursor.maxRunsPerDay')), 'a whole number of 1 or more · none = no limit');
  assert.match(S.valuesOf(S.spec('tasks.syncWaitSeconds')), /0 = return the task id at once/);
  const get = nuncius(['config', 'get', 'worktrees.keepDays']);
  assert.match(get.stdout, /values: days · 0 = nuncius cleanup removes every unapplied worktree/);
  assert.match(nuncius(['config', 'list', 'budgets.claude']).stdout, /values: 1 to 100 · none = no limit/);
});

test('a task timeout of 0 in an existing config never means "no timeout"', async () => {
  const { taskTimeoutSeconds, DEFAULT_CONFIG } = await import('../src/config.js');
  assert.equal(taskTimeoutSeconds({ tasks: { timeoutSeconds: 0 } }), DEFAULT_CONFIG.tasks.timeoutSeconds);
  assert.equal(taskTimeoutSeconds({ tasks: { timeoutSeconds: -5 } }), DEFAULT_CONFIG.tasks.timeoutSeconds);
  assert.equal(taskTimeoutSeconds({ tasks: { timeoutSeconds: 60 } }), 60);
  assert.equal(DEFAULT_CONFIG.budgets.codex.maxWeeklyPercent, 80);
  assert.equal(DEFAULT_CONFIG.budgets.claude.maxWeeklyPercent, 80);
});

test('the hook blocks nuncius calls that run, not text that mentions them', async () => {
  const { findDirectCall } = await import('../hooks/require-nuncius.js');
  // Text: searched, printed, committed, or written to a file. Never run, so never blocked.
  for (const c of [
    'grep -n "nuncius setup" README.md',
    'git commit -m "Explain nuncius config set in the README"',
    'git commit -m "fix; nuncius setup"',
    "echo 'nuncius setup'",
    "cat > notes.md <<'EOF'\nnuncius setup\nnuncius config set budgets.cursor.maxRunsPerDay 1\nEOF\nls",
    "tee docs/x.md <<EOF\nnuncius setup\nEOF",
    'echo $(( 1 << 2 )); (( x <<= 1 )); ls',
    'echo "a; codex exec x"',
    'git commit -m "let codex exec run the tests"',
    'nuncius config list',
    'nuncius config get budgets.cursor.maxRunsPerDay',
    'nuncius codex "run nuncius setup for me"',
  ]) assert.equal(findDirectCall(c), null, c);

  // Real calls: plain, chained, wrapped, substituted, through a runtime or fed to a shell.
  for (const [c, tool] of [
    ['nuncius config set budgets.cursor.maxRunsPerDay 1', 'nuncius settings'],
    ['cd repo && nuncius setup', 'nuncius settings'],
    ['echo "$(nuncius setup)"', 'nuncius settings'],
    ['x=`nuncius config unset budgets.cursor.maxRunsPerDay`', 'nuncius settings'],
    ['bash -c "nuncius config set x 1"', 'nuncius settings'],
    ['sudo nuncius uninstall-hook', 'nuncius settings'],
    ['env -u CLAUDECODE nuncius config set x 1', 'nuncius settings'],
    ['xargs nuncius config add sandbox.passEnv', 'nuncius settings'],
    ['node bin/nuncius.js setup', 'nuncius settings'],
    ['node --no-warnings /opt/nuncius/bin/nuncius.js config set x 1', 'nuncius settings'],
    ['bash <<EOF\nnuncius config set x 1\nEOF', 'nuncius settings'],
    ['sh <<-EOF\n\tnuncius setup\n\tEOF', 'nuncius settings'],
    ['nuncius codex --force x', 'nuncius --force'],
    ['bash -c "codex exec x"', 'codex'],
    ['ls; codex exec x', 'codex'],
    // Found by the security review: a heredoc piped into a shell, `<<` in arithmetic hiding the next
    // lines, a nuncius script after runtime flags, code run by an interpreter, and ksh as a wrapper.
    ['cat <<EOF | bash\nnuncius setup\nEOF', 'nuncius settings'],
    ['echo $((x << y))\nnuncius setup\ny', 'nuncius settings'],
    ['node --require ./x bin/nuncius.js setup', 'nuncius settings'],
    ['node -e "require(\'child_process\').execSync(\'nuncius setup\')"', 'nuncius settings'],
    ['python3 -c "import os; os.system(\'nuncius config set x 1\')"', 'nuncius settings'],
    ['ksh -c "nuncius setup"', 'nuncius settings'],
    // Code fed to an interpreter can run anything, so its text is checked: writing code that contains
    // these commands through `python3 - <<EOF` is blocked too (the Write/Edit tools are the way).
    ['python3 - <<EOF\nprint("No limit?  nuncius config set x none")\nEOF', 'nuncius settings'],
    // Second review: a cat heredoc whose output still reaches a shell, and comments that used to
    // throw off the arithmetic tracking.
    ['{ cat <<EOF\nnuncius setup\nEOF\n} | bash', 'nuncius settings'],
    ['(cat <<EOF\nnuncius setup\nEOF\n) | sh', 'nuncius settings'],
    ['cat <<EOF \\\n| bash\nnuncius setup\nEOF', 'nuncius settings'],
    ['cat <<EOF && bash /tmp/x\nnuncius setup\nEOF', 'nuncius settings'],
    ['# ((\nbash <<EOF\nnuncius setup\nEOF', 'nuncius settings'],
    ['echo ((\ncat <<EOF | sh\nnuncius setup\nEOF', 'nuncius settings'],
    // Third review: `#` inside ${#x} is no comment; a case pattern's ) closes no group; a line
    // continued from before; and an apostrophe in a real comment opens no quote.
    ['echo ${#x}; nuncius setup', 'nuncius settings'],
    ['( case x in a) cat <<EOF\nnuncius setup\nEOF\n;; esac ) | bash', 'nuncius settings'],
    ['echo x \\\ncat <<EOF\nnuncius setup\nEOF', 'nuncius settings'],
    ["# don't\nnuncius setup\n# it's", 'nuncius settings'],
    // Fail-closed by design: a cat heredoc after another command is checked like code.
    ['mkdir -p docs && cat > docs/a.md <<EOF\nnuncius setup\nEOF', 'nuncius settings'],
    // Fourth review: an escaped space or a closing substitution before # makes it no comment for the
    // shell. Comment text is checked anyway, so a wrong guess hides nothing.
    ['echo \\ #; nuncius setup', 'nuncius settings'],
    ['echo $(date)#; nuncius config set x 1', 'nuncius settings'],
    ['echo \\ #; codex exec x', 'codex'],
    // Fifth review: a quote in a misread comment that the shell closes on a later line, after which
    // a command runs that the hook would otherwise read as quoted text.
    ["echo \\ #'\nx'; nuncius setup", 'nuncius settings'],
    ['echo \\ #"\nx"; nuncius config set x 1', 'nuncius settings'],
    ["echo $(date)#'\nx'; codex exec y", 'codex'],
    // Sixth review: a misread comment can also hide a heredoc, a substitution or a pipe.
    ["python3 \\ #<<EOF\nimport os; os.system('nuncius setup')\nEOF", 'nuncius settings'],
    ['echo \\ #$(\nnuncius config set x 1\n)', 'nuncius settings'],
    ['echo \\ #`\nnuncius setup\n`', 'nuncius settings'],
    ['echo \\ #| bash\nnuncius setup', 'nuncius settings'],
  ]) assert.equal(findDirectCall(c)?.tool, tool, c);
  // The exact forms that only write text stay allowed, as do comments.
  for (const c of [
    'cat > docs/a.md <<EOF\nnuncius setup\nEOF',
    "cat <<'EOF' >> notes.md\nnuncius config set x 1\nEOF",
    'tee -a log.md <<EOF\nnuncius setup\nEOF',
    "ls # don't worry\nls",
  ]) assert.equal(findDirectCall(c), null, c);
  // Comments are checked too, so one that mentions a settings command is blocked (the price of not
  // having to know exactly where the shell sees a comment); an apostrophe in one still opens no quote.
  assert.equal(findDirectCall('ls # nuncius setup')?.tool, 'nuncius settings');
  assert.equal(findDirectCall("# don't\nnuncius config set x 1")?.tool, 'nuncius settings');
});
