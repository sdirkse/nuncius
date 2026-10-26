import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, dataDir } from './config.js';
import { buildProfile, sandboxAvailable } from './sandbox.js';
import { gitVersionProblem, parseGitVersion } from './worktree.js';
import { ensureCanary, canaryPath } from './tasks.js';
import { targetStatus } from './targets.js';
import { cliVersionSync, versionCheck } from './versions.js';
import { ACCOUNTS, accountsEnabled, accountsProblem, accountLogin } from './accounts.js';

// `nuncius doctor`: prove on this machine that the sandbox does what the docs say, before a task runs
// here. Every check runs a real probe under the real profile of each target. A denial only counts
// when its control passes: the same probe can write inside the worktree, and a network probe that is
// blocked inside the sandbox works outside it. Nothing here starts a target CLI or uses the network
// beyond one plain TCP connect.

const SECRET_PROBES = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.zsh_history', '.bash_history', '.gitconfig', 'Library/Cookies'];
const PROBE_HOST = '1.1.1.1';
const PROBE_PORT = 443;

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function underProfile(profileFile, cmd, timeoutMs = 15000) {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-f', profileFile, '/bin/sh', '-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

function tcpReachable() {
  const r = spawnSync('/usr/bin/nc', ['-z', '-G', '3', PROBE_HOST, String(PROBE_PORT)], { timeout: 10000 });
  return r.status === 0;
}

// The checks for one target's profile. `outside` is a process outside the sandbox (for the signal probe).
function profileChecks(target, { home, outsidePid, netControl, config }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ group: `${target} sandbox`, name, status: ok === null ? 'skip' : ok ? 'ok' : 'fail', ...(detail ? { detail } : {}) });
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `nuncius-doctor-${target}-`)));
  fs.mkdirSync(path.join(wt, '.git'));
  const profileFile = path.join(os.tmpdir(), `nuncius-doctor-${process.pid}-${target}.sb`);
  const outsideFile = path.join(home, `.nuncius-doctor-${process.pid}-${target}`);
  const homeProbe = path.join(home, `.nuncius-doctor-read-${process.pid}-${target}`);
  const tmpFile = `/private/tmp/nuncius-doctor-${process.pid}-${target}`;
  try {
    fs.writeFileSync(profileFile, buildProfile({ worktree: wt, callerRepo: null, target, proxyPort: 1, runtimeDirs: [], config: config.sandbox ?? {}, runCwd: wt }));

    // Control: without this, every "denied" below could just mean the probe itself is broken.
    const inside = underProfile(profileFile, `echo x > ${sh(path.join(wt, 'probe'))} && echo WROTE`);
    const control = inside.includes('WROTE');
    add('can write inside its worktree (control)', control, control ? null : inside.slice(0, 200));
    if (!control) return checks;

    const w1 = underProfile(profileFile, `echo x > ${sh(outsideFile)} 2>/dev/null && echo WROTE || echo denied`);
    add('cannot write to your home folder', !w1.includes('WROTE') && !fs.existsSync(outsideFile));
    // A file nuncius itself just put in the home folder: only the task's own files and toolchains are readable there.
    fs.writeFileSync(homeProbe, 'nuncius doctor probe\n');
    const rh = underProfile(profileFile, `cat ${sh(homeProbe)} >/dev/null 2>&1 && echo READ || echo denied`);
    add('cannot read files in your home folder', !rh.includes('READ'));
    const w2 = underProfile(profileFile, `echo x > ${sh(tmpFile)} 2>/dev/null && echo WROTE || echo denied`);
    add('cannot write to the shared /tmp', !w2.includes('WROTE') && !fs.existsSync(tmpFile));

    const rd = underProfile(profileFile, `ls ${sh(dataDir())} >/dev/null 2>&1 && echo READ || echo denied`);
    add("cannot read nuncius's own data (usage log, tasks, config)", !rd.includes('READ'));
    const rc = underProfile(profileFile, `cat ${sh(canaryPath())} >/dev/null 2>&1 && echo READ || echo denied`);
    add('cannot read the recursion-guard canary', !rc.includes('READ'));

    const present = SECRET_PROBES.map((p) => path.join(home, p)).concat(config.sandbox?.extraDenyRead ?? []).filter((p) => fs.existsSync(p));
    const readable = present.filter((p) => {
      const cmd = fs.statSync(p).isDirectory() ? `ls ${sh(p)} >/dev/null 2>&1` : `head -c0 ${sh(p)} 2>/dev/null`;
      return underProfile(profileFile, `${cmd} && echo READ || echo denied`).includes('READ');
    });
    if (!present.length) add('cannot read secret stores', null, 'none of the probed locations exist here');
    else add(`cannot read secret stores (${present.length} present here)`, readable.length === 0, readable.length ? `readable: ${readable.join(', ')}` : null);

    if (netControl) {
      const net = underProfile(profileFile, `/usr/bin/nc -z -G 3 ${PROBE_HOST} ${PROBE_PORT} 2>/dev/null && echo CONNECTED || echo blocked`);
      add('no direct network connection (only through the proxy)', !net.includes('CONNECTED'));
    } else {
      add('no direct network connection (only through the proxy)', null, `${PROBE_HOST}:${PROBE_PORT} is not reachable outside the sandbox either, so there is nothing to compare`);
    }

    const errFile = path.join(wt, 'nc.err');
    const port = 40000 + Math.floor(Math.random() * 20000);
    const lis = underProfile(profileFile, `/usr/bin/nc -l 0.0.0.0 ${port} 2>${sh(errFile)} & p=$!; sleep 1; if kill -0 $p 2>/dev/null; then kill $p; echo LISTENING; else cat ${sh(errFile)}; fi`);
    const denied = /not permitted/i.test(lis);
    add('cannot accept inbound connections', !lis.includes('LISTENING') && denied, lis.includes('LISTENING') || denied ? null : `inconclusive: ${lis.slice(0, 120)}`);

    const sig = underProfile(profileFile, `kill -0 ${outsidePid} 2>/dev/null && echo SIGNALED || echo denied`);
    add('cannot signal processes outside its sandbox', !sig.includes('SIGNALED'));
    return checks;
  } finally {
    for (const f of [profileFile, outsideFile, homeProbe, tmpFile]) fs.rmSync(f, { force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

export function doctor() {
  const checks = [];
  const config = loadConfig();
  const sandbox = sandboxAvailable();
  checks.push({ group: 'requirements', name: 'macOS sandbox-exec is available', status: sandbox ? 'ok' : 'fail', ...(sandbox ? {} : { detail: 'nuncius runs no task without it' }) });
  const gitProblem = gitVersionProblem();
  const gv = parseGitVersion(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout ?? '');
  checks.push({ group: 'requirements', name: `git ${gv ? gv.join('.') : '?'} (needs 2.41 or newer)`, status: gitProblem ? 'fail' : 'ok', ...(gitProblem ? { detail: gitProblem } : {}) });
  for (const t of targetStatus(config)) {
    if (!t.available) {
      checks.push({ group: 'targets', name: t.name, status: 'info', detail: t.reason });
      continue;
    }
    const v = versionCheck(t.name, cliVersionSync(t.bin));
    checks.push({ group: 'targets', name: `${t.name} ${v.version ?? '?'}`, status: v.note ? 'warn' : 'ok', detail: v.note ?? `verified version · ${t.bin}` });
  }
  if (!sandbox) return checks;

  const home = os.userInfo().homedir;
  checks.push(...accountChecks(config, home));
  fs.mkdirSync(dataDir(), { recursive: true });
  ensureCanary();
  const netControl = tcpReachable();
  const outside = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  try {
    for (const target of ['codex', 'cursor', 'claude']) checks.push(...profileChecks(target, { home, outsidePid: outside.pid, netControl, config }));
  } finally {
    outside.kill();
  }
  return checks;
}

// ADR 12: with sandbox.taskAccounts on, prove the account wall on its own (without the sandbox).
function accountChecks(config, home) {
  const group = 'task accounts (Codex, Claude)';
  if (!accountsEnabled(config)) return [{ group, name: 'off (sandbox.taskAccounts); tasks run as you, inside the sandbox', status: 'info' }];
  const checks = [];
  const add = (name, ok, detail) => checks.push({ group, name, status: ok === null ? 'skip' : ok ? 'ok' : 'fail', ...(detail ? { detail } : {}) });
  const problem = accountsProblem(home);
  add('the accounts, the sudo rule and the home pass-through are in place', !problem, problem);
  if (problem) return checks;
  const a = ACCOUNTS[0];
  const as = (cmd) => spawnSync('/usr/bin/sudo', ['-n', '-u', a, '--', '/bin/sh', '-c', cmd], { encoding: 'utf8', cwd: '/', timeout: 15000 }).status === 0;
  add('an account cannot list your home folder', !as(`ls ${sh(home)} >/dev/null 2>&1`));
  add("an account cannot read nuncius's data", !as(`ls ${sh(path.join(home, '.nuncius'))} >/dev/null 2>&1`));
  const codexAuth = path.join(home, '.codex', 'auth.json');
  if (fs.existsSync(codexAuth)) add("an account cannot read Codex's login file", !as(`cat ${sh(codexAuth)} >/dev/null 2>&1`));
  const tty = (() => {
    try {
      const me = os.userInfo().uid;
      return fs.readdirSync('/dev').filter((n) => /^ttys\d+$/.test(n)).map((n) => `/dev/${n}`).find((p) => fs.statSync(p).uid === me) ?? null;
    } catch {
      return null;
    }
  })();
  if (tty) add('an account cannot write to your terminals', !as(`exec 3>>${sh(tty)}`));
  else add('an account cannot write to your terminals', null, 'no terminal of yours is open');
  // The firewall: a direct connection that works for you must fail for the account.
  if (tcpReachable()) add('the firewall blocks an account from connecting out directly', !as(`/usr/bin/nc -z -G 3 ${PROBE_HOST} ${PROBE_PORT}`));
  else add('the firewall blocks an account from connecting out directly', null, `${PROBE_HOST}:${PROBE_PORT} is not reachable for you either`);
  const login = accountLogin('claude');
  add('Claude has a long-lived token for task accounts', !login.error, login.error);
  return checks;
}

export function printDoctor(checks) {
  const mark = { ok: 'ok  ', fail: 'FAIL', skip: 'skip', warn: 'warn', info: '    ' };
  let group = null;
  for (const c of checks) {
    if (c.group !== group) console.log(`${(group = c.group)}:`);
    console.log(`  ${mark[c.status]}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const passed = checks.filter((c) => c.status === 'ok').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log(failed ? `\n${failed} check(s) FAILED: do not run tasks on this machine until they pass.` : `\nAll ${passed} checks passed${warned ? `, ${warned} warning(s)` : ''}.`);
  return failed ? 1 : 0;
}
