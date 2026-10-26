# 8. Recursion guard

Status: accepted · 2026-10-17

## Decision
Nuncius sets `NUNCIUS_DEPTH=1` in every target's environment. A Nuncius call that already has a depth of 1 or more is refused. Without this guard, Claude → Nuncius → Claude → Nuncius chains can burn through subscriptions.

## Note
Claude Code's own `CLAUDE_CODE_CHILD_SESSION` cannot be used for this, because it is also set for every legitimate `nuncius` call that Claude makes from Bash.

## Hardening and residual risk (2026-10-17)
- `NUNCIUS_DEPTH` is deny-by-default: any value other than empty or `0` counts as nested.
- A submission is also refused when a running Nuncius worker is among its ancestor processes. The check uses `/bin/ps` and fails closed: if the process tree cannot be read while Nuncius tasks are running, the call is refused.
- **Residual risk:** a target that detaches itself on purpose (with `setsid` or a double fork, so it is reparented to launchd) and also unsets the variable is not caught by these checks. We accept that for now. The structural fix is the per-target sandbox from ADR 5, where targets can write only inside their worktree. A nested `nuncius` call then cannot create task files in `~/.nuncius`, and submitting a task fails.

## Red-team fixes (2026-10-17)
The env var and the earlier process check could both be defeated from inside a task. A target could unset `NUNCIUS_DEPTH` and point `NUNCIUS_HOME` at an empty dir, so no running worker was found and the ancestry walk was skipped. Nesting is now detected from things a sandboxed child cannot change:
1. **Canary:** Nuncius creates `~/.nuncius-canary`, located through `getpwuid` rather than `$HOME`. Every task profile denies reading it. If it exists but cannot be read, the caller is inside a Nuncius sandbox. Sandboxing is inherited, so this still works after `setsid` or a double fork.
2. **Process tree:** one `/bin/ps -A -ww` snapshot is taken, and the walk always runs. An ancestor that is node running `nuncius.js __worker|codex|cursor|claude` counts as nesting. The pattern is anchored at the start of the command line, so a shell whose `-c` string merely mentions Nuncius does not count. `sandbox-exec` itself never appears among the ancestors, because it execs into the target CLI. The worker that started it does appear.
Both checks fail closed.

**Residual risk:** a target can still run its own copy of a CLI directly, for example `claude -p` from inside a Claude task, as far as the proxy allowlist allows. That is not a Nuncius chain and stays within the same vendor's API. It does fall outside Nuncius's usage tracking.
