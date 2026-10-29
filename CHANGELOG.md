# Changelog

All notable changes to nuncius are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Releases are built by GitHub Actions** when a version bump is merged, through npm's trusted publishing, and go live on npm only after a maintainer approves them with two-factor authentication (npm's staged publishing).

## [0.2.0] - 2026-10-29

**Task progress.** Long tasks (Cursor runs of 15 to 30 minutes) looked the same as stuck ones: callers only got "Still running", the dashboard showed a ticking timer and nothing else, and a Cursor run that timed out left an empty output file. You can now see what a running task is doing, while it runs and afterwards.

### Added

- **Progress while a task runs.** Nuncius reads each tool's own event stream as it arrives (Claude's and Cursor's `stream-json`, Codex's `--json`): elapsed time against the timeout, when the tool last did something and what (`Edit src/game.js`, `Shell: npm test`), and counts of steps, edited files and commands.
- **`get_task` and `wait_task` return `progress`.** The `next` hint now says how long the task has run and when it last did something. It gives times and counts only: the activity text comes from the tool, so it stays out of the hint that agents read as instructions.
- **Quiet warning.** After 5 minutes without any event a task is marked `quiet`: it may be stuck, or the model may be thinking for a long time. Nuncius only reports this; it still stops a task only at the timeout.
- **Step lines on the command line.** `nuncius cursor …` (and `codex`, `claude`) prints one line per step while it runs, e.g. `[nuncius] 9 s edit calc.py`.
- **Activity log per task.** Every step is appended to `~/.nuncius/runs/<id>.activity.jsonl` as it happens, from a `Started` marker to an end marker (`Done`, `Failed: …`, `Timed out after …` or `Stopped: …`) with the counts. A crashed worker still leaves its log. At most 2,000 steps are logged; later ones are counted. The log is removed with the task's other content after `retention.days`.
- **Dashboard, Now section.**
  - Last activity per task: how long ago (ticking each second) and the step on one line, the full text and counts in the tooltip.
  - Duration against the timeout.
  - The section refreshes every 2 seconds from a new `/api/live` endpoint, and the whole page refreshes as soon as a task starts or finishes, instead of after up to 15 seconds.
  - The table has fixed columns and one line per cell, so it no longer grows and shrinks with the activity.
- **Dashboard, task window.** Click a task's last activity (or its prompt) to see its full activity log, timed from the start:
  - While the task runs, a small box that keeps to the newest step. It fetches only the new steps every 2 seconds; scrolled up to read, it stays put and offers "N new steps ↓".
  - Once the task is done, the log folds into one line under the answer, with the counts and the run time.

### Changed

- **Cursor runs with `--output-format stream-json`** instead of `json`, so nuncius sees its steps, and a run that times out keeps them in `runs/<id>.out`.
- **A running task's progress lives in `runs/<id>.progress.json`**, written by its worker at most once a second without taking the queue lock. When the task ends, the last progress moves into the task record and the file is removed.

### Fixed

- Pasting a new dashboard link (with a new token, after a restart) into a tab that was already open kept the old token, and every request failed with 401. The page now picks up the new token.

## [0.1.0] - 2026-10-26

First public version: an MCP server and CLI that hand coding tasks to Codex, Cursor and Claude on your own subscriptions, each task sandboxed in its own git worktree, with usage logging, budgets and a dashboard.

[Unreleased]: https://github.com/sdirkse/nuncius/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sdirkse/nuncius/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sdirkse/nuncius/releases/tag/v0.1.0
