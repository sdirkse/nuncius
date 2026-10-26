import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Processes a target left running outside its process group. nuncius kills the target's group when the
// run ends, but a child started with setsid or `detached` (Cursor's own updater does this) leaves the
// group and would live on. Such a process still runs as the user, inside the target's sandbox; it is
// found by where it works or what it runs: its working folder, or a path on its command line, inside
// the task's own folders (worktree, throw-away HOME, caches). A process that moves out of them and
// runs only system binaries is not found this way; task accounts (ADR 12) stop those too.

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';

// ps etime: [[dd-]hh:]mm:ss -> seconds.
export function etimeSeconds(s) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// Both spellings of each folder: lsof reports real paths, a command line may hold either.
function spellings(dirs) {
  const out = new Set();
  for (const d of dirs) {
    if (typeof d !== 'string' || !d.startsWith('/') || d === '/') continue;
    out.add(d.replace(/\/+$/, ''));
    try {
      out.add(fs.realpathSync(d));
    } catch {
      // gone already: the given spelling is all there is
    }
  }
  return [...out];
}

// The user's processes started at or after `since` (ms) that work in, or name, one of `dirs`.
// Never this process or its ancestors. Returns [{ pid, reason }].
export function findStrays(dirs, { since = 0, uid = process.getuid(), now = Date.now() } = {}) {
  const roots = spellings(dirs);
  if (!roots.length) return [];
  let table;
  let cwds;
  try {
    table = execFileSync(PS, ['-A', '-ww', '-o', 'pid=,ppid=,uid=,etime=,command='], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return [];
  }
  try {
    cwds = execFileSync(LSOF, ['-a', '-u', String(uid), '-d', 'cwd', '-Fpn'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (err) {
    cwds = err.stdout?.toString() ?? ''; // lsof exits 1 when it could not see some process
  }
  const cwdOf = new Map();
  let pid = null;
  for (const line of cwds.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) cwdOf.set(pid, line.slice(1));
  }
  const procs = new Map();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), age: etimeSeconds(m[4]), command: m[5] });
  }
  const spare = new Set([process.pid]);
  for (let p = procs.get(process.pid)?.ppid, i = 0; p > 1 && i < 64; p = procs.get(p)?.ppid, i++) spare.add(p);
  // One second of slack: etime counts whole seconds.
  const maxAge = since ? Math.ceil((now - since) / 1000) + 1 : Infinity;
  const found = [];
  for (const [p, info] of procs) {
    if (spare.has(p) || info.uid !== uid || info.age === null || info.age > maxAge) continue;
    const cwd = cwdOf.get(p);
    if (cwd && roots.some((r) => within(cwd, r))) found.push({ pid: p, reason: `works in ${cwd}` });
    else if (roots.some((r) => info.command.includes(`${r}/`) || info.command.endsWith(r) || info.command.includes(`${r} `))) found.push({ pid: p, reason: `runs ${info.command.slice(0, 200)}` });
  }
  return found;
}

// Kill what findStrays finds, a few rounds (a stray may start another while the first is stopped).
// Returns every process stopped.
export function stopStrays(dirs, opts = {}) {
  const stopped = [];
  for (let round = 0; round < 5; round++) {
    const found = findStrays(dirs, opts);
    if (!found.length) break;
    for (const s of found) {
      try {
        process.kill(s.pid, 'SIGKILL');
        stopped.push(s);
      } catch {
        // gone already
      }
    }
  }
  return stopped;
}
