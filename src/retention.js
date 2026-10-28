import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, runsDir, usageLogPath } from './config.js';
import { readUsage, withUsageLock } from './log.js';
import { listTasks, tasksDir, TERMINAL } from './tasks.js';

// Retention (retention.days, default 7): nuncius keeps what a task said and did (the prompt, the
// target's answer, raw output, the patch, evidence copies) only that long after the task ended.
// The numbers stay: usage.jsonl records keep tokens, time and outcome, because budgets and the
// 30/90-day dashboard need them, but lose their prompt preview, error text and folder path.
// A task whose worktree is still open (work waiting for review) keeps everything until the
// worktree is gone: its patch and detail view are still needed.

// The fields of a usage record that carry content rather than numbers.
const CONTENT_FIELDS = ['promptPreview', 'error', 'cwd'];

export function retentionDays(config = loadConfig()) {
  const d = config.retention?.days;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : d === null ? null : 7;
}

// The run files of one task: <id>.out, <id>.patch, <id>.activity.jsonl and the <id>-evidence dir.
const runFiles = (id) => {
  let names = [];
  try {
    names = fs.readdirSync(runsDir()).filter((n) => n === `${id}.out` || n === `${id}.patch` || n === `${id}.activity.jsonl` || n === `${id}-evidence`);
  } catch {
    // no runs dir
  }
  return names.map((n) => path.join(runsDir(), n));
};

export function pruneOldContent({ now = Date.now(), dryRun = false, config = loadConfig() } = {}) {
  const days = retentionDays(config);
  const result = { days, tasks: 0, runFiles: 0, usageRecords: 0 };
  if (days === null) return result; // keep everything
  const cutoff = now - days * 86400000;
  const tasks = listTasks();
  const openWorktree = (t) => t.worktree && !t.worktree.removed && fs.existsSync(t.worktree.path);
  const keep = new Set(tasks.filter((t) => !TERMINAL.has(t.state) || openWorktree(t)).map((t) => t.id));
  const ended = (t) => Date.parse(t.finishedAt ?? t.updatedAt ?? t.createdAt);
  const remove = (p) => {
    if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
  };

  // Finished tasks past the cutoff: the task record and its run files.
  for (const t of tasks) {
    if (keep.has(t.id) || !(ended(t) < cutoff)) continue;
    remove(path.join(tasksDir(), `${t.id}.json`));
    result.tasks++;
    for (const f of runFiles(t.id)) {
      remove(f);
      result.runFiles++;
    }
  }
  // Run files whose task record is already gone, by their own age.
  let names = [];
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    // no runs dir
  }
  const known = new Set(tasks.map((t) => t.id));
  for (const n of names) {
    const id = /^([0-9a-f-]{36})(?:\.out|\.patch|\.activity\.jsonl|-evidence)$/.exec(n)?.[1];
    if (!id || known.has(id) || keep.has(id)) continue;
    const p = path.join(runsDir(), n);
    let mtime;
    try {
      mtime = fs.lstatSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      remove(p);
      result.runFiles++;
    }
  }

  // Usage records past the cutoff keep their numbers and lose their content.
  const strip = (r) => !keep.has(r.id) && Date.parse(r.startedAt) < cutoff && CONTENT_FIELDS.some((k) => r[k] != null);
  if (!readUsage().some(strip)) return result;
  if (dryRun) {
    result.usageRecords = readUsage().filter(strip).length;
    return result;
  }
  withUsageLock(() => {
    const records = readUsage(); // again, under the lock
    let changed = 0;
    const out = records.map((r) => {
      if (!strip(r)) return r;
      changed++;
      const outcome = r.ok ? {} : { refused: !!(r.refused || String(r.error ?? '').startsWith('refused')) };
      const kept = { ...r, ...outcome, contentRemoved: true };
      for (const k of CONTENT_FIELDS) delete kept[k];
      return kept;
    });
    const tmp = `${usageLogPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''));
    fs.renameSync(tmp, usageLogPath());
    result.usageRecords = changed;
  });
  return result;
}
