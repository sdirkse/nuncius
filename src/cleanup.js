import fs from 'node:fs';
import { loadConfig } from './config.js';
import { listTasks, readTask, updateTask, TERMINAL } from './tasks.js';
import { isApplied, removeWorktree, saveLeftoverWork } from './worktree.js';
import { pruneOldContent } from './retention.js';

// ADR 4: remove worktrees whose work is already in the repo (merged or cherry-picked), and
// worktrees older than worktrees.keepDays. Unapplied task branches with commits are kept, so
// no work is ever lost; only the checkout goes. Uncommitted work a failed task left behind is
// committed on its branch first; a worktree whose work cannot be saved is kept as it is.
export function cleanup({ days, dryRun = false, appliedOnly = false } = {}) {
  const keepDays = days ?? loadConfig().worktrees.keepDays;
  const cutoff = Date.now() - keepDays * 86400000;
  const actions = [];
  for (const task of listTasks()) {
    const wt = task.worktree;
    if (!wt || wt.removed || !TERMINAL.has(task.state)) continue;
    if (!fs.existsSync(wt.path)) {
      if (!dryRun) updateTask(task.id, { worktree: { ...wt, removed: true } });
      continue;
    }
    // A worktree its caller asked to keep (close_task with keep: true) goes only when it is closed.
    if (wt.keep) {
      if (!appliedOnly) actions.push({ id: task.id, path: wt.path, branch: wt.branch, reason: 'kept: marked keep, close it with nuncius close', branchDeleted: false, kept: true });
      continue;
    }
    const applied = isApplied(wt);
    const old = !appliedOnly && Date.parse(task.finishedAt ?? task.createdAt) < cutoff;
    if (!applied && !old) continue;
    actions.push(removeTaskWorktree(task, { applied, reason: applied ? 'applied' : `older than ${keepDays} days`, dryRun }));
  }
  return actions;
}

// Remove one finished task's checkout. Before that, anything uncommitted in it is saved on the branch:
// work a failed task never committed, and edits made in the worktree after the task finished
// (including applied ones). Nothing is deleted if that save fails.
function removeTaskWorktree(task, { applied, reason, dryRun = false }) {
  const wt = task.worktree;
  let leftover = null;
  if (!dryRun) {
    const note = wt.commit
      ? 'Not reviewed: changes found in the worktree after the task was committed.'
      : 'Not reviewed: the task failed or timed out before nuncius committed it.';
    const saved = saveLeftoverWork(wt, { id: task.id, subject: `nuncius: uncommitted work saved from task ${task.id}`, note });
    if (!saved.ok) return { id: task.id, path: wt.path, branch: wt.branch, reason: 'kept: its changes could not be saved on the branch', branchDeleted: false, kept: true };
    leftover = saved.commit;
  }
  // The branch may be deleted only when everything on it is already in the repo: nothing extra was
  // just saved, and either the task's work is applied or it never produced a commit.
  const deleteBranch = !leftover && (applied || !wt.commit);
  const branchDeleted = dryRun ? deleteBranch : removeWorktree(wt, { deleteBranch });
  if (!dryRun) updateTask(task.id, { worktree: { ...wt, removed: true, branchDeleted, ...(leftover ? { leftoverCommit: leftover } : {}) } });
  return { id: task.id, path: wt.path, branch: wt.branch, reason, branchDeleted, ...(leftover ? { savedCommit: leftover } : {}) };
}

// close_task and `nuncius close <id>`: the caller is done with a finished task's worktree, also when
// it applied only part of it by hand, rejected it or only read it. The checkout goes as in cleanup:
// uncommitted edits are saved on the branch first, and the branch stays unless all of it is in the
// repo. keep: true marks the worktree as still needed instead; the automatic and age-based cleanup
// then leave it alone until it is closed.
export function closeTask(id, { keep = false } = {}) {
  const task = readTask(id);
  if (!task) return { error: `no task with id "${id}"` };
  if (!TERMINAL.has(task.state)) return { error: `task "${id}" is still ${task.state}: wait for it to finish first` };
  const wt = task.worktree;
  if (!wt || wt.removed || !fs.existsSync(wt.path)) {
    if (wt && !wt.removed) updateTask(id, { worktree: { ...wt, removed: true } });
    return { id, closed: true, note: 'This task has no open worktree.' };
  }
  if (keep) {
    updateTask(id, { worktree: { ...wt, keep: true } });
    return { id, kept: true, path: wt.path, branch: wt.branch, note: 'The worktree stays until you close it (close_task without keep).' };
  }
  const applied = isApplied(wt);
  const r = removeTaskWorktree(task, { applied, reason: 'closed' });
  if (r.kept) return { id, closed: false, path: wt.path, branch: wt.branch, error: r.reason };
  return {
    id, closed: true, branch: wt.branch, branchDeleted: r.branchDeleted,
    ...(r.savedCommit ? { savedCommit: r.savedCommit } : {}),
    note: r.branchDeleted ? 'The worktree and its branch are removed: the work is in the repo.' : `The worktree is removed; its work stays on branch ${wt.branch}.`,
  };
}

// Worktrees whose work is already in the repo hold nothing anyone still needs: they are removed
// automatically (with their branch) whenever a task is submitted or the dashboard refreshes, at
// most once a minute. Old but unapplied worktrees are left to `nuncius cleanup`.
let lastAuto = 0;
let lastPrune = 0;
export function autoCleanup({ now = Date.now(), force = false } = {}) {
  if (!force && now - lastAuto < 60000) return [];
  lastAuto = now;
  // Old task content goes too (retention.days), at most every ten minutes.
  if (force || now - lastPrune > 600000) {
    lastPrune = now;
    try {
      pruneOldContent({ now });
    } catch {
      // housekeeping must never break the caller
    }
  }
  try {
    if (loadConfig().worktrees.autoRemoveApplied === false) return [];
    return cleanup({ appliedOnly: true });
  } catch {
    return []; // housekeeping must never break the caller
  }
}

export function openWorktrees() {
  return listTasks()
    .filter((t) => t.worktree && !t.worktree.removed && fs.existsSync(t.worktree.path))
    .map((t) => ({
      id: t.id, state: t.state, target: t.target, project: t.project, branch: t.worktree.branch, path: t.worktree.path,
      changed: t.worktree.changed ?? null, keep: !!t.worktree.keep, files: t.worktree.files ?? [], sensitiveFiles: t.worktree.sensitiveFiles?.length ?? 0,
      review: t.worktree.review ?? null, apply: t.worktree.apply ?? null, createdAt: t.createdAt, finishedAt: t.finishedAt ?? null,
    }));
}
