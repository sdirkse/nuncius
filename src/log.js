import fs from 'node:fs';
import path from 'node:path';
import { dataDir, usageLogPath } from './config.js';

// Appends and the retention rewrite of the log (src/retention.js) take this lock, so a rewrite can
// never drop a record appended at the same moment. It is not the queue lock: appendUsage runs while
// the queue lock is held. A lock older than STALE_MS is from a process that died holding it.
const STALE_MS = 30000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withUsageLock(fn, { waitMs = 5000 } = {}) {
  const lock = path.join(dataDir(), 'usage.lock');
  fs.mkdirSync(dataDir(), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // gone in between
      }
      if (Date.now() > until) return { locked: false };
      sleep(20);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function appendUsage(record) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const line = JSON.stringify(record) + '\n';
  // A record is never lost: if the lock cannot be had in time, append anyway (appends are atomic).
  if (!withUsageLock(() => fs.appendFileSync(usageLogPath(), line)).locked) fs.appendFileSync(usageLogPath(), line);
}

export function readUsage() {
  const p = usageLogPath();
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r);
    } catch {
      // skip a corrupt line rather than losing the whole log
    }
  }
  return out;
}

export function localDay(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
