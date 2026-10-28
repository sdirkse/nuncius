import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, runsDir, loadConfig, taskTimeoutSeconds } from './config.js';
import { appendUsage, readUsage } from './log.js';
import { checkBudget } from './budget.js';
import { checkExtraArgs } from './args.js';
import { TARGETS, TOOL_NAMES, isTarget, targetBin, findBin, targetStatus, codexAppServer } from './targets.js';
import { createWorktree, finishWorktree, removeWorktree, gitVersionProblem, gitCommonDir, gitEnv, worktreesDir } from './worktree.js';
import { ACCOUNTS, usesAccount, accountsProblem, accountLogin, shareTree, shareRoot, claudeTempBase, stopAccount, reclaim, emptyHome } from './accounts.js';
import { sandboxAvailable, sandboxWrapper, targetEnv } from './sandbox.js';
import { startProxy } from './proxy.js';
import { codexHome, refreshCodexLimits } from './codex-limits.js';
import { latestCodexLimits } from './summary.js';
import { collectEvidence } from './evidence.js';
import { clampRunUsage } from './num.js';
import { stopStrays } from './strays.js';
import { createProgress, progressView, shortDuration, parseActivityLog, cleanLabel, MAX_LOG } from './progress.js';

// A task lives in tasks/<id>.json and moves queued → running → done | failed | timeout.
// `refused` is terminal and set before anything runs. Workers are separate processes, so tasks
// survive the MCP server restarting; all coordination goes through these files and one lock.

