# 6. Usage, limits and budgets

Status: accepted · 2026-10-17

## Decision
- Every task, including failed and refused ones, is appended to `usage.jsonl` with its project, caller agent, target, model, usage and the latest limits.
- Codex: tokens come from `turn.completed`. Limits (5-hour and weekly) come from the session files in `$CODEX_HOME/sessions` or the app-server's `account/rateLimits/read`.
- Claude: tokens come from `usage` and `modelUsage` in the `-p` JSON output (`total_cost_usd` is stored as an API-equivalent estimate only). Limits come from a statusline wrapper that writes `rate_limits` to `~/.nuncius/claude-limits.json` during interactive sessions and keeps any existing statusline working. Without that file, Claude falls back to its own daily caps.
- Cursor: its CLI reports no tokens, so it tracks runs and agent minutes against its own caps. The user compares these with the Cursor dashboard and may later add a cost-per-minute estimate.
- Budgets are checked before a task starts. If one is exceeded, the task is refused with the reason, and the MCP error suggests targets that are still within budget.

## Project identity (2026-10-17)
MCP callers cannot name the project themselves. It is always derived from `cwd`, using the git root name. A caller that points `cwd` at another repository is charged to that repository's budget. That is by design: the work then really happens there. Per-project budgets are bookkeeping, not a security boundary. The protection that cannot be bypassed is the global per-target budget: subscription windows and daily caps, which apply no matter which project is used. Two repositories with the same folder name share one project budget. This is a known limitation; it errs on the strict side (a shared cap), never the loose one.

Since 2026-10-21 the name is the repository's, not the checkout's: it comes from the git common dir, so a second checkout made with `git worktree add` (whatever its folder is called) is the same project. Before, pointing `cwd` at such a checkout gave a fresh project budget.

## Claude (2026-10-17)
Claude tokens come from `modelUsage` in the `-p` output, summed over all models including subagents. `total_cost_usd` is stored as `apiCostEstimateUsd` only. Limits come from the statusline bridge (`nuncius install-statusline`). Windows that have already reset do not block. Without recorded limits, Claude falls back to `maxRunsPerDay` and `maxTokensPerDay`.

## Codex limits are not trusted from tasks (2026-10-17)
A task used to be able to write `~/.codex/sessions`, and Nuncius then read the subscription limits from there, so a target could forge its own limits. Now:
- Codex gets a throw-away per-task `CODEX_HOME`, which only links to the user's `auth.json` (read-only through the sandbox). `config.toml` is not linked, because it can declare MCP servers. The real `~/.codex` cannot be written at all. If Codex refreshes its login during a task, that copy is discarded and the task result carries a warning.
- What a task reports is kept as `task-reported`. The effective limit is, per window, the **highest** of the user's own Codex sessions (written outside any sandbox) and the latest task report. A forged low number can therefore never hide real usage. A forged high number only makes Nuncius more cautious.
- Claude limits come from the statusline bridge, which writes to `~/.nuncius`. Targets cannot write there.

## Codex limits come from Codex; budgets count tasks in flight (2026-10-21)
A multi-model red-team review found three ways past the bookkeeping above:
- **Forged limits lock a tool out.** A task's rollout files are written inside the sandbox, so a target could claim 100% of both windows and block Codex for up to a week (the cap on task reports bounded it, but a week is a long time). Nuncius no longer reads limits from anything a task wrote. It asks Codex itself: `account/rateLimits/read` on `codex app-server`, which Nuncius runs outside the sandbox before a task starts (cached for a minute in `~/.nuncius/codex-limits.json`, which tasks cannot read or write) and again after a Codex task ends. The user's own session files still count; per window the higher of the two wins.
- **Simultaneous submits pass a cap together.** The budget was checked before the task was written, and only finished runs counted. Now the deciding check runs under the queue lock, in the same step that writes the task, and queued and running tasks count as runs (a running one also adds its minutes so far). Twelve MCP servers submitting at once with a cap of 1 now get one task.
- **A dead worker means no record.** A target could kill its worker, so its run was never recorded and its timeout never fired. The sandbox now denies signals to any process outside it. If a worker dies anyway, the reaper (which every submit now runs) writes the usage record for the time the task ran and stops the target's process group, after checking with `ps` that the pid still runs the target's binary.

Token counts are clamped by the run's own duration on Nuncius's clock (5 million a minute, at least 1 million per run; real heavy runs use well under a million a minute), so one implausible number cannot lock a tool out for the rest of the day. Only the CLI itself writes these counts (the model it runs cannot), so this guards against a broken or replaced binary. The queue holds at most `concurrency.maxQueued` (default 20) waiting tasks, a prompt at most 1 MB, and one MCP request line at most 8 MB.
