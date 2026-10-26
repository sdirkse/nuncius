import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountCommand, usesAccount, accountsProblem, ACCOUNTS } from '../src/accounts.js';
import { initRepo } from './helpers.js';

// ADR 12: task accounts. The end-to-end tests need the accounts from scripts/task-accounts/setup.sh
// and skip without them.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ready = process.platform === 'darwin' && accountsProblem(os.homedir()) === null;
const skip = !ready && 'needs the task accounts (scripts/task-accounts/setup.sh)';

test('account mode covers Codex and Claude, never Cursor, and only when switched on', () => {
  const on = { sandbox: { taskAccounts: true } };
  assert.equal(usesAccount(on, 'codex'), true);
  assert.equal(usesAccount(on, 'claude'), true);
  assert.equal(usesAccount(on, 'cursor'), false);
  assert.equal(usesAccount({ sandbox: {} }, 'codex'), false);
  assert.equal(usesAccount({ sandbox: { taskAccounts: 'yes' } }, 'codex'), false);
});

test('the command line carries no environment values and no secrets', () => {
  const c = accountCommand({ account: '_nuncius1', env: { PATH: '/p', OPENAI_API_KEY: 'sk-env-secret', HOME: '/h' }, secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' }, sandboxExec: '/usr/bin/sandbox-exec', profile: '(version 1)', bin: '/bin/echo', args: ['x'] });
  const argv = c.args.join(' ');
  for (const v of ['sk-env-secret', 'tok-secret', '/h']) assert.ok(!argv.includes(v), v);
  assert.deepEqual(c.args.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)), ['PATH=/usr/bin:/bin']);
  assert.match(c.input, /^OPENAI_API_KEY=/m);
});

test('values reach the task account exactly, through stdin', { skip }, () => {
  const c = accountCommand({ account: ACCOUNTS[0], env: { PATH: '/usr/bin:/bin', ODD: 'a=b\nc $HOME "q" \'s\'' }, secrets: { TOK: 'secret' }, sandboxExec: '/usr/bin/env', profile: 'ignored', bin: '/bin/sh', args: ['-c', 'printf "%s|%s|%s" "$(id -un)" "$ODD" "$TOK"'] });
  // Without the sandbox here: replace sandbox-exec -p <profile> with env.
  const args = c.args.slice();
  const i = args.indexOf('/usr/bin/env', 5);
  args.splice(i, 3, '/usr/bin/env');
  const r = spawnSync(c.bin, args, { input: c.input, encoding: 'utf8', cwd: '/' });
  assert.equal(r.stdout, `${ACCOUNTS[0]}|a=b\nc $HOME "q" 's'|secret`, r.stderr);
});

// A test home inside the user's home folder: task accounts can pass through it, not through the
// per-user temp folder.
let base;
after(() => {
  if (!base) return;
  for (const a of ACCOUNTS) {
    spawnSync('/usr/bin/sudo', ['-n', '-u', a, '/usr/bin/pkill', '-KILL', '-u', a]);
    spawnSync('/usr/bin/sudo', ['-n', '-u', a, '/usr/bin/find', base, '-user', a, '-exec', '/bin/chmod', 'g+rwX', '{}', '+']);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('a Codex task runs as a task account; nuncius commits its work and leaves nothing running', { skip }, () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.nuncius-accounts-test-')));
  fs.chmodSync(base, 0o755);
  const repo = initRepo(path.join(base, 'repo'));
  execFileSync('/bin/chmod', ['-R', 'go+rX', repo]);
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { recursive: true });
  // A Codex-shaped target that records who it runs as, and tries to read the user's Codex login.
  const bin = path.join(base, 'whoami-codex.sh');
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = app-server ] && exit 0\n{ id -un; git log --oneline -1 >/dev/null 2>&1 && echo git-ok; cat "' + path.join(os.homedir(), '.codex', 'auth.json') + '" >/dev/null 2>&1 && echo LOGIN-READ || echo login-denied; } > who.txt\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ codexBin: bin, sandbox: { taskAccounts: true } }));
  const env = { ...process.env, NUNCIUS_HOME: data, NUNCIUS_WORKTREES: path.join(base, 'wt'), NUNCIUS_RUNTIME: path.join(base, 'rt'), CODEX_HOME: path.join(base, 'codex') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'nuncius.js'), 'codex', 'x'], { env, cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const branch = /changes on (nuncius\/codex\/\S+)/.exec(r.stderr)?.[1];
  assert.ok(branch, r.stderr);
  const who = execFileSync('git', ['-C', repo, 'show', `${branch}:who.txt`], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(ACCOUNTS.includes(who[0]), `ran as ${who[0]}`);
  assert.equal(who[1], 'git-ok');
  assert.equal(who[2], 'login-denied');
  const task = JSON.parse(fs.readdirSync(path.join(data, 'tasks')).map((f) => fs.readFileSync(path.join(data, 'tasks', f), 'utf8'))[0]);
  assert.equal(task.account, who[0]);
  // Nothing of that account still runs (a launchd-managed distnoted may appear; it is not the task's).
  const left = spawnSync('/bin/ps', ['-o', 'command=', '-U', who[0]], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.trim() && !l.includes('distnoted'));
  assert.deepEqual(left, []);
});
