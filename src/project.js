import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitEnv } from './worktree.js';

// Project name: explicit flag > NUNCIUS_PROJECT env > git repo root name > current folder name.
export function detectProject(cwd, explicit) {
  if (explicit) return explicit;
  if (process.env.NUNCIUS_PROJECT) return process.env.NUNCIUS_PROJECT;
  // The repository's identity, not the checkout's: every `git worktree add` of a repo (whatever its
  // folder is called) shares the repo's .git dir, so it is the same project with the same budget.
  try {
    const [common, root] = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split('\n');
    if (common && path.basename(common) === '.git') return path.basename(path.dirname(common));
    if (root) return path.basename(root);
  } catch {
    // not a git repo
  }
  return path.basename(cwd);
}

export function detectAgent(explicit) {
  return explicit || process.env.NUNCIUS_AGENT || (process.env.CLAUDECODE ? 'claude' : 'manual');
}
