import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDir, runsDir } from './config.js';

// ADR 4: every task gets a git worktree on nuncius/<target>/<short id>, based on the caller's HEAD
// plus a snapshot commit of the caller's uncommitted changes. The nuncius commits the target's work;
// the caller reviews and merges. Repo hooks never run for nuncius's own git commands.

const IDENTITY = ['-c', 'user.name=nuncius', '-c', 'user.email=nuncius@localhost', '-c', 'commit.gpgsign=false'];

// Never let repo or worktree config run code during nuncius's own git commands.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];

// Every diff nuncius reads or hands out is produced the same way, whatever the user's git config says
// (diff.external, color.ui=always, diff.noprefix, diff.renames, ...) and whatever .gitattributes the
// target left in the tree (textconv, `-diff`): exact paths, a/ b/ prefixes, no renames, no drivers.
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];

// The empty tree, as attribute source for git runs in a worktree the target wrote: in-tree
// .gitattributes then have no effect on nuncius's own git commands.
const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

// Nuncius's own git must act on the repository it was pointed at (cwd), with nuncius's own settings.
// Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, ...;
// set, for example, when nuncius is started from a git hook) would redirect it to another repository
// or add config; they are dropped. Only what nuncius sets itself (`extra`) is passed.
export function gitEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) out[k] = v;
  return { ...out, ...extra };
}

