# 4. A git worktree per task

Status: accepted · 2026-10-17

## Context
The caller and the target editing the same files at the same time corrupts work.

## Decision
- Every task runs in its own git worktree on the branch `nuncius/<target>/<task id>`.
- The base is the caller's HEAD plus the caller's uncommitted changes (tracked diff and untracked files), so the target sees exactly what the caller sees.
- When the target finishes, Nuncius commits the worktree and returns the branch, the summary and the diff stat. **The caller reviews and merges.** Nuncius never merges into the caller's branch.
- A directory that is not a git repo is refused with a clear error. There is no copy fallback.
- `nuncius cleanup` removes worktrees whose branch is merged or older than 7 days. The dashboard lists open worktrees.

## Implementation notes (2026-10-17)
- The worktree is created at submit time, so edits the caller makes while a task is queued do not leak in. Location: `~/.nuncius/worktrees/<repo>-<short id>`.
- The caller's uncommitted state becomes one snapshot commit, so the task's own commit contains only the target's work. `apply` therefore suggests `git cherry-pick <commit>` (run with hooks off and `GIT_ATTR_SOURCE=HEAD`; see the apply-safety note below), or `git apply` of the saved patch.
- Ignored files are not copied. That keeps secrets such as `.env` out, but it also means dependencies (`node_modules`) are missing. A task that needs them must install them with `network: true`.
- Nuncius's own git commands run with `core.hooksPath=/dev/null`, `--no-verify` and a fixed identity, so repository hooks never run outside the sandbox.
- "Applied" means `git cherry HEAD <commit> <base>` marks every commit as already present, which covers both merging and cherry-picking.

## Location (2026-10-17)
Worktrees moved from `~/.nuncius/worktrees/` to `~/.nuncius-worktrees/` (or `NUNCIUS_WORKTREES`). The data dir is unreadable from the sandbox, and Claude Code refuses to write files when an ancestor of its working directory cannot be read. Other tasks' worktrees cannot be read or written from the sandbox. Only the root directory itself is listable, because it is an ancestor of the task's cwd. The root is created with mode 0700.

## Apply and snapshot run no untrusted code (2026-10-21)
A multi-model red-team review showed that the branch Nuncius hands back is untrusted, and that applying it, or even snapshotting the caller's repo, could run code:
- **Apply ran the caller's git hooks and could activate a filter driver.** `git cherry-pick`, run by the caller in their real repo, fires commit hooks (a tracked `hooks/post-commit` under a configured `core.hooksPath`), and a `.gitattributes` the target added can switch on a `filter.<name>.smudge` the caller has configured. The returned `apply` command now runs with `-c core.hooksPath=/dev/null` and `GIT_ATTR_SOURCE=HEAD`, so hooks do not run and attributes are read from the caller's current HEAD, not from the target's new tree. `applyPatch` (a plain `git apply` of the patch) runs no hooks. (It does run filter drivers: see the correction below.) Both are single, valid shell commands (the old `apply` string embedded `(or: …)` prose that broke if run).
- **The snapshot ran the repo's own filter drivers outside the sandbox.** `git diff HEAD --binary`, `git worktree add` and the snapshot `git add` run before any sandbox exists; in a repo whose `.git/config` defines a clean/smudge driver (e.g. a repo delivered as an archive), those drivers ran as shell commands. Nuncius now runs them with `GIT_ATTR_SOURCE` set to the empty tree, so in-tree `.gitattributes` assign no drivers. `git apply` keeps no attr source there (it only applies the caller's own, trusted changes, and `GIT_ATTR_SOURCE` crashes it in some git versions). `SAFE` already neutralises `core.hooksPath`, `core.fsmonitor` and `core.attributesFile`.
- **Older git ignored that protection silently.** `GIT_ATTR_SOURCE` first appears in git 2.41.0 (checked in git's own `attr.c`/`git.c` and 2.41 release notes; 2.40.0 has no trace of it). On older git the empty-tree attr source does nothing, so the filter drivers above would run again with no sign of it. Nuncius now refuses to run a task when `git --version` is below 2.41.0, before any worktree is made.
- **Cleanup discarded work.** It saved uncommitted work only for a failed task that never committed; edits made in a worktree after a done task finished were deleted with the checkout. Cleanup now commits anything uncommitted on the branch before removing any worktree, and keeps the branch when it holds work not yet in the repo.
- **The sensitive-file list missed entry points.** Added: CircleCI, Jenkins, Azure Pipelines, Buildkite, Drone, Bitbucket, TeamCity, `setup.py`, `conftest.py`, `pyproject.toml`, `setup.cfg`.

Remaining, by design: terminal escape sequences and binary content in a file the target wrote pass through the `review` command (plain `git diff` in the caller's terminal); the full bytes are in the patch file, and file names in Nuncius's own output are escaped. A `.gitattributes` or hook the target adds is still committed (and flagged), so applying it puts it in the caller's tree for next time; `apply` only stops it running during the apply itself.

## Second red-team round (2026-10-21)
- **Correction: `git apply` does run filter drivers.** The note above said it runs none; reproduced otherwise. Both apply methods run the caller's configured clean/smudge drivers (and cherry-pick its merge drivers) outside the sandbox. `GIT_ATTR_SOURCE=HEAD` stops a target's *new* `.gitattributes` from assigning drivers, but if the caller's repo already has a driver whose command is a script *inside the repo*, a task that changes that script gets its version run on apply (reproduced with both methods). Nuncius now reads the caller's `filter.*.{clean,smudge,process}` and `merge.*.driver` commands. Which files a driver script loads cannot be known (it may `source` another one; an automated review pointed out that matching file names in the command misses that), so this fails closed with an allowlist (a second automated review showed that detecting "refers into the repo" still missed a script the task adds, `node x` loading `x.js`, and `-Ipath` flags): a driver is trusted only when its program is a known installed tool (`git-lfs`, `git-crypt`, `true`, `false`, `cat`, by name or by an absolute path outside the repo) and every argument is `--`, a `%` placeholder, a flag without an attached value, or a lowercase subcommand word. Any shell syntax, quoting or expansion makes a driver untrusted. When any driver is untrusted, **every** changed file is flagged and the result lists those drivers in `repoDrivers`. The default git-lfs and git-crypt configurations are trusted and flag nothing.
- **Cleanup deleted commits added after the task.** A branch was force-deleted when the recorded task commit was applied, even if someone had committed more on it since. A branch is now deleted only while its tip is still the commit Nuncius recorded (or the base, when the task made none).
- **Refuted:** "a target can commit in its worktree and split review from apply" — the caller's repo, including `.git`, is write-denied to the target, so it cannot create commits. A change in the caller's own git config (an include into the worktree, a pager, `-diff` attributes) can affect `review`; that config is the caller's, not the target's.
