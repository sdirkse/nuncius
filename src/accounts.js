import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// ADR 12: opt-in task accounts. With sandbox.taskAccounts on, nuncius starts each target as one of a
// small pool of hidden macOS accounts (made once by scripts/task-accounts/setup.sh), inside the
// usual Seatbelt profile. Everything here runs as the user; it only ever switches *down* to an
// account, through the sudo rule setup installs.

export const GROUP = '_nuncius';
export const ACCOUNTS = ['_nuncius1', '_nuncius2', '_nuncius3', '_nuncius4'];
const SUDO = '/usr/bin/sudo';

// Which targets run as a task account. Cursor does not yet: its tool helper (exec-daemon with its own
// sandbox binary) fails to start in another account, and it expects a keychain of its own. It keeps
// running as the user inside the sandbox (ADR 12).
export const ACCOUNT_TARGETS = new Set(['codex', 'claude']);
export const accountsEnabled = (config) => config?.sandbox?.taskAccounts === true;
export const usesAccount = (config, target) => accountsEnabled(config) && ACCOUNT_TARGETS.has(target);

const asAccount = (account, cmd, args, opts = {}) =>
  spawnSync(SUDO, ['-n', '-u', account, '--', cmd, ...args], { encoding: 'utf8', timeout: 30000, ...opts });

export function accountUid(account) {
  try {
    return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

export function accountHome(account) {
  try {
    return execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${account}`, 'NFSHomeDirectory'], { encoding: 'utf8' }).split(/\s+/)[1] || null;
  } catch {
    return null;
  }
}

// null when the accounts are ready, else why not. Checked before each task: no account, no task.
export function accountsProblem(home) {
  for (const a of ACCOUNTS) {
    if (accountUid(a) === null) return `task account ${a} does not exist: run scripts/task-accounts/setup.sh (with sudo)`;
    const r = asAccount(a, '/usr/bin/true', []);
    if (r.status !== 0) return `cannot switch to task account ${a} without a password: the sudo rule from scripts/task-accounts/setup.sh is missing`;
  }
  try {
    const groups = execFileSync('/usr/bin/id', ['-Gn'], { encoding: 'utf8' }).split(/\s+/);
    if (!groups.includes(GROUP)) return `you are not in group ${GROUP}: run scripts/task-accounts/setup.sh (with sudo)`;
    if (!/group:_nuncius allow search/.test(execFileSync('/bin/ls', ['-led', home], { encoding: 'utf8' }))) return 'the task accounts cannot pass through your home folder: run scripts/task-accounts/setup.sh (with sudo)';
  } catch (err) {
    return `could not check the task accounts: ${err.message}`;
  }
  return null;
}

// Group _nuncius on a tree nuncius made, group-writable, folders setgid (new files keep the group). The
// task account can then write it, and nuncius can read and remove what the account writes.
export function shareTree(dir) {
  execFileSync('/usr/bin/chgrp', ['-R', '-h', GROUP, dir]);
  execFileSync('/bin/chmod', ['-R', 'g+rwX', dir]);
  execFileSync('/usr/bin/find', [dir, '-type', 'd', '-exec', '/bin/chmod', 'g+s', '{}', '+']);
}

// A root folder of task trees: the group may pass through it (search), not list it.
export function shareRoot(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/chgrp', ['-h', GROUP, dir]);
  fs.chmodSync(dir, 0o2710);
}

// Claude Code keeps its shell snapshots in /tmp/claude-<uid>. For a task account that folder must be
// the account's own; nuncius has it made by the account, then checks it is a real folder it owns.
export function claudeTempBase(account) {
  const uid = accountUid(account);
  const base = `/private/tmp/claude-${uid}`;
  asAccount(account, '/bin/mkdir', ['-p', '-m', '700', base]);
  try {
    const st = fs.lstatSync(base);
    return st.isDirectory() && st.uid === uid ? { uid, base } : null;
  } catch {
    return null;
  }
}

// The command that starts the target as the account. Nothing but a bare PATH is on the command line
// (argv is visible to every process on the Mac): the whole environment, logins included, goes in on
// stdin as KEY=base64(value) lines, so every value arrives exactly as it is. The launcher exports
// them, sets a group-writable umask and runs the sandboxed CLI with stdin closed.
const LAUNCH = [
  'while IFS= read -r line; do k=${line%%=*}; case "$k" in [A-Za-z_]*) export "$k=$(printf %s "${line#*=}" | /usr/bin/base64 -D)" ;; esac; done',
  // Codex's login: written by the account itself, readable by it alone (not by the other task accounts).
  'if [ -n "$NUNCIUS_CODEX_AUTH" ] && [ -n "$CODEX_HOME" ]; then (umask 077; printf %s "$NUNCIUS_CODEX_AUTH" > "$CODEX_HOME/auth.json"); fi',
  'unset NUNCIUS_CODEX_AUTH; umask 002; exec "$@" </dev/null',
].join('; ');
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function accountCommand({ account, env, secrets = {}, sandboxExec, profile, bin, args }) {
  const all = { ...env, ...secrets };
  const input = Object.entries(all)
    .filter(([k, v]) => v !== undefined && v !== null && KEY_RE.test(k))
    .map(([k, v]) => `${k}=${Buffer.from(String(v)).toString('base64')}\n`)
    .join('');
  return {
    bin: SUDO,
    args: ['-n', '-u', account, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/sh', '-c', LAUNCH, 'sh', sandboxExec, '-p', profile, bin, ...args],
    env: { PATH: '/usr/bin:/bin' },
    input,
  };
}

// After the target: stop every process of the account (a setsid escapee too), hand the trees back
// (a target can make its files unreadable to the user; the account itself can undo that), and empty
// the account's home so nothing carries over to the next task.
export function stopAccount(account) {
  asAccount(account, '/usr/bin/pkill', ['-KILL', '-u', account]);
}
export function reclaim(account, dirs) {
  for (const d of dirs) if (d && fs.existsSync(d)) asAccount(account, '/usr/bin/find', [d, '-user', account, '-exec', '/bin/chmod', 'g+rwX', '{}', '+'], { timeout: 120000 });
}
export function emptyHome(account) {
  const home = accountHome(account);
  if (home && home.startsWith('/var/db/nuncius-homes/')) asAccount(account, '/usr/bin/find', [home, '-mindepth', '1', '-delete']);
}

// Logins from the user's keychain, read by nuncius (the user) and handed only to the task process.
const keychainSecret = (service) => {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
// { secrets, error }: what the target needs to log in as a task account.
export function accountLogin(target) {
  if (target === 'claude') {
    // A long-lived token from `claude setup-token` (Claude Code's own login token rotates whenever
    // Claude Code refreshes it, so a copy of it soon stops working).
    const token = keychainSecret('nuncius-claude-token');
    return token
      ? { secrets: { CLAUDE_CODE_OAUTH_TOKEN: token } }
      : { error: 'Claude needs a long-lived token for task accounts: run `claude setup-token`, then store the token with `security add-generic-password -U -a "$USER" -s nuncius-claude-token -w` (in macOS Terminal, pasted as one piece)' };
  }
  return { secrets: {} }; // Codex: a copy of its login file in the task's Codex home (src/tasks.js)
}