function git(cwd, args, { input, raw = false, env } = {}) {
  const out = execFileSync('git', [...SAFE, ...args], {
    cwd,
    input,
    env: gitEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  return raw ? out : out.toString();
}

// For commands a person copies into a shell: single quotes, so `$`, backticks and `"` in a path stay literal.
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Worktrees live next to the data dir, not inside it: the data dir is unreadable from the sandbox,
// and targets (Claude Code at least) refuse to write when an ancestor of their cwd is unreadable.
export const worktreesDir = () => process.env.NUNCIUS_WORKTREES || `${dataDir()}-worktrees`;

// In-tree .gitattributes must not drive nuncius's own git in or around a repo the target controls
// (textconv, and clean/smudge filter drivers defined in the repo's config, which run as shell
// commands outside the sandbox during diff/checkout). Reading attributes from the empty tree
// disables them. Needs git 2.41+ for GIT_ATTR_SOURCE (older git ignores it silently, so tasks are
// refused there: see gitVersionProblem). Used on `diff` and `worktree add` (checkout); not on
// `git apply`, which crashes with GIT_ATTR_SOURCE set in some git versions (it does run filter
// drivers; here it only applies the caller's own uncommitted changes, which are trusted).
// GIT_ATTR_SOURCE first appears in git 2.41.0 (attr.c, git.c); on older git the protection above
// would silently do nothing, so nuncius will not run a task there.
export const MIN_GIT_VERSION = [2, 41, 0];

export function parseGitVersion(text) {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

// null when git is new enough, else the reason to refuse.
export function gitVersionProblem() {
  let out;
  try {
    out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  } catch {
    return 'git not found: nuncius needs git 2.41 or newer';
  }
  const v = parseGitVersion(out);
  const need = MIN_GIT_VERSION.join('.');
  if (!v) return `could not read the git version ("${out.trim()}"): nuncius needs git ${need} or newer`;
  for (let i = 0; i < 3; i++) {
    if (v[i] > MIN_GIT_VERSION[i]) return null;
    if (v[i] < MIN_GIT_VERSION[i]) return `git ${v.join('.')} is too old: nuncius needs git ${need} or newer (older git ignores GIT_ATTR_SOURCE, which keeps a target's .gitattributes filters from running outside the sandbox)`;
  }
  return null;
}

function emptyAttrEnv(cwd) {
  let fmt = 'sha1';
  try {
    fmt = git(cwd, ['rev-parse', '--show-object-format']).trim();
  } catch {
    // default sha1
  }
  return { GIT_ATTR_SOURCE: EMPTY_TREE[fmt] ?? EMPTY_TREE.sha1 };
}

export function repoRoot(cwd) {
  try {
    return fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return null;
  }
}

// Returns the worktree record, or throws with a message meant for the caller.
export function createWorktree({ cwd, id, target }) {
  const root = repoRoot(cwd);
  if (!root) throw new Error(`not a git repository: ${cwd} (nuncius runs every task in a git worktree)`);
  let head;
  try {
    head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    throw new Error(`repository has no commits yet: ${root}`);
  }
  const short = id.slice(0, 8);
  const branch = `nuncius/${target}/${short}`;
  const attrEnv = emptyAttrEnv(root);
  fs.mkdirSync(worktreesDir(), { recursive: true, mode: 0o700 });
  const wtPath = path.join(fs.realpathSync(worktreesDir()), `${path.basename(root)}-${short}`);

  // Snapshot what the caller sees: tracked changes (staged and unstaged) and untracked, non-ignored files.
  const diff = git(root, ['diff', ...DIFF_FLAGS, 'HEAD', '--binary'], { raw: true, env: attrEnv });
  // A nested repository shows up as one `dir/` entry: it is not part of this repo's snapshot.
  const listed = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const untracked = listed.filter((rel) => !rel.endsWith('/'));
  const skipped = listed.filter((rel) => rel.endsWith('/'));

  git(root, ['worktree', 'add', '-q', '-b', branch, wtPath, head], { env: attrEnv });
  // Remember where this worktree's git metadata lives, so later commands never rely on discovery
  // through `<worktree>/.git`, which sits inside the area the target could write to.
  const gitDir = fs.realpathSync(path.resolve(wtPath, git(wtPath, ['rev-parse', '--git-dir']).trim()));
  const gitFile = fs.readFileSync(path.join(wtPath, '.git'), 'utf8');
  try {
    // The caller's own changes (trusted content), so no attr source is needed here (and
    // GIT_ATTR_SOURCE crashes `git apply` in some git versions).
    if (diff.length) git(wtPath, ['apply', '--binary', '--whitespace=nowarn'], { input: diff });
    for (const rel of untracked) {
      const src = path.join(root, rel);
      if (fs.lstatSync(src).isDirectory()) {
        skipped.push(rel);
        continue;
      }
      const dest = path.join(wtPath, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { verbatimSymlinks: true });
    }
    let base = head;
    if (diff.length || untracked.length) {
      git(wtPath, ['add', '-A'], { env: attrEnv });
      git(wtPath, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', `nuncius: snapshot of uncommitted changes for task ${id}`], { env: attrEnv });
      base = git(wtPath, ['rev-parse', 'HEAD']).trim();
    }
    // Run the target in the same subdirectory the caller is in.
    const rel = path.relative(root, fs.realpathSync(cwd));
    return { root, path: wtPath, branch, head, base, gitDir, gitFile, runCwd: path.join(wtPath, rel), createdAt: new Date().toISOString(), ...(skipped.length ? { skippedUntracked: skipped } : {}) };
  } catch (err) {
    removeWorktree({ root, path: wtPath, branch }, { deleteBranch: true });
    throw new Error(`could not snapshot uncommitted changes into the worktree: ${err.message}`);
  }
}

// git in a worktree after the target ran: refuse if `.git` was tampered with, and pass the
// git dir explicitly instead of discovering it.
// The repository's shared git dir (objects, refs, config) behind a worktree, from the `commondir`
// file in the worktree's own git dir. Both were recorded by nuncius before the target ran, and the
// caller's repo is not writable by a target, so this is the caller's real .git.
export function gitCommonDir(wt) {
  try {
    const rel = fs.readFileSync(path.join(wt.gitDir, 'commondir'), 'utf8').trim();
    return fs.realpathSync(path.resolve(wt.gitDir, rel));
  } catch {
    return wt.gitDir ? fs.realpathSync(wt.gitDir) : null;
  }
}

function wtGit(wt, args, opts) {
  const dotGit = path.join(wt.path, '.git');
  const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
  if (!st?.isFile() || fs.readFileSync(dotGit, 'utf8') !== wt.gitFile) throw new Error('the worktree\'s .git pointer was modified; refusing to run git there');
  const format = git(wt.path, ['--git-dir', wt.gitDir, 'rev-parse', '--show-object-format']).trim();
  return git(wt.path, ['--git-dir', wt.gitDir, '--work-tree', wt.path, ...args], { ...opts, env: { GIT_ATTR_SOURCE: EMPTY_TREE[format] ?? EMPTY_TREE.sha1 } });
}

// Files that configure tools or run code on their own once applied: agent settings and hooks, CI,
// git hooks/attributes, package scripts and editor tasks. The nuncius still commits them, but flags
// them so the caller reviews them first.
// Anchored per path segment, so nested projects (monorepos) are covered too. Matching is
// case-insensitive (macOS file systems usually are); odd names (control chars) always count.
// Directories match with or without a trailing part, so `.claude` itself (e.g. a symlink) counts too.
const SENSITIVE = [
  /(^|\/)\.claude(\/|$)/, /(^|\/)CLAUDE(\.local)?\.md$/, /(^|\/)AGENTS\.md$/, /(^|\/)\.cursor(\/|$)/, /(^|\/)\.cursorrules$/, /(^|\/)\.codex(\/|$)/,
  /(^|\/)\.mcp\.json$/, /(^|\/)\.github\/workflows(\/|$)/, /(^|\/)\.gitlab-ci\.yml$/, /(^|\/)\.husky(\/|$)/, /(^|\/)\.githooks(\/|$)/,
  /(^|\/)\.gitattributes$/, /(^|\/)\.gitmodules$/, /(^|\/)package\.json$/, /(^|\/)\.npmrc$/, /(^|\/)\.vscode(\/|$)/, /(^|\/)\.envrc$/,
  /(^|\/)(GNU)?makefile$/, /(^|\/)\.pre-commit-config\.ya?ml$/,
  // CI pipelines and other entry points that a checkout, build or test step runs on its own.
  /(^|\/)\.circleci(\/|$)/, /(^|\/)Jenkinsfile$/, /(^|\/)azure-pipelines\.ya?ml$/, /(^|\/)\.buildkite(\/|$)/,
  /(^|\/)\.drone\.yml$/, /(^|\/)bitbucket-pipelines\.yml$/, /(^|\/)\.teamcity(\/|$)/,
  /(^|\/)setup\.py$/, /(^|\/)conftest\.py$/, /(^|\/)pyproject\.toml$/, /(^|\/)setup\.cfg$/,
];
// Fail closed: any name outside printable ASCII counts as sensitive. Unicode lookalikes, case
// folding (the Kelvin sign is "k" on macOS), invisible format and bidi characters can all make a name
// look harmless while the file system or a tool treats it as e.g. package.json, so they are not
// matched cleverly; they are simply flagged. Plain-ASCII names are matched case-insensitively.
const SENSITIVE_I = SENSITIVE.map((re) => new RegExp(re.source, 'i'));
// A symlink always counts: once applied it can point a harmless-looking name at anything.
// flagAll: every changed file counts (see repoDrivers).
export const sensitiveFiles = (files, links = new Set(), { flagAll = false } = {}) =>
  files.filter((f) => flagAll || links.has(f) || /[^\x20-\x7e]/.test(f) || SENSITIVE_I.some((re) => re.test(f)));

// The caller's own filter and merge driver commands that may run code from the repo. Both
// `git cherry-pick` and `git apply` run these drivers outside the sandbox, from the repo root, so if
// the task changed anything such a command runs or loads, the target's version runs on apply. Which
// files a command reaches cannot be worked out reliably (a script may `source` another file, `node x`
// loads x.js, a script the task adds does not exist yet), so this is an allowlist: a driver is safe
// only when it is a known installed tool with plain arguments. Every other driver counts as running
// repo code, and then every changed file is flagged.
const KNOWN_DRIVERS = new Set(['git-lfs', 'git-crypt', 'true', 'false', 'cat']);
// `--`, placeholders (%O %A %B %f ...), flags without attached values, and lowercase subcommand words.
const PLAIN_ARG = /^(--|%[A-Za-z]|--?[A-Za-z][A-Za-z0-9-]*|[a-z][a-z-]*)$/;

export function knownSafeDriver(cmd, root) {
  if (/[^\w\s%./-]/.test(cmd)) return false; // shell syntax, quoting, expansion: cannot tell
  const [prog, ...args] = cmd.trim().split(/\s+/);
  if (!prog) return false;
  if (prog.includes('/')) {
    if (!path.isAbsolute(prog)) return false;
    const r = fs.realpathSync(root);
    if (prog.startsWith(r + path.sep) || prog.startsWith(root + path.sep)) return false;
    if (!KNOWN_DRIVERS.has(path.basename(prog))) return false;
  } else if (!KNOWN_DRIVERS.has(prog)) {
    return false;
  }
  return args.every((a) => PLAIN_ARG.test(a));
}

export function repoDrivers(root) {
  let lines;
  try {
    lines = git(root, ['config', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$']).split('\n').filter(Boolean);
  } catch {
    return []; // none configured
  }
  return lines.filter((line) => !knownSafeDriver(line.replace(/^\S+\s*/, ''), root));
}

// Paths whose new mode in a diff is a symlink (120000), from `git diff --raw -z` output:
// ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
export function symlinkPaths(raw) {
  const out = new Set();
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].split(' ');
    if (meta[1] === '120000') out.add(parts[i + 1]);
  }
  return out;
}

// For human-facing output: target-controlled names must not carry terminal escapes or line breaks.
const UNSAFE_CHARS = '[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c]';
const HAS_UNSAFE = new RegExp(UNSAFE_CHARS, 'u');
const UNSAFE = new RegExp(UNSAFE_CHARS, 'gu');
export const displayName = (f) =>
  HAS_UNSAFE.test(f) ? `"${f.replace(/["\\]/g, '\\$&').replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"` : f;

// Commit what the target changed. No changes: the worktree and branch are removed right away.
export function finishWorktree(wt, { id, target, prompt }) {
  wtGit(wt, ['add', '-A']);
  // NUL-separated, unquoted: exact paths even with newlines, quotes or non-ASCII in the name.
  const files = wtGit(wt, ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  if (!files.length) {
    removeWorktree(wt, { deleteBranch: true });
    return { ...wt, changed: false, removed: true };
  }
  const title = prompt.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? 'task';
  wtGit(wt, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', `nuncius(${target}): ${title}`, '-m', `nuncius task ${id}`]);
  const commit = wtGit(wt, ['rev-parse', 'HEAD']).trim();
  fs.mkdirSync(runsDir(), { recursive: true });
  const patchPath = path.join(runsDir(), `${id}.patch`);
  fs.writeFileSync(patchPath, wtGit(wt, ['diff', ...DIFF_FLAGS, '--binary', wt.base, commit], { raw: true }));
  const drivers = repoDrivers(wt.root);
  const links = symlinkPaths(wtGit(wt, ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, '--raw', '-z', wt.base, commit]));
  return {
    ...wt,
    changed: true,
    commit,
    files,
    diffStat: wtGit(wt, ['diff', ...DIFF_FLAGS, '--stat', wt.base, commit]).trim(),
    sensitiveFiles: sensitiveFiles(files, links, { flagAll: drivers.length > 0 }),
    ...(drivers.length ? { repoDrivers: drivers } : {}),
    patchPath,
    review: `git -C ${shQuote(wt.root)} diff --no-ext-diff --no-textconv --no-renames ${wt.base.slice(0, 12)} ${commit.slice(0, 12)}`,
    // The caller runs apply in their real repo. Disable hooks (a tracked hook would otherwise run on
    // the commit) and read .gitattributes from their current HEAD, not from the target's new tree, so
    // a .gitattributes the target added cannot switch on a filter driver during the cherry-pick.
    apply: `GIT_ATTR_SOURCE=HEAD git -C ${shQuote(wt.root)} -c core.hooksPath=/dev/null cherry-pick ${commit.slice(0, 12)}`,
    // Alternative: apply the patch to the working tree (no commit, no hooks). It still runs the
    // caller's configured filter drivers, like cherry-pick: see driverCommands / sensitiveFiles.
    applyPatch: `git -C ${shQuote(wt.root)} apply ${shQuote(patchPath)}`,
  };
}

// A failed or timed-out task leaves its work uncommitted in the worktree. Before the checkout is
// removed, that work is committed on the task branch, so cleanup never throws it away. Returns the
// { ok: true, commit } with the new commit (null: nothing to save), or { ok: false } when it could
// not be saved (e.g. the worktree's .git pointer was tampered with).
export function saveLeftoverWork(wt, { id, note = 'Not reviewed: the task failed or timed out before nuncius committed it.', subject = `nuncius: work left by unfinished task ${id}` }) {
  try {
    wtGit(wt, ['add', '-A']);
    const files = wtGit(wt, ['diff', ...DIFF_FLAGS, '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    if (!files.length) return { ok: true, commit: null };
    wtGit(wt, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', subject, '-m', note]);
    return { ok: true, commit: wtGit(wt, ['rev-parse', 'HEAD']).trim() };
  } catch {
    return { ok: false, commit: null };
  }
}

// Returns whether the branch was deleted. It is deleted only while its tip is still the commit nuncius
// recorded (the task's commit, or the base when it made none): commits someone added on the branch
// afterwards are not nuncius's to throw away.
export function removeWorktree({ root, path: wtPath, branch, commit, base }, { deleteBranch = false } = {}) {
  try {
    git(root, ['worktree', 'remove', '--force', wtPath]);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      // repo may be gone
    }
  }
  if (!deleteBranch) return false;
  const expected = commit ?? base;
  try {
    if (expected && git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).trim() !== expected) return false;
  } catch {
    return false; // already gone
  }
  try {
    git(root, ['branch', '-D', branch]);
    return true;
  } catch {
    return false;
  }
}

// True when every commit on the task branch (after the snapshot) is already in the repo's HEAD,
// merged or cherry-picked.
export function isApplied(wt) {
  if (!wt.commit) return false;
  try {
    const lines = git(wt.root, ['cherry', 'HEAD', wt.commit, wt.base]).split('\n').filter(Boolean);
    return lines.length > 0 && lines.every((l) => l.startsWith('-'));
  } catch {
    return false;
  }
}