export const TERMINAL = new Set(['done', 'failed', 'timeout', 'refused']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUNCIUS_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuncius.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A running task's progress is written to its file at most this often.
const PROGRESS_SAVE_MS = 1000;
const PROGRESS_BATCH_MS = 250;

export const tasksDir = () => path.join(dataDir(), 'tasks');

// The target's answer goes into the task file and back to the calling agent. Capture allows up to
// 64 MB; an answer that size would flood the caller's context, so the stored answer is capped and
// the full output stays in runs/<id>.out.
export const MAX_ANSWER_CHARS = 256 * 1024;
export function capOutput(output, id) {
  if (typeof output !== 'string' || output.length <= MAX_ANSWER_CHARS) return output;
  return `${output.slice(0, MAX_ANSWER_CHARS)}\n[nuncius: answer cut at ${MAX_ANSWER_CHARS} of ${output.length} characters; the full output is in ${path.join(runsDir(), `${id}.out`)}]`;
}
const taskPath = (id) => path.join(tasksDir(), `${id}.json`);

// A task's activity log: one JSON line per step, appended as it happens (so it survives a crashed
// worker), with a start and an end marker. Removed with the task's other run files (src/retention.js).
export const activityPath = (id) => path.join(runsDir(), `${id}.activity.jsonl`);
function appendActivity(id, entry) {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.appendFileSync(activityPath(id), `${JSON.stringify(entry)}\n`);
  } catch {
    // the log is a convenience: the task goes on without it
  }
}
// A running task's progress lives in its own file (runs/<id>.progress.json), written without the queue
// lock: nothing else writes it, so it can never overwrite a state the reaper set. When the task ends,
// the last progress goes into the task record and the file is removed.
export const progressPath = (id) => path.join(runsDir(), `${id}.progress.json`);
function writeProgress(id, progress) {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    const tmp = `${progressPath(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(progress));
    fs.renameSync(tmp, progressPath(id)); // atomic: readers never see half a file
  } catch {
    // progress is a convenience: the task goes on without it
  }
}
function removeProgress(id) {
  try {
    fs.rmSync(progressPath(id), { force: true });
  } catch {
    // left for retention to remove; never in the way of ending the task
  }
}
// The progress to show for a task: the live file while it runs, else what its record kept.
export function taskProgress(t) {
  if (t?.state === 'running' && ID_RE.test(String(t.id))) {
    try {
      const p = JSON.parse(fs.readFileSync(progressPath(t.id), 'utf8'));
      if (p && typeof p === 'object' && !Array.isArray(p)) return p;
    } catch {
      // no file yet, or a damaged one: fall back to the record
    }
  }
  return t?.progress ?? null;
}
// The log from byte `from` on, oldest first, whole lines only; `next` is where the following read starts.
// So a page that polls reads only what was appended since its last poll.
export function readActivity(id, { from = 0 } = {}) {
  if (!ID_RE.test(String(id))) return { items: [], next: 0 };
  let fd;
  try {
    fd = fs.openSync(activityPath(id), 'r');
  } catch {
    return { items: [], next: 0 }; // no log (an older task, or one that never ran)
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.min(from, size);
    const buf = Buffer.alloc(size - start);
    const read = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
    const end = read.lastIndexOf(0x0a) + 1; // a line still being written waits for the next read
    return { items: parseActivityLog(read.subarray(0, end).toString('utf8')), next: start + end };
  } finally {
    fs.closeSync(fd);
  }
}
const counted = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const progressCounts = (p) => `${counted(p?.steps ?? 0, 'step')} · ${counted(p?.filesEdited ?? 0, 'file')} edited · ${counted(p?.commands ?? 0, 'command')}`;
const secondsSince = (iso, now = Date.now()) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : 0;
};

// Only a well-formed record counts as a task: a damaged file (truncated, hand-edited, `null`) is
// ignored rather than crashing the queue code that reads every task under the lock.
const wellFormed = (t, id) => t && typeof t === 'object' && !Array.isArray(t) && t.id === id && typeof t.prompt === 'string' && typeof t.state === 'string';

export function readTask(id) {
  if (!ID_RE.test(String(id))) return null;
  try {
    const t = JSON.parse(fs.readFileSync(taskPath(id), 'utf8'));
    return wellFormed(t, id) ? t : null;
  } catch {
    return null;
  }
}

function writeTask(task) {
  fs.mkdirSync(tasksDir(), { recursive: true });
  const tmp = `${taskPath(task.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskPath(task.id)); // atomic: readers never see half a file
}

// Never creates a record: a task whose file is gone (or damaged) stays gone.
export function updateTask(id, patch) {
  const cur = readTask(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeTask(next);
  return next;
}

const taskIds = () => {
  try {
    return fs.readdirSync(tasksDir()).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
};
const byCreation = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));

export function listTasks() {
  return taskIds().map(readTask).filter(Boolean).sort(byCreation);
}

// The queued and running tasks, for the dashboard that asks every few seconds. A finished task never
// runs again, so once one is seen finished its file is not read again (only its id is remembered).
const finishedIds = new Set();
export function listLiveTasks() {
  const ids = taskIds();
  const present = new Set(ids);
  for (const id of finishedIds) if (!present.has(id)) finishedIds.delete(id);
  const live = [];
  for (const id of ids) {
    if (finishedIds.has(id)) continue;
    const t = readTask(id);
    if (!t) continue;
    if (TERMINAL.has(t.state)) finishedIds.add(id);
    else live.push(t);
  }
  return live.sort(byCreation);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// mkdir is atomic, so it doubles as a cross-process lock. The holder writes a token into it; a lock
// is only taken over when its holder process is gone, or it is held far longer than any critical
// section takes (a hung holder), and a holder only ever removes its own lock.
const LOCK_STALE_MS = 60000;

function readOwner(lock) {
  try {
    return fs.readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
}

function breakStaleLock(lock) {
  let age;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return; // released meanwhile
  }
  const owner = readOwner(lock);
  const pid = owner ? Number(owner.split(':')[0]) : null;
  // No owner yet: the holder is between mkdir and writing it, unless that was long ago.
  const stale = owner === null ? age > 10000 : (!pidAlive(pid) && age > 1000) || age > LOCK_STALE_MS;
  if (!stale) return;
  // Rename first (atomic, only one waiter wins), then check it was still the lock judged stale.
  const moved = `${lock}.stale-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lock, moved);
  } catch {
    return;
  }
  if (readOwner(moved) !== owner) {
    try {
      fs.renameSync(moved, lock); // a fresh lock replaced the stale one in between: give it back
      return;
    } catch {
      // a newer lock exists now; the moved one is removed below
    }
  }
  fs.rmSync(moved, { recursive: true, force: true });
}

async function withLock(fn) {
  const lock = path.join(dataDir(), 'queue.lock');
  const token = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(dataDir(), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), token);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      breakStaleLock(lock);
      await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return fn();
  } finally {
    if (readOwner(lock) === token) fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Mark tasks whose worker died as failed, so they stop holding or waiting for a slot. A task without
// a worker yet gets 30s from the moment it was queued (after its worktree was made, which can take
// long in a big repo). A running task whose worker is alive but far past the task timeout is hung:
// it stops holding its slot.
const HUNG_GRACE_MS = 120000;

// A reaped task that had started still used the target: it gets a usage record (it counts as a run
// with the time it ran), and a target its dead worker left behind is stopped.
function reap(tasks, config) {
  const now = Date.now();
  const hungAfter = taskTimeoutSeconds(config) * 1000 + HUNG_GRACE_MS;
  for (const t of tasks) {
    if (TERMINAL.has(t.state)) continue;
    // An unreadable timestamp counts as long ago: a damaged record must not hold a slot forever.
    const age = (iso) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? now - ms : Infinity;
    };
    const orphan = t.workerPid ? !workerAlive(t.workerPid) : age(t.queuedAt ?? t.createdAt) > 30000;
    const hung = !orphan && t.state === 'running' && age(t.startedAt) > hungAfter;
    if (!orphan && !hung) continue;
    const error = orphan ? 'worker exited unexpectedly' : 'worker did not finish within the task timeout';
    if (t.state === 'running') {
      if (t.account) {
        stopAccount(t.account);
        emptyHome(t.account);
      } else {
        stopTarget(t.targetProcess);
        stopStrays(taskDirs(t.targetProcess), { since: Date.parse(t.startedAt) });
      }
      const startedAt = Date.parse(t.startedAt);
      appendUsage({
        id: t.id, tool: t.target, model: t.model, alias: t.alias, project: t.project, agent: t.agent, caller: t.caller, cwd: t.cwd,
        startedAt: t.startedAt, wallMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0, ok: false, error, reaped: true,
        promptPreview: t.prompt.slice(0, 160),
      });
    }
    const progress = t.state === 'running' ? taskProgress(t) : null;
    if (t.state === 'running') appendActivity(t.id, { s: secondsSince(t.startedAt, now), kind: 'end', what: `Stopped: ${error} · ${progressCounts(progress)}` });
    Object.assign(t, updateTask(t.id, { state: 'failed', finishedAt: new Date().toISOString(), result: { ok: false, error }, ...(progress ? { progress } : {}) }));
    removeProgress(t.id);
  }
  return tasks;
}

// Kill a target's process group, but only if that pid still leads a group running the target's binary
// (pids are reused: never signal a stranger).
// A task's worker is alive only if that pid still runs nuncius (a worker, or a CLI run in-process).
// Pids are reused: a stranger that got the number must not hold the task's queue slot forever.
function workerAlive(pid) {
  if (!pidAlive(pid)) return false;
  try {
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return NUNCIUS_TASK_CMD.test(cmd);
  } catch {
    return true; // ps unavailable: fall back to the pid check alone
  }
}

function stopTarget(proc) {
  if (!proc?.pid || !proc.bin) return;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=,command=', '-p', String(proc.pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    if (!m || Number(m[1]) !== proc.pid || !m[2].includes(proc.bin)) return;
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // gone already
  }
}

// The folders a task's target worked in, as recorded at spawn: only ones inside nuncius's own worktree
// and scratch roots (a damaged record must not point the reaper at the user's other folders).
function taskDirs(proc) {
  const roots = [worktreesDir(), runtimeRoot()].map((r) => path.resolve(r));
  return (Array.isArray(proc?.dirs) ? proc.dirs : []).filter((d) => typeof d === 'string' && roots.some((r) => path.resolve(d).startsWith(`${r}/`)));
}

const inFlight = (tasks, exceptId) => tasks.filter((t) => !TERMINAL.has(t.state) && t.id !== exceptId);

// FIFO per target and overall: a task starts only when its target and the total have room and no
// older queued task that could also start is waiting.
function canStart(task, tasks, config) {
  const { perTarget, total } = config.concurrency;
  const running = tasks.filter((t) => t.state === 'running');
  const runningFor = (target) => running.filter((t) => t.target === target).length;
  if (running.length >= total || runningFor(task.target) >= perTarget) return false;
  return !tasks.some((t) => t.state === 'queued' && t.id !== task.id && t.createdAt < task.createdAt && runningFor(t.target) < perTarget);
}

// `tasks`: the task list when the caller already has it.
export function queueStatus(config = loadConfig(), tasks = listTasks()) {
  tasks = tasks.filter((t) => !TERMINAL.has(t.state));
  const count = (state, target) => tasks.filter((t) => t.state === state && (!target || t.target === target)).length;
  return {
    running: count('running'),
    queued: count('queued'),
    perTarget: Object.fromEntries(Object.keys(TARGETS).map((t) => [t, { running: count('running', t), queued: count('queued', t) }])),
    limits: config.concurrency,
  };
}

// Deny by default: any NUNCIUS_DEPTH other than empty or "0" counts as nested, including garbage.
export function envDepth(value = process.env.NUNCIUS_DEPTH) {
  if (value === undefined || value === '' || value === '0') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// The env var is under the child's control (it can unset it, and point NUNCIUS_HOME at an empty
// dir), so nesting is also detected from things a sandboxed child cannot change:
//  1. a canary file outside every data dir that every task profile denies reading: if we can see it
//     exists but cannot read it, we are inside a nuncius sandbox (this also survives setsid/reparenting);
//  2. the process tree: an ancestor that is a task-running nuncius process (the worker, or the CLI
//     running a task in-process). sandbox-exec itself never shows up: it execs into the target CLI.
// Both fail closed when they cannot be evaluated.
export const canaryPath = () => path.join(os.userInfo().homedir, '.nuncius-canary');

// Best effort: if it cannot be created (it exists, or home is not writable here), the other checks
// still apply. Inside a nuncius sandbox the path is denied, so reading it fails with EPERM either way.
export function ensureCanary() {
  try {
    fs.writeFileSync(canaryPath(), 'nuncius sandbox canary: targets cannot read this file\n', { flag: 'wx' });
  } catch {
    // ignore
  }
}

function canaryBlocked() {
  try {
    fs.readFileSync(canaryPath());
    return false;
  } catch (err) {
    return err.code !== 'ENOENT'; // EPERM/EACCES: a nuncius sandbox is hiding it from us
  }
}

// Anchored at the start of the command line: the process itself must be node running nuncius (a shell
// whose -c string merely mentions nuncius does not count). The script may be nuncius.js or an installed
// `nuncius` link (npm link / npm i -g), and its path may contain spaces.
export const NUNCIUS_TASK_CMD = /^\S*node\S*\s+(--\S+\s+)*(.*\/)?nuncius(\.js)?\s+(__worker|codex|cursor|claude)(\s|$)/;

// Ancestor command lines from one `ps` snapshot, or null when it cannot be read.
function ancestorCommands(pid = process.pid) {
  let table;
  try {
    // Absolute path: a target must not be able to shadow `ps` on PATH.
    table = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }
  const procs = new Map();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  if (!procs.has(pid)) return null;
  const out = [];
  let cur = procs.get(pid).ppid;
  for (let i = 0; cur > 1 && i < 64; i++) {
    const p = procs.get(cur);
    if (!p) break;
    out.push(p.command);
    cur = p.ppid;
  }
  return out;
}

// True when an agent CLI (Claude Code, Codex, Cursor's agent) is among our ancestors, or Claude Code's
// marker is set: then a person is not typing this command. Fails closed when ps cannot be read.
const AGENT_CLI = /^(claude|codex|cursor-agent)$/;
export function underAgent(env = process.env, ancestors = ancestorCommands()) {
  if (env.CLAUDECODE) return true;
  if (ancestors === null) return true;
  return ancestors.some((c) => c.split(/\s+/).slice(0, 2).some((w) => AGENT_CLI.test(path.basename(w))));
}

export function insideNunciusTask() {
  if (canaryBlocked()) return true;
  const ancestors = ancestorCommands();
  if (ancestors === null) return true;
  return ancestors.some((c) => NUNCIUS_TASK_CMD.test(c));
}

// A prompt is instructions, not data: a megabyte is far more than any task needs, and the prompt is
// kept in memory, in the task file and on the target's command line.
export const MAX_PROMPT_BYTES = 1024 * 1024;

// Codex's real 5-hour and weekly windows, asked from Codex itself (cached a minute).
export async function freshCodexLimits(config, { force = false } = {}) {
  const bin = findBin(targetBin('codex', config));
  await refreshCodexLimits(codexAppServer, bin, { force });
  return latestCodexLimits();
}

// Validate and record a task. Returns the task (state queued or refused) or { error } for bad input.
export async function submitTask({ target, model, alias, prompt, extraArgs = [], cwd, project, agent, caller, force = false, network = false }) {
  const config = loadConfig();
  if (!isTarget(target)) return { error: `unknown target "${target}"` };
  // Only targets this user has: installed and not disabled. Said before anything is queued.
  const status = targetStatus(config).find((t) => t.name === target);
  if (!status.available) return { error: `${target} is not available: ${status.reason}` };
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'prompt is required' };
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return { error: `prompt is ${Buffer.byteLength(prompt)} bytes; the limit is ${MAX_PROMPT_BYTES} (1 MB). Put large material in a file in the repository and refer to it.` };
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { error: `cwd is not a directory: ${cwd}` };
  const args = checkExtraArgs(target, [...(model ? ['--model', model] : []), ...extraArgs]);
  if (args.error) return { error: args.error };
  const blocked = blockedModel(target, args.args, config);
  if (blocked) return { error: `model "${blocked}" is blocked for ${target} (targets.${target}.blockedModels)` };

  const base = {
    id: crypto.randomUUID(), target, model: model ?? null, alias: alias ?? null, prompt, args: args.args,
    cwd, project, agent, caller: caller ?? null, force, network: !!network,
    depth: envDepth(),
    createdAt: new Date().toISOString(), workerPid: null,
  };

  // ADR 8: a target running under the nuncius may not use the nuncius again.
  ensureCanary();
  if (base.depth >= 1 || insideNunciusTask()) return refuse({ ...base, nested: true }, ['nested nuncius call: tasks started by the nuncius cannot start nuncius tasks']);
  const codexLimits = target === 'codex' ? await freshCodexLimits(config) : undefined;
  const budget = (tasks) => (force ? [] : checkBudget({ tool: target, project, config, records: readUsage(), codexLimits, inFlight: inFlight(tasks) }));
  // A first check before the (possibly slow) worktree: most refusals cost nothing.
  const early = budget(listTasks());
  if (early.length) return refuse(base, early);

  // ADR 5: no sandbox, no run. There is deliberately no unsandboxed fallback.
  if (!sandboxAvailable()) return { error: 'no sandbox available: nuncius needs macOS sandbox-exec to run targets' };
  const gitProblem = gitVersionProblem();
  if (gitProblem) return { error: gitProblem };
  // ADR 4: snapshot the caller's state into a worktree now, so later edits by the caller don't leak in.
  let worktree;
  try {
    worktree = createWorktree({ cwd, id: base.id, target });
  } catch (err) {
    return { error: err.message };
  }
  // The deciding check runs under the queue lock and writes the task in the same step, so tasks
  // submitted at the same moment (from several MCP servers) are counted one after another.
  const outcome = await withLock(() => {
    const tasks = reap(listTasks(), config);
    const queued = tasks.filter((t) => t.state === 'queued').length;
    const max = config.concurrency?.maxQueued;
    if (typeof max === 'number' && queued >= max)
      return { error: `the queue is full: ${queued} tasks are waiting (concurrency.maxQueued is ${max}). Wait for tasks to finish and try again.` };
    const reasons = budget(tasks);
    if (reasons.length) return { reasons };
    const task = { ...base, worktree, state: 'queued', queuedAt: new Date().toISOString() };
    writeTask(task);
    return { task };
  });
  if (outcome.task) return outcome.task;
  removeWorktree(worktree, { deleteBranch: true });
  return outcome.error ? { error: outcome.error } : refuse(base, outcome.reasons);
}

// Model ids passed with --model / -m (validated by checkExtraArgs) against targets.<t>.blockedModels.
export function blockedModel(target, args, config) {
  const blocked = (config.targets?.[target]?.blockedModels ?? []).filter((b) => typeof b === 'string' && b).map((b) => b.toLowerCase());
  if (!blocked.length) return null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--model' && args[i] !== '-m') continue;
    const m = args[i + 1].toLowerCase();
    if (blocked.some((b) => (b.endsWith('*') ? m.startsWith(b.slice(0, -1)) : m === b))) return args[i + 1];
  }
  return null;
}

// Per-task scratch dirs (cache, Codex home) live under a nuncius-owned root, not the shared temp dir:
// every task profile denies that root and reopens only the task's own dirs, so concurrent tasks
// cannot find or tamper with each other's. Unpredictable names (mkdtemp), 0700, removed afterwards.
export const runtimeRoot = () => process.env.NUNCIUS_RUNTIME || `${dataDir()}-runtime`;

function scratchDir(prefix) {
  fs.mkdirSync(runtimeRoot(), { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(runtimeRoot(), `${prefix}-`));
}

// Rename each dir to `<dir>.sealed` (same parent, inside the denied runtime root). If a rename
// fails the dir is left out (null): nuncius then reads nothing from it, but still removes it.
// The target can replace a dir itself with a symlink (it may write the dir's own path), so a sealed
// path that is not a real directory is not read from either (only the link is removed).
function sealDirs(dirs) {
  const out = new Map();
  for (const dir of dirs) {
    const to = `${dir}.sealed`;
    try {
      fs.renameSync(dir, to);
      out.set(dir, { path: to, real: fs.lstatSync(to).isDirectory() });
    } catch {
      out.set(dir, null);
    }
  }
  return out;
}
const readable = (sealed, dir) => (dir && sealed.get(dir)?.real ? sealed.get(dir).path : null);

// Never throws: a target can leave files it made immutable (chflags uchg) or unwritable (chmod),
// and a dir that cannot be removed must not cost the task its usage record or result.
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    // retry below
  }
  try {
    if (!fs.lstatSync(dir).isSymbolicLink()) {
      execFileSync('/usr/bin/chflags', ['-R', '-P', 'nouchg', dir], { stdio: 'ignore' });
      execFileSync('/bin/chmod', ['-R', '-P', 'u+rwx', dir], { stdio: 'ignore' });
    }
  } catch {
    // best effort
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Codex keeps sessions, logs and history in CODEX_HOME. The real one stays read-only; the task gets
// a throw-away home that only links the user's auth (read-only through the sandbox). config.toml is
// deliberately not carried over: it can declare MCP servers, which a delegated task should not get.
// copy: for a task account (ADR 12), which cannot read the user's auth.json (600): a private copy.
function taskCodexHome(realHome, { copy = false } = {}) {
  const dir = scratchDir('codex');
  const auth = path.join(realHome, 'auth.json');
  if (fs.existsSync(auth)) {
    // A task account gets the content with its secrets instead (src/accounts.js writes it, mode 600,
    // as the account): a file nuncius wrote here would be readable by the whole task-account group.
    if (!copy) fs.symlinkSync(auth, path.join(dir, 'auth.json'));
  }
  return dir;
}

// Codex refreshes its login by rewriting auth.json. The link to the real file is read-only, so a
// refresh inside a task lands (if at all) in the throw-away home and is discarded with it. Refresh
// tokens can be single-use, so the user's own login may then need `codex login`. Nuncius does not copy
// the task's file back (it was written by the target); it reports that this happened.
// original: the copy's content, for a task account (a copy is never a link; compare instead).
function codexAuthReplaced(sealedHome, original) {
  if (!sealedHome) return false;
  try {
    if (original != null) return fs.readFileSync(path.join(sealedHome, 'auth.json'), 'utf8') !== original;
    return !fs.lstatSync(path.join(sealedHome, 'auth.json')).isSymbolicLink();
  } catch {
    return false; // never existed, or removed
  }
}

// The repository's config can hold credentials (a token in a remote URL, credential.* settings) and
// settings that run commands (core.fsmonitor, core.sshCommand), so the target never reads it. Its git
// gets a shadow common dir instead (GIT_COMMON_DIR): links to the real objects, refs and the rest,
// and a config with only the settings git needs to read the repository.
const SAFE_CORE_KEYS = new Set(['repositoryformatversion', 'filemode', 'bare', 'ignorecase', 'precomposeunicode', 'symlinks', 'logallrefupdates', 'autocrlf', 'eol', 'safecrlf', 'checkstat', 'trustctime', 'quotepath', 'sparsecheckout', 'splitindex', 'untrackedcache']);
function taskGitShadow(commonDir) {
  const dir = scratchDir('git');
  for (const name of fs.readdirSync(commonDir)) if (name !== 'config' && name !== 'config.worktree') fs.symlinkSync(path.join(commonDir, name), path.join(dir, name));
  let lines = [];
  try {
    lines = execFileSync('git', ['config', '-f', path.join(commonDir, 'config'), '--get-regexp', '^(core|extensions)\\.'], { encoding: 'utf8', env: gitEnv() }).split('\n').filter(Boolean);
  } catch {
    // no such settings
  }
  for (const line of lines) {
    const [key, ...rest] = line.split(' ');
    const [section, name] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    // extensions.worktreeConfig is left out: git then reads no config.worktree files (they are closed).
    if ((section === 'extensions' && name.toLowerCase() !== 'worktreeconfig') || SAFE_CORE_KEYS.has(name)) execFileSync('git', ['config', '-f', path.join(dir, 'config'), key, rest.join(' ')], { env: gitEnv() });
  }
  if (!fs.existsSync(path.join(dir, 'config'))) fs.writeFileSync(path.join(dir, 'config'), '');
  return dir;
}

// Cursor keeps its CLI settings (incl. the permission allowlist) and per-workspace state (chat
// transcripts, MCP descriptors, canvases its IDE runs) under ~/.cursor, and loads plugins (with their
// MCP servers, e.g. Atlassian) from $HOME/.cursor/plugins. The task gets a throw-away HOME instead:
// a *copy* of the user's CLI settings, no plugins, MCP servers, hooks or rules, and a link to the
// macOS keychain folder so the user's Cursor login still works. Nothing it writes reaches later sessions.
function taskCursorHome() {
  const home = scratchDir('cursor');
  const realHome = os.userInfo().homedir;
  const realConfig = process.env.CURSOR_CONFIG_DIR || path.join(realHome, '.cursor');
  fs.mkdirSync(path.join(home, '.cursor'));
  for (const name of ['cli-config.json', 'agent-cli-state.json']) {
    const src = path.join(realConfig, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, '.cursor', name));
  }
  fs.mkdirSync(path.join(home, 'Library'));
  fs.symlinkSync(path.join(realHome, 'Library', 'Keychains'), path.join(home, 'Library', 'Keychains'));
  return home;
}

// ADR 9: what every target is told before the actual task.
export function withPreamble(task) {
  return [
    '[nuncius] You are working in an isolated git worktree of the caller\'s project, on its own branch.',
    '- Make your changes in this directory. Do not commit, push or switch branches: nuncius commits your work when you finish.',
    `- Network access for the commands you run is ${task.network ? 'ON' : 'OFF'}. Files outside this worktree are read-only or unavailable.`,
    '- Do not call nuncius or `nuncius` yourself.',
    '- End with a short summary of what you changed and why.',
    '',
    'Task:',
    task.prompt,
  ].join('\n');
}

function refuse(base, reasons) {
  const task = { ...base, state: 'refused', finishedAt: base.createdAt, result: { ok: false, error: `refused: ${reasons.join('; ')}`, reasons } };
  writeTask(task);
  appendUsage({
    id: task.id, tool: task.target, project: task.project, agent: task.agent, caller: task.caller, cwd: task.cwd,
    startedAt: task.createdAt, wallMs: 0, ok: false, refused: true, error: task.result.error, promptPreview: task.prompt.slice(0, 160),
  });
  return task;
}

// Start a detached worker for a queued task (used by the MCP server).
export function spawnWorker(id) {
  const child = spawn(process.execPath, [NUNCIUS_BIN, '__worker', id], { detached: true, stdio: 'ignore', env: process.env });
  // Without a listener, a failed spawn (EAGAIN, EMFILE, ...) would crash the MCP server.
  child.on('error', (err) => {
    try {
      const t = readTask(id);
      if (t && t.state === 'queued' && !t.workerPid) updateTask(id, { state: 'failed', finishedAt: new Date().toISOString(), result: { ok: false, error: `could not start a worker: ${err.message}` } });
    } catch {
      // the reaper marks it failed later
    }
  });
  child.unref();
  return child.pid;
}

// Wait for a slot, run the target, record usage and the result. Runs in a worker or in the CLI.
// Whatever goes wrong after the task was picked up, it ends in a terminal state with a usage record.
export async function executeTask(id, { echoStderr = false } = {}) {
  const ctx = { recorded: false, startedAt: null, progress: null, stopProgress: null };
  try {
    return await runTask(id, { echoStderr }, ctx);
  } catch (err) {
    const error = `nuncius error: ${String(err?.message ?? err).slice(0, 300)}`;
    const task = readTask(id);
    if (!task) throw err;
    if (!ctx.recorded && ctx.startedAt) {
      try {
        appendUsage({ id, tool: task.target, project: task.project, agent: task.agent, caller: task.caller, cwd: task.cwd, startedAt: new Date(ctx.startedAt).toISOString(), wallMs: Date.now() - ctx.startedAt, ok: false, error, promptPreview: task.prompt.slice(0, 160) });
      } catch {
        // nothing more we can do
      }
    }
    if (TERMINAL.has(task.state)) return task;
    // A run that broke off after its start marker still gets an end marker, its time and its last progress.
    let ran = {};
    if (ctx.progress) {
      ctx.stopProgress?.();
      const progress = ctx.progress.snapshot();
      const wallMs = Date.now() - ctx.startedAt;
      appendActivity(id, { s: Math.round(wallMs / 1000), kind: 'end', what: `Failed: ${cleanLabel(error).slice(0, 80)} · ${progressCounts(progress)}` });
      removeProgress(id);
      ran = { progress, wallMs };
    }
    return updateTask(id, { state: 'failed', finishedAt: new Date().toISOString(), result: { ok: false, error }, ...ran });
  }
}

// A record for a run that never reached the target: it shows in the log but does not count as a run.
function notStarted(task, fields) {
  appendUsage({ id: task.id, tool: task.target, project: task.project, agent: task.agent, caller: task.caller, cwd: task.cwd, startedAt: new Date().toISOString(), wallMs: 0, ok: false, started: false, promptPreview: task.prompt.slice(0, 160), ...fields });
}

async function runTask(id, { echoStderr }, ctx) {
  const config = loadConfig();
  for (;;) {
    const step = await withLock(() => {
      const tasks = reap(listTasks(), config);
      const task = tasks.find((t) => t.id === id);
      if (!task || task.state !== 'queued') return 'settled'; // gone, reaped, or already handled
      // Claimed under the lock, so the reaper and this worker never overwrite each other's write.
      if (task.workerPid !== process.pid) updateTask(id, { workerPid: process.pid });
      if (!canStart(task, tasks, config)) return 'wait';
      // ADR 12: a task account of its own, not used by another running task.
      let account;
      if (usesAccount(config, task.target)) {
        const used = new Set(tasks.filter((t) => t.state === 'running').map((t) => t.account));
        account = ACCOUNTS.find((a) => !used.has(a));
        if (!account) return 'wait';
      }
      updateTask(id, { state: 'running', startedAt: new Date().toISOString(), workerPid: process.pid, ...(account ? { account } : {}) });
      return 'run';
    });
    if (step === 'settled') return readTask(id);
    if (step === 'run') break;
    await sleep(500);
  }

  const task = readTask(id);
  // The budget may have run out while the task waited in the queue. Other tasks still in flight count.
  const codexLimits = task.target === 'codex' && !task.force ? await freshCodexLimits(config) : undefined;
  const reasons = task.force ? [] : checkBudget({ tool: task.target, project: task.project, config, records: readUsage(), codexLimits, inFlight: inFlight(listTasks(), id) });
  if (reasons.length) {
    const result = { ok: false, error: `refused: ${reasons.join('; ')}`, reasons };
    notStarted(task, { refused: true, error: result.error });
    if (task.worktree) removeWorktree(task.worktree, { deleteBranch: true });
    return updateTask(id, { state: 'refused', finishedAt: new Date().toISOString(), result, worktree: task.worktree && { ...task.worktree, removed: true } });
  }

  const bin = findBin(targetBin(task.target, config));
  if (!bin) {
    const error = `${targetBin(task.target, config)} not found on PATH`;
    notStarted(task, { error });
    if (task.worktree) removeWorktree(task.worktree, { deleteBranch: true });
    return updateTask(id, { state: 'failed', finishedAt: new Date().toISOString(), result: { ok: false, error }, worktree: task.worktree && { ...task.worktree, removed: true } });
  }
  fs.mkdirSync(task.worktree.runCwd, { recursive: true });

  // ADR 12: as a task account. The accounts must be ready and the login at hand, or the task is not
  // run at all (never quietly as the user instead).
  const account = task.account;
  let login = { secrets: {} };
  let claudeTemp = null;
  if (account) {
    stopAccount(account);
    emptyHome(account);
    let problem = accountsProblem(os.userInfo().homedir);
    if (!problem) {
      login = accountLogin(task.target);
      problem = login.error ?? null;
    }
    if (!problem && task.target === 'claude' && !(claudeTemp = claudeTempBase(account))) problem = `could not prepare Claude's temp folder for ${account}`;
    if (problem) {
      const error = `task accounts: ${problem}`;
      notStarted(task, { error });
      if (task.worktree) removeWorktree(task.worktree, { deleteBranch: true });
      return updateTask(id, { state: 'failed', finishedAt: new Date().toISOString(), result: { ok: false, error }, worktree: task.worktree && { ...task.worktree, removed: true } });
    }
  }

  // Egress: the target's own API hosts, plus the general list when the task asked for network.
  const allow = [...(config.targets?.[task.target]?.apiDomains ?? []), ...(task.network ? config.network.domains : [])];
  ensureCanary(); // must exist before the target starts, so a nested call sees it denied

  ctx.startedAt = Date.now();
  // What the target is doing, from its own event stream: kept in its progress file (at most once a
  // second) and, from the CLI, printed as it happens.
  // The full log goes to its own file; past MAX_LOG steps they are only counted (a looping target cannot fill the disk).
  let logLines = 0;
  const logStep = (entry) => {
    if (logLines < MAX_LOG) appendActivity(id, entry);
    else if (logLines === MAX_LOG) appendActivity(id, { s: entry.s, kind: 'note', what: `The log is full (${MAX_LOG} steps): later steps are counted, not logged` });
    logLines++;
  };
  appendActivity(id, { s: 0, kind: 'start', what: `Started · ${TOOL_NAMES[task.target] ?? task.target}${task.model ? ` · ${task.model}` : ''}` });
  const progress = createProgress({
    target: task.target, base: task.worktree.path, timeoutSeconds: taskTimeoutSeconds(config), onLog: logStep,
    onActivity: echoStderr ? (a) => process.stderr.write(`[nuncius] ${shortDuration((Date.now() - ctx.startedAt) / 1000)} ${a.what}\n`) : undefined,
  });
  // Saved a moment after an event, so a burst of them lands in one write, and then at most once a second.
  let progressSaved = 0;
  let progressTimer = null;
  const saveProgress = () => {
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      progressSaved = Date.now();
      writeProgress(id, progress.snapshot());
    }, Math.max(PROGRESS_BATCH_MS, progressSaved + PROGRESS_SAVE_MS - Date.now()));
    progressTimer.unref();
  };
  ctx.progress = progress;
  ctx.stopProgress = () => clearTimeout(progressTimer);
  updateTask(id, { progress: progress.snapshot() });
  let proxy = null;
  const runtimeDirs = [];
  let sealed = new Map();
  let res;
  let evidence = null;
  let codexHomeDir = null;
  let cursorHome = null;
  let codexAuthCopy = null;
  let spawnedAt = null;
  const warnings = [];
  try {
    proxy = await startProxy({ allow });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const proxyEnv = { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' };
    // Per-task cache and temp dirs instead of the shared ~/.cache and $TMPDIR, so nothing persists
    // into other programs and concurrent tasks cannot see each other's temp files.
    const cacheDir = scratchDir('cache');
    runtimeDirs.push(cacheDir);
    const tmpDir = scratchDir('tmp');
    runtimeDirs.push(tmpDir);
    const commonDir = gitCommonDir(task.worktree);
    const gitShadow = commonDir ? taskGitShadow(commonDir) : null;
    if (gitShadow) runtimeDirs.push(gitShadow);
    if (task.target === 'codex') runtimeDirs.push((codexHomeDir = taskCodexHome(codexHome(), { copy: !!account })));
    if (account && codexHomeDir) {
      try {
        codexAuthCopy = fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8');
        login.secrets = { ...login.secrets, NUNCIUS_CODEX_AUTH: codexAuthCopy };
      } catch {
        // no login file
      }
    }
    if (task.target === 'cursor') runtimeDirs.push((cursorHome = taskCursorHome()));
    // A task account cannot use the user's home: Codex and Claude get a throw-away one too.
    const accountHomeDir = account && task.target !== 'cursor' ? scratchDir('home') : null;
    if (accountHomeDir) runtimeDirs.push(accountHomeDir);
    if (account) {
      shareRoot(worktreesDir());
      shareRoot(runtimeRoot());
      shareTree(task.worktree.path);
      for (const d of runtimeDirs) shareTree(d);
    }
    const env = {
      ...targetEnv(task.target, process.env, config.sandbox?.passEnv),
      ...proxyEnv, NUNCIUS_DEPTH: String(task.depth + 1), XDG_CACHE_HOME: cacheDir, TMPDIR: tmpDir,
      // zsh writes here-documents to $TMPPREFIX (default /tmp/zsh), not $TMPDIR; /tmp is closed.
      TMPPREFIX: path.join(tmpDir, 'zsh'),
      ...(gitShadow ? { GIT_COMMON_DIR: gitShadow } : {}),
      ...(codexHomeDir ? { CODEX_HOME: codexHomeDir } : {}),
      ...(cursorHome ? { HOME: cursorHome, CURSOR_CONFIG_DIR: path.join(cursorHome, '.cursor'), CURSOR_DATA_DIR: path.join(cursorHome, '.cursor') } : {}),
      ...(accountHomeDir ? { HOME: accountHomeDir, ...(task.target === 'claude' ? { CLAUDE_CONFIG_DIR: path.join(accountHomeDir, '.claude') } : {}) } : {}),
      // git refuses a repository owned by another account; this one task's worktree is named as safe.
      ...(account ? { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: fs.realpathSync(task.worktree.path) } : {}),
    };

    res = await TARGETS[task.target].run({
      bin,
      prompt: withPreamble(task),
      extraArgs: task.args,
      cwd: task.worktree.runCwd,
      env,
      timeoutMs: taskTimeoutSeconds(config) * 1000,
      // Recorded so the reaper can stop the target if this worker dies before it does.
      onSpawn: (pid) => {
        spawnedAt = Date.now();
        updateTask(id, { targetProcess: { pid, bin, dirs: [task.worktree.path, ...runtimeDirs] } });
      },
      echoStderr,
      onLine: (line) => {
        if (progress.feed(line)) saveProgress();
      },
      wrap: sandboxWrapper({ worktree: task.worktree.path, callerRepo: task.worktree.root, target: task.target, proxyPort: proxy.port, runtimeDirs, config: config.sandbox, runCwd: task.worktree.runCwd, targetBin: bin, gitDir: commonDir,
        ...(account ? { account, accountEnv: env, secrets: login.secrets, claudeTemp } : {}) }),
    }).then(
      (r) => r,
      (err) => ({ ok: false, error: String(err), rawStdout: '', exitCode: 1, usage: null, limits: null }),
    );
    clearTimeout(progressTimer); // the final write below carries the last progress
    // As a task account: stop everything it started (however it detached), then hand back what it
    // wrote (it may have made files unreadable to the user) before nuncius reads or commits any of it.
    if (account) {
      stopAccount(account);
      reclaim(account, [task.worktree.path, ...runtimeDirs]);
    } else {
      // Without a task account: what the target started outside its process group (Cursor's updater).
      const strays = stopStrays([task.worktree.path, ...runtimeDirs], { since: spawnedAt ?? ctx.startedAt });
      if (strays.length) warnings.push(`stopped ${strays.length} process(es) ${task.target} left running after it finished: ${strays.map((s) => s.reason).join('; ').slice(0, 300)}`);
    }
    // Seal the throw-away dirs before reading them: renamed out of the paths the sandbox may write,
    // a process the target left running can no longer swap files for symlinks while nuncius reads.
    sealed = sealDirs(runtimeDirs);
    if (codexAuthReplaced(readable(sealed, codexHomeDir), codexAuthCopy))
      warnings.push('Codex rewrote its login (auth.json) inside the task; that copy was discarded. If your own Codex session stops working, run `codex login`.');
    try {
      evidence = collectEvidence({ id, target: task.target, rawStdout: res.rawStdout, codexHomeDir: readable(sealed, codexHomeDir), cursorHome: readable(sealed, cursorHome) });
    } catch (err) {
      evidence = { models: [], source: null, files: [], error: String(err).slice(0, 200) };
    }
  } finally {
    if (account) {
      stopAccount(account); // also when the run threw
      emptyHome(account);
    }
    proxy?.close();
    for (const dir of runtimeDirs) {
      const s = sealed.get(dir);
      if (!removeDir(s?.path ?? dir)) warnings.push(`could not remove a scratch dir: ${s?.path ?? dir}`);
    }
  }
  const wallMs = Date.now() - ctx.startedAt;
  res.usage = clampRunUsage(res.usage, wallMs);
  // Codex's limits as Codex itself reports them after the run, never what the task wrote.
  if (task.target === 'codex') {
    try {
      res.limits = (await refreshCodexLimits(codexAppServer, bin, { force: true })) ?? null;
    } catch {
      res.limits = null;
    }
  }
  const egress = { allow, allowed: [...proxy.seen.allowed], denied: [...proxy.seen.denied] };

  const error = res.timedOut ? `timed out after ${taskTimeoutSeconds(config)}s` : res.error;
  appendUsage({
    id, tool: task.target, model: task.model, alias: task.alias, project: task.project, agent: task.agent, caller: task.caller, cwd: task.cwd,
    startedAt: new Date(ctx.startedAt).toISOString(), wallMs, ok: res.ok && !res.timedOut, exitCode: res.exitCode, error,
    sessionId: res.sessionId, usage: res.usage, limits: res.limits, forced: task.force || undefined,
    modelsReported: evidence?.models ?? [],
    promptPreview: task.prompt.slice(0, 160),
  });
  ctx.recorded = true;
  fs.mkdirSync(runsDir(), { recursive: true });
  // Raw output (Claude's stream-json is the whole transcript) lives only here, not in the task file.
  fs.writeFileSync(path.join(runsDir(), `${id}.out`), res.rawStdout ?? '');
  // Done: commit the target's work on the task branch. Failed or timed out: keep the worktree as-is for inspection.
  let worktree = task.worktree;
  let commitError = null;
  if (res.ok && !res.timedOut) {
    try {
      worktree = finishWorktree(task.worktree, { id, target: task.target, prompt: task.prompt });
    } catch (err) {
      commitError = `target finished but committing its work failed: ${err.message}`;
    }
  }
  const endState = commitError ? 'failed' : res.timedOut ? 'timeout' : res.ok ? 'done' : 'failed';
  const ending = endState === 'done' ? 'Done' : endState === 'timeout' ? `Timed out after ${shortDuration(taskTimeoutSeconds(config))}` : `Failed: ${cleanLabel(commitError ?? error ?? 'unknown error').slice(0, 80)}`;
  appendActivity(id, { s: Math.round(wallMs / 1000), kind: 'end', what: `${ending} · ${progressCounts(progress.snapshot())}` });
  const finished = updateTask(id, {
    worktree,
    egress,
    evidence,
    progress: progress.snapshot(),
    ...(warnings.length ? { warnings } : {}),
    state: endState,
    finishedAt: new Date().toISOString(),
    wallMs,
    result: { ok: res.ok && !res.timedOut && !commitError, output: capOutput(res.output, id), error: commitError ?? error, exitCode: res.exitCode, usage: res.usage, limits: res.limits },
  });
  removeProgress(id);
  return finished;
}

