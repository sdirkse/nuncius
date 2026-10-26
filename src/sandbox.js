import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.js';
import { accountCommand } from './accounts.js';
import { codexHome } from './codex-limits.js';
import { worktreesDir } from './worktree.js';

// ADR 5: every target runs inside a macOS Seatbelt profile (sandbox-exec). The target CLI still
// needs the network for its own API, which goes through an allowlisting proxy; the profile covers:
//   - writes only to the task worktree, temp dirs and an allowlist of the target's own runtime dirs;
//   - never to the caller's checkout, nor to the worktree's `.git` pointer (the nuncius runs git there later);
//   - no access at all to nuncius's data dir (other tasks, logs, the queue);
//   - no access to other tasks' worktrees;
//   - no reads of common credential stores;
//   - no LaunchServices, AppleEvents, launchctl, osascript, open, crontab or at (ways to start code outside).
//   - network only through the nuncius's per-task egress proxy, which allowlists hosts (src/proxy.js);
//     no DNS of its own, so hostnames cannot be used as an exfiltration channel.
// The CLIs' own sandboxes are not relied on: inside this profile, Claude Code's Bash sandbox failed to
// start (sandbox_apply: Operation not permitted; with failIfUnavailable it disables Bash), and Codex's
// nested sandbox is unverified. So this layer covers files and network for every target itself.
// In SBPL the last matching rule wins, which the order below relies on.

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function sandboxAvailable() {
  return process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

// Seatbelt matches resolved paths, so every rule uses one. A path that does not exist yet is resolved
// through its longest existing ancestor (e.g. /var/... -> /private/var/...), not left as given, which
// would silently never match.
export const real = (p) => {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
};
const quote = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const subpaths = (list) => list.map((p) => `(subpath ${quote(real(p))})`).join(' ');

// Extra dirs a target must write besides its worktree and per-task runtime dirs. Claude Code keeps
// its shell-snapshot workdir under /tmp/claude-<uid> (hardcoded, not following TMPDIR); its allowance
// is added in buildProfile, scoped to this task's own subdirectory. Codex and Cursor need nothing
// here (they honour the per-task TMPDIR).
export function targetWritable() {
  return [];
}

// Claude Code's shell-snapshot base: /tmp/claude-<uid>, and the per-run subdirectory it derives from
// the working directory (every non-alphanumeric character becomes '-'). Allowing only this run's
// subdirectory (plus creating the base dir itself) keeps a Claude task out of other sessions' and
// other tasks' snapshot workspaces under the same shared, user-private (0700) base.
// claudeTemp: { uid, base } for a task account (made and checked in src/accounts.js), else nuncius's own.
function claudeSnapshotRules(runCwd, claudeTemp) {
  const uid = claudeTemp ? claudeTemp.uid : typeof process.getuid === 'function' ? process.getuid() : '';
  const rules = [];
  // Nuncius creates the base dir itself (0700), so the target never needs write on it (which would let
  // it unlink the dir or plant a symlink there). The target gets write only on its own per-run
  // subdirectory, and only when the base is a real directory we own (not a symlink someone planted).
  const base = real(`/tmp/claude-${uid}`);
  let baseOk = false;
  try {
    if (!claudeTemp) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    baseOk = fs.lstatSync(base).isDirectory();
  } catch {
    // leave baseOk false; Claude's snapshot workspace then has no allowance (its Bash degrades but is safe)
  }
  if (baseOk && runCwd) {
    const key = real(runCwd).replace(/[^A-Za-z0-9]/g, '-');
    rules.push(`(allow file-write* (subpath ${quote(path.join(base, key))}))`);
  }
  // Per-shell cwd-tracking file: /tmp/claude-<hex>-cwd, directly under the temp root (the hex is
  // random per shell, so it cannot be a literal). Scoped to that exact filename shape.
  const esc = (s) => s.replace(/[.[\]{}()*+?^$|\/]/g, '\\$&');
  rules.push(`(allow file-write* (regex #"^${esc(real('/tmp'))}/claude-[0-9A-Za-z]+-cwd$"))`);
  return rules;
}

const ESCAPE_BINARIES = ['/usr/bin/open', '/bin/launchctl', '/usr/bin/osascript', '/usr/bin/crontab', '/usr/bin/at', '/usr/bin/batch', '/usr/bin/automator', '/usr/bin/shortcuts'];
// Resolver entry points besides the /var/run/mDNSResponder socket (already covered by the network deny).
const DNS_SERVICES = ['com.apple.mDNSResponder', 'com.apple.dnssd.service', 'com.apple.mDNSResponderHelper'];
const ESCAPE_SERVICES = ['com.apple.coreservices.launchservicesd', 'com.apple.lsd.mapdb', 'com.apple.lsd.modifydb', 'com.apple.coreservices.quarantine-resolver'];

// Same default as src/tasks.js runtimeRoot (kept here to avoid an import cycle).
const runtimeRootDir = () => process.env.NUNCIUS_RUNTIME || `${dataDir()}-runtime`;

// Toolchain homes and package caches in the home folder that tasks may read (running tests needs
// them). Code and packages, not credentials; the credential files some of them hold are denied
// explicitly (secretPaths). ~/.cache is deliberately absent: it mixes many apps' data (tokens
// included), and a task has its own cache dir.
const TOOLCHAIN_DIRS = [
  '.rustup', '.cargo', '.nvm', '.volta', '.fnm', '.bun', '.deno', '.pyenv', '.rbenv', '.rvm', '.asdf', '.local/share/mise',
  '.local/share/pnpm', 'Library/pnpm', '.sdkman', '.conda', 'miniconda3', 'anaconda3', '.pixi', '.dotnet', '.ghcup', '.opam',
  '.juliaup', 'go/pkg/mod', 'go/bin', '.m2/repository', '.gradle/caches', '.gradle/wrapper', '.npm/_cacache', '.local/bin',
];

export function buildProfile({ worktree, callerRepo, target, proxyPort, runtimeDirs = [], config = {}, runCwd, targetBin, gitDir, claudeTemp, account }) {
  const home = os.homedir();
  // No broad shared-temp write. The task's own temp and cache (TMPDIR, XDG_CACHE_HOME) are per-task
  // dirs under the runtime root, reopened below via runtimeDirs; the user's real per-user temp
  // (/private/var/folders/.../T) and /private/tmp stay read-only, so a target cannot plant files
  // other programs or later tasks pick up. /dev is writable (ptys, /dev/null).
  const writable = [];
  // All CLI state dirs are closed for writing (also when they live under a temp dir), then only
  // the running target's allowlisted runtime dirs are reopened.
  // CLAUDE_CONFIG_DIR moves Claude Code's settings (incl. hooks and statusLine, which run unsandboxed
  // in the user's own sessions), so it is closed as well as the default location.
  const stateDirs = [
    codexHome(), path.join(home, '.cursor'), path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(home, '.config'),
    // Moved config/data locations of the CLIs (as seen by the nuncius, outside the sandbox).
    ...['CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'].map((k) => process.env[k]).filter(Boolean),
    ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, 'cursor')] : []),
    path.join(home, '.local', 'share', 'cursor-agent'), // the CLI's own install and worker data
  ];
  // Credential and secret stores: never readable by a target. A worktree holds only the project, so
  // these are not needed for the work, and a prompt-injected target could otherwise read them and
  // ship them out over its own vendor API. This is a blocklist of the common locations, not a proof
  // that nothing sensitive remains readable (a target runs with the real $HOME for Codex and Claude);
  // keep real secrets out of the repositories you delegate from, and add paths with sandbox.extraDenyRead.
  const secretPaths = [
    // Cloud / infra / VCS credentials.
    '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.azure', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc',
    '.git-credentials', '.config/git/credentials', '.terraform.d', '.config/doctl', '.config/op', '.1password', '.config/rclone',
    '.databricks', '.config/fly', '.config/flyctl', '.chef', '.config/helm', '.kaggle', '.config/containers/auth.json',
    // Shell and tool history (often holds tokens pasted on a command line).
    '.zsh_history', '.zsh_sessions', '.bash_history', '.sh_history', '.local/share/fish', '.node_repl_history',
    '.python_history', '.psql_history', '.mysql_history', '.irb_history', '.rediscli_history', '.lesshst', '.config/gcloud/logs',
    // Git and DB config that can carry credentials (credential.helper store, url.insteadOf, passwords).
    '.gitconfig', '.config/git/config', '.pgpass', '.my.cnf', '.boto', '.s3cfg',
    // Credentials inside otherwise readable toolchain folders.
    '.cargo/credentials', '.cargo/credentials.toml', '.cargo/config', '.cargo/config.toml', '.conda/.condarc', 'miniconda3/.condarc', 'anaconda3/.condarc', '.pixi/config.toml', '.m2/settings.xml', '.m2/settings-security.xml', '.gradle/gradle.properties',
    '.config/pip/pip.conf', '.pip/pip.conf', '.condarc', '.bunfig.toml', '.yarnrc', '.yarnrc.yml',
    // Browser cookies and session storage (no CLI needs them; they hold live session tokens). The
    // macOS keychain is deliberately NOT denied: it is encrypted and gated by securityd, not raw
    // file reads, and the target CLIs read it for their own login (Cursor, Claude).
    'Library/Cookies', 'Library/HTTPStorages',
    'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
    'Library/Application Support/BraveSoftware', 'Library/Application Support/Slack',
  ];
  // What a task may read in the home folder. The repository's shared git dir behind the worktree
  // (worktree git commands need its objects and refs; the caller's working files are not included,
  // so ignored files like .env stay closed), the keychain folder (the CLIs' logins), Codex's login
  // file (linked into its per-task home), toolchains: every PATH folder inside the home folder plus
  // the usual toolchain homes and package caches, and sandbox.extraReadable.
  const inHome = (p) => p === home || p.startsWith(home + path.sep);
  // A folder derived from the environment (a PATH entry, the CLI's install folder) is opened only when
  // it is narrow: at least two levels into the home folder (~/.cargo/bin, ~/.local/share/...), or a
  // top-level ~/bin. A PATH that contains the home folder itself or ~/Documents opens nothing.
  const narrowHomeFolder = (d) => {
    const parts = path.relative(home, d).split(path.sep);
    return d !== home && !parts.includes('..') && (parts.length >= 2 || parts[0] === 'bin');
  };
  // Judged on the real path, which is what the profile opens: a narrow-looking ~/bin that is a link
  // to the home folder opens nothing.
  // A folder that is the home folder or contains it (/, /Users, a link to either) would reopen the
  // whole home folder: never opened, whatever it came from.
  const realHome = real(home);
  const containsHome = (r) => r === realHome || realHome.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  const narrowReal = (d) => {
    const r = real(d);
    return !containsHome(r) && (!inHome(r) || narrowHomeFolder(r));
  };
  const pathDirs = String(process.env.PATH ?? '').split(':').filter((d) => d && path.isAbsolute(d) && inHome(real(d)) && narrowReal(d));
  const homeReadable = [
    ...(gitDir ? [gitDir] : []),
    path.join(home, 'Library', 'Keychains'),
    ...(target === 'codex' ? [path.join(codexHome(), 'auth.json')] : []),
    ...pathDirs,
    // A fixed name is fine as it is; one that is a link must lead somewhere narrow (not the home folder).
    ...TOOLCHAIN_DIRS.map((d) => path.join(home, d)).filter((d) => real(d) === path.join(real(home), path.relative(home, d)) || narrowReal(d)),
    ...(config.extraReadable ?? []),
  ].filter((p) => !containsHome(real(p)));
  // The repository's own config can hold credentials (a token in a remote URL, credential settings):
  // a task's git reads a cleaned copy instead (GIT_COMMON_DIR, see src/tasks.js).
  const secrets = secretPaths.map((p) => path.join(home, p)).concat(['/etc/master.passwd', '/private/etc/master.passwd'], gitDir ? [path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree')] : [], config.extraDenyRead ?? []);

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // Home folder: an allowlist, not a blocklist. Nothing in it is readable (contents or metadata)
    // except what a task needs; the explicit secret denies further down still apply inside those.
    `(deny file-read* ${subpaths([home])})`,
    `(allow file-read* ${subpaths(homeReadable)})`,
    // The link that starts the target and the folder it sits in (macOS realpath(3) reads the folder a
    // link is in; Cursor's start script resolves itself), plus the target's real install folder.
    // The install folder only when it is narrow (see narrowHomeFolder); otherwise just the file itself.
    ...(targetBin ? (() => {
      const installDir = path.dirname(real(targetBin));
      const linkDir = real(path.dirname(targetBin));
      const open = (d) => !containsHome(d) && (!inHome(d) || narrowHomeFolder(d)); // both are real paths already
      return [`(allow file-read* (literal ${quote(targetBin)}) (literal ${quote(real(targetBin))})${open(linkDir) ? ` (literal ${quote(linkDir)})` : ''}${open(installDir) ? ` ${subpaths([installDir])}` : ''})`];
    })() : []),
    // The folders above everything readable: metadata only, so paths resolve (and getcwd works)
    // without the folder being listable. A specific operation outranks the file-read* deny above.
    ...(() => {
      const above = new Set();
      for (const p of [worktree, ...runtimeDirs, ...homeReadable, ...(targetBin ? [targetBin, real(targetBin)] : [])])
        for (let d = real(p); d !== path.dirname(d); d = path.dirname(d)) above.add(path.dirname(d));
      return above.size ? [`(allow file-read-metadata ${[...above].map((d) => `(literal ${quote(d)})`).join(' ')})`] : [];
    })(),
    ...(writable.length ? [`(allow file-write* ${subpaths(writable)})`] : []),
    '(allow file-write* (subpath "/dev"))',
    `(deny file-write* ${subpaths(stateDirs)})`,
    ...(() => {
      const reopen = [...targetWritable(target), ...runtimeDirs, ...(config.extraWritable ?? [])];
      return reopen.length ? [`(allow file-write* ${subpaths(reopen)})`] : [];
    })(),
    // Claude Code's shell-snapshot area, scoped to this run's own subdirectory and its cwd file.
    ...(target === 'claude' ? claudeSnapshotRules(runCwd, claudeTemp) : []),
    // The caller's own checkout is never writable, even if it lives under a temp dir.
    ...(callerRepo ? [`(deny file-write* ${subpaths([callerRepo])})`] : []),
    `(deny file-read* file-write* ${subpaths([dataDir()])})`,
    // Other tasks' worktrees: no access. Only the root itself stays listable, because targets need
    // to read every ancestor of their cwd (Claude Code refuses to write otherwise).
    `(deny file-read* file-write* ${subpaths([worktreesDir()])})`,
    `(allow file-read* (literal ${quote(real(worktreesDir()))}))`,
    `(allow file-read* file-write* ${subpaths([worktree])})`,
    // Other tasks' scratch dirs: no access; the root itself stays readable for path resolution.
    `(deny file-read* file-write* ${subpaths([runtimeRootDir()])})`,
    `(allow file-read* (literal ${quote(real(runtimeRootDir()))}))`,
    ...(runtimeDirs.length ? [`(allow file-read* file-write* ${subpaths(runtimeDirs)})`] : []),
    `(deny file-write* (literal ${quote(path.join(real(worktree), '.git'))}))`,
    `(deny file-read* file-write* ${subpaths(secrets)})`,
    // Per-worktree git config (worktrees/<id>/config.worktree) can hold the same settings as the config.
    ...(gitDir ? [`(deny file-read* (regex #"^${real(gitDir).replace(/[.[\]{}()*+?^$|\\/]/g, '\\$&')}/worktrees/[^/]+/config\\.worktree$"))`] : []),
    // The recursion-guard canary (src/tasks.js): unreadable means "inside a nuncius task".
    `(deny file-read* file-write* (literal ${quote(path.join(os.userInfo().homedir, '.nuncius-canary'))}))`,
    `(deny process-exec ${ESCAPE_BINARIES.map((b) => `(literal ${quote(b)})`).join(' ')})`,
    `(deny mach-lookup ${ESCAPE_SERVICES.map((n) => `(global-name ${quote(n)})`).join(' ')})`,
    '(deny appleevent-send)',
    // Signals only within this sandbox: a target cannot kill nuncius's worker (which enforces its
    // timeout and writes its usage record), the MCP server, or any other process of the user.
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    // launchd jobs run outside this sandbox, whichever binary submits them.
    '(deny job-creation)',
    // Network: only the nuncius's egress proxy on loopback, which allowlists hosts and resolves them
    // itself, outside the sandbox. No local DNS either: the system resolver forwards any name to
    // upstream servers, which would be a channel past the allowlist (data encoded in hostnames).
    // Without a proxy port the target gets no network at all.
    '(deny network-outbound)',
    // No listening on an IP socket either: a listener accepts connections from outside the sandbox
    // (the LAN, on 0.0.0.0), which would be a channel past the proxy. Unix sockets stay (local IPC).
    '(deny network-bind (local ip))',
    '(deny network-inbound (local ip))',
    `(deny mach-lookup ${DNS_SERVICES.map((n) => `(global-name ${quote(n)})`).join(' ')})`,
    ...(proxyPort ? [`(allow network-outbound (remote ip "localhost:${Number(proxyPort)}"))`] : []),
  ].join('\n');
}

