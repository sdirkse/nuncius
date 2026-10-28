# Changelog

## Unreleased: task progress

Long tasks (Cursor runs of 15 to 30 minutes) looked the same as stuck ones: callers only got "Still running", the dashboard showed a ticking timer and nothing else, and a Cursor run that timed out left an empty output file. You can now see what a running task is doing, while it runs and afterwards.

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

These came up while building the feature, from testing on the dashboard and from a code and security review of the branch.

- A run that broke off with a nuncius error after it had started got no end marker in its log, no run time and no final progress.
- A failed Cursor run that printed an error object but no result reported only "exit code 1" instead of its reason.
- Reading a tool's output: a line over 8 MB was cut off, but the rest of it was then handed on as if it were a line of its own; a last line without a newline after it was never read; and each new piece of output searched the whole unfinished line again, which was slow for long lines.
- Activity labels could still carry invisible characters (zero-width spaces, text direction marks), so a command could look different from what ran. These are now removed, like other control characters.
- Saving progress took the shared queue lock every second for each running task, competing with the queue and the reaper.
- The 2-second live refresh read and parsed every stored task file. It now reads only queued and running tasks: a finished task never runs again, so it is remembered by id.
- The task window fetched the whole task (prompt and answer included) every 2 seconds, and the server reread the whole activity log each time. It now asks `/api/task/activity` for what was added since the last poll, by position in the file; a line still being written waits for the next poll.
- The activity summary showed whole seconds with a fake decimal ("40.0 s") and could differ from the Duration above it. Both now show the exact run time.
- The final count of edited files missed files a tool wrote with a shell command (Claude often does, e.g. `cat >> calc.py <<EOF`): a run that changed 4 files ended with "0 files edited". When a task is done, the count now comes from the files its commit changed.
- "Read finished" and "Shell finished: …" replaced the label of the step they ended, and steps were counted twice.
- Pasting a new dashboard link (with a new token, after a restart) into a tab that was already open kept the old token, and every request failed with 401. The page now picks up the new token.
- The tool names (Codex, Cursor, Claude) were defined in four places; there is now one.