// Stops waiting early when `signal` is aborted (the MCP client cancelled); the task itself runs on.
export async function waitForTask(id, seconds, { signal } = {}) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const task = readTask(id);
    if (!task || TERMINAL.has(task.state) || Date.now() >= deadline || signal?.aborted) return task;
    await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
  }
}

function runningNote(p) {
  if (!p) return '';
  const of = p.timeoutSeconds ? ` of at most ${shortDuration(p.timeoutSeconds)}` : '';
  const last = p.lastActivity.secondsAgo == null ? '' : p.lastActivity.what || p.steps ? `, last activity ${shortDuration(p.lastActivity.secondsAgo)} ago` : ', no activity reported yet';
  const quiet = p.quiet ? `. No activity for ${shortDuration(p.lastActivity.secondsAgo)}: it may be stuck, or thinking for a long time` : '';
  return `: ${shortDuration(p.elapsedSeconds)}${of}${last}${quiet}`;
}

// What callers see: no raw output, prompt shortened, a hint when it is still going.
export function publicTask(task) {
  if (!task) return null;
  const { rawStdout, ...result } = task.result ?? {};
  const out = {
    id: task.id, state: task.state, target: task.target, model: task.model, alias: task.alias,
    project: task.project, agent: task.agent, cwd: task.cwd,
    createdAt: task.createdAt, startedAt: task.startedAt ?? null, finishedAt: task.finishedAt ?? null,
    wallMs: task.wallMs ?? null, promptPreview: task.prompt.slice(0, 160),
  };
  // Hosts the target tried to reach but the proxy refused: useful when a task fails for lack of network.
  if (task.egress?.denied?.length) out.blockedHosts = task.egress.denied;
  if (task.result) out.result = result;
  const progress = progressView(taskProgress(task), { state: task.state, startedAt: task.startedAt, finishedAt: task.finishedAt, wallMs: task.wallMs });
  if (progress) out.progress = progress;
  if (task.warnings?.length) out.warnings = task.warnings;
  if (task.evidence) out.modelsReported = { models: task.evidence.models, source: task.evidence.source, files: task.evidence.files?.length ?? 0 };
  const wt = task.worktree;
  if (wt) {
    out.worktree = wt.changed
      ? { branch: wt.branch, commit: wt.commit, base: wt.base, files: wt.files, diffStat: wt.diffStat, sensitiveFiles: wt.sensitiveFiles ?? [], ...(wt.repoDrivers ? { repoDrivers: wt.repoDrivers } : {}), patch: wt.patchPath, review: wt.review, apply: wt.apply, applyPatch: wt.applyPatch }
      : wt.removed
        ? { branch: wt.branch, changed: false, removed: true }
        : { branch: wt.branch, path: wt.path, kept: true };
    if (task.state === 'done' && wt.changed)
      out.next = `Review the changes (worktree.review) and decide yourself whether to apply them (worktree.apply). Nothing has been merged into your branch.` +
        // Only a count here: file names are target-controlled and this field reads as instructions.
        (wt.sensitiveFiles?.length ? ` WARNING: ${wt.sensitiveFiles.length} changed file(s) configure tools or run code (listed in worktree.sensitiveFiles); review those with extra care and tell the user before applying.` : '') +
        (wt.repoDrivers?.length ? ' This repo has git filter/merge drivers that run code from the repo (worktree.repoDrivers): applying runs them outside the sandbox with the task\'s changes, so every changed file is flagged.' : '');
    if (task.state === 'done' && wt.changed === false) out.next = 'The target made no file changes.';
    // Only while it still exists: a task that failed before the target ran has no worktree left.
    if ((task.state === 'failed' || task.state === 'timeout') && !wt.removed && !wt.changed)
      out.next = `The worktree is kept for inspection at ${wt.path}. \`nuncius cleanup\` later saves any changes in it on ${wt.branch} and removes the checkout.`;
  }
  // Times and counts only: the activity label is target-controlled and this field reads as instructions.
  if (!TERMINAL.has(task.state)) out.next = `Still ${task.state}${runningNote(progress)}. Call wait_task with id "${task.id}" to keep waiting, or get_task to check without waiting.`;
  return out;
}