// The target gets an allowlisted environment, not nuncius's own: tokens and keys in the caller's
// environment (GITHUB_TOKEN, AWS_*, ...) would otherwise be readable by every command it runs.
// Kept: what a shell and the CLIs need, the target's own vendor variables (its login), and
// sandbox.passEnv from the config (exact names, or prefixes ending in `*`).
const BASE_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', '__CF_USER_TEXT_ENCODING', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
const BASE_PREFIXES = ['LC_', 'XDG_', 'NUNCIUS_'];
const TARGET_PREFIXES = { codex: ['CODEX_', 'OPENAI_'], cursor: ['CURSOR_'], claude: ['CLAUDE_', 'ANTHROPIC_'] };

export function targetEnv(target, source = process.env, passEnv = []) {
  const names = new Set(BASE_ENV);
  const prefixes = [...BASE_PREFIXES, ...(TARGET_PREFIXES[target] ?? [])];
  for (const p of passEnv) {
    if (typeof p !== 'string' || !p) continue;
    if (p.endsWith('*')) prefixes.push(p.slice(0, -1));
    else names.add(p);
  }
  const out = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && (names.has(k) || prefixes.some((p) => p && k.startsWith(p)))) out[k] = v;
  // The user's global git config (~/.gitconfig, ~/.config/git/config) is denied to targets: it can
  // hold credential helpers and url rewrites. git treats an unreadable global config as fatal, so
  // without this every git command a target ran failed. Point git at no global config instead.
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  // The global ignore and attributes files (~/.config/git/ignore, .../attributes) are not readable
  // either; git warns on each command when it cannot read them, so it gets none.
  Object.assign(out, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: '/dev/null' });
  return out;
}

// Returns a function that turns (bin, args) into the sandboxed invocation.
// account: run the sandboxed target as that task account (ADR 12); its environment and secrets then
// travel in the command (accountCommand), not in the spawn environment.
export function sandboxWrapper({ worktree, callerRepo, target, proxyPort, runtimeDirs, config, runCwd, targetBin, gitDir, claudeTemp, account, accountEnv, secrets }) {
  const profile = buildProfile({ worktree, callerRepo, target, proxyPort, runtimeDirs, config, runCwd, targetBin, gitDir, claudeTemp, account });
  if (account) return (bin, args) => accountCommand({ account, env: accountEnv, secrets, sandboxExec: SANDBOX_EXEC, profile, bin, args });
  return (bin, args) => ({ bin: SANDBOX_EXEC, args: ['-p', profile, bin, ...args] });
}
