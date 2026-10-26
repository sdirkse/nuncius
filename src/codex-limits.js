import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.js';

// Codex writes session rollouts to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl.
// Their token_count events carry `rate_limits` (primary = 5h window, secondary = weekly).
// The format is not officially documented, so parsing is defensive and returns null when unsure.

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// A task's CODEX_HOME is written by the target, so only real files and dirs count (no symlinks,
// no FIFOs or devices that would block or redirect a read).
function listRollouts(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listRollouts(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function findRollout(threadId, home = codexHome()) {
  const files = listRollouts(path.join(home, 'sessions'));
  if (!files.length) return null;
  if (threadId) {
    const match = files.find((f) => path.basename(f).includes(threadId));
    if (match) return match;
  }
  return files
    .map((f) => {
      try {
        return { f, m: fs.lstatSync(f).mtimeMs };
      } catch {
        return { f, m: 0 };
      }
    })
    .sort((a, b) => b.m - a.m)[0].f;
}

// Rollouts can grow to hundreds of MB; only the tail matters.
function readTail(file, bytes = 2 * 1024 * 1024) {
  // O_NOFOLLOW: not through a link swapped in after listing; O_NONBLOCK + isFile: never hang on a FIFO.
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return ''; // a link (ELOOP) or vanished
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const size = st.size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// Shared by Codex and Claude parsing: limit data can come from files a task wrote, so every field is
// validated and anything malformed is dropped instead of throwing.
export function toIso(value, baseMs) {
  let ms = NaN;
  if (typeof value === 'number' && Number.isFinite(value)) ms = value * (Math.abs(value) < 1e12 ? 1000 : 1);
  else if (typeof value === 'string') ms = Date.parse(value);
  if (baseMs !== undefined && Number.isFinite(ms)) ms += baseMs;
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}

export const validPercent = (p) => (typeof p === 'number' && Number.isFinite(p) ? Math.min(Math.max(p, 0), 100) : null);

function normaliseWindow(w, observedAt) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = validPercent(w.used_percent);
  if (usedPercent === null) return null;
  let resetsAt = null;
  if (w.resets_at !== undefined) resetsAt = toIso(w.resets_at);
  else if (typeof w.resets_in_seconds === 'number' && Number.isFinite(w.resets_in_seconds) && Number.isFinite(Date.parse(observedAt)))
    resetsAt = toIso(Date.parse(observedAt) + w.resets_in_seconds * 1000);
  const windowMinutes = typeof w.window_minutes === 'number' && Number.isFinite(w.window_minutes) && w.window_minutes > 0 ? w.window_minutes : null;
  return { usedPercent, windowMinutes, resetsAt };
}

export function readRateLimits(file) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = readTail(file).split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('rate_limits')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // first line of the tail may be cut off
    }
    const rl = findKey(obj, 'rate_limits');
    if (!rl) continue;
    const observedAt = toIso(obj.timestamp) ?? new Date().toISOString();
    const primary = normaliseWindow(rl.primary, observedAt);
    const secondary = normaliseWindow(rl.secondary, observedAt);
    if (primary || secondary) return { observedAt, primary, secondary };
  }
  return null;
}

// Codex's 5-hour and weekly windows as Codex itself reports them: `account/rateLimits/read` on its
// app-server, run by nuncius outside any sandbox. Cached in nuncius's data dir (which no task can read
// or write) for a minute, so a burst of submits asks Codex once.
const LIVE_MAX_AGE_MS = 60000;
const livePath = () => path.join(dataDir(), 'codex-limits.json');

function liveWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = validPercent(w.usedPercent);
  if (usedPercent === null) return null;
  const windowMinutes = typeof w.windowDurationMins === 'number' && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null;
  return { usedPercent, windowMinutes, resetsAt: w.resetsAt == null ? null : toIso(w.resetsAt) };
}

export function readLiveCodexLimits() {
  try {
    const r = JSON.parse(fs.readFileSync(livePath(), 'utf8'));
    return r && typeof r === 'object' && r.source === 'codex account' ? r : null;
  } catch {
    return null;
  }
}

// Ask Codex again unless the cached reading is fresh. Returns the reading (or the old one when Codex
// does not answer). `ask` is codexAppServer from targets.js, passed in to avoid an import cycle.
export async function refreshCodexLimits(ask, bin, { force = false } = {}) {
  const cached = readLiveCodexLimits();
  if (!force && cached && Date.now() - Date.parse(cached.observedAt) < LIVE_MAX_AGE_MS) return cached;
  if (!bin) return cached;
  let result = null;
  try {
    result = await ask(bin, 'account/rateLimits/read', {});
  } catch {
    // no answer: keep what we had
  }
  const rl = result?.rateLimits;
  const primary = liveWindow(rl?.primary);
  const secondary = liveWindow(rl?.secondary);
  if (!primary && !secondary) return cached;
  const reading = { observedAt: new Date().toISOString(), source: 'codex account', primary, secondary };
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${livePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reading));
    fs.renameSync(tmp, livePath());
  } catch {
    // the reading is still returned
  }
  return reading;
}

// Pick, per window, the reading that shows the most usage and has not reset yet. Both sources are
// trusted (Codex's own answer, the user's own sessions); usage in a window only grows until it resets.
export function mergeLimits(...readings) {
  const now = Date.now();
  const valid = readings.filter(Boolean);
  if (!valid.length) return null;
  const pick = (key) =>
    valid
      .map((r) => r[key])
      .filter((w) => w && !(w.resetsAt && Date.parse(w.resetsAt) <= now))
      .sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? null;
  return {
    observedAt: valid.map((r) => r.observedAt).sort().at(-1),
    source: valid.map((r) => r.source).join(' + '),
    primary: pick('primary'),
    secondary: pick('secondary'),
  };
}
