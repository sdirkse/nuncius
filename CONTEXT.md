# Nuncius — context

Nuncius lets one AI coding agent hand work to another AI tool that runs on a different subscription. Claude Code can use Codex or Cursor, Cursor can use Codex or Claude, and so on. Every task is isolated, sandboxed, logged and checked against a budget.

## Glossary

| Term | Meaning |
|---|---|
| **Caller** | The agent that asks for work: Claude Code or Cursor, through MCP or the `nuncius` CLI. A human using the CLI is also a caller. |
| **Target** | The tool that does the work, on the user's own subscription: `codex`, `cursor` or `claude`. One process per **Runner**. |
| **Runner** | The adapter for one target. It builds the CLI invocation, applies the sandbox and parses the output into **Usage**. |
| **Task** | One unit of delegated work: a prompt, a target, a model and options. It has an id, a state (`queued`, `running`, `done`, `failed`, `timeout`, `refused`), a **Worktree** and a result. |
| **Worktree** | A git worktree created per task on the branch `nuncius/<target>/<task id>`. It starts from the caller's HEAD plus the caller's uncommitted changes. The target only works there. |
| **Result** | What the caller gets back: the target's final message, the branch name, the diff stat, usage, and the latest limits. The caller decides whether to merge. |
| **Alias** | A configured name such as `fast`, `strong` or `review` that resolves to a target and a model. `review` never resolves to the caller's own tool. |
| **Model discovery** | Asking each target which models the account can use (`agent models`, Codex `model/list`, the Claude aliases). Results are cached. |
| **Usage** | The measured consumption of a task: tokens for every target, plus duration for Cursor (which has no readable subscription window). |
| **Limits** | The subscription window status (percent used and reset time). For Codex it is read from its session files or the app-server. For Claude it comes from a statusline script that writes `~/.nuncius/claude-limits.json`. Cursor has none. |
| **Budget** | The configured thresholds. A task that would exceed one is **refused** with a reason, never silently run. |
| **Depth** | The nesting level of Nuncius calls, carried in `NUNCIUS_DEPTH`. Tasks at depth ≥ 1 may not use Nuncius again. |

## Shape

```
Claude Code ─┐  MCP (stdio) or CLI        ┌─► codex exec   ┐
Cursor ──────┼─► nuncius core ──worktree──┼─► cursor-agent ├─ nuncius's Seatbelt sandbox + egress proxy
nuncius CLI ─┘   budgets · queue · log    └─► claude -p    ┘
                        │
                        ▼
              ~/.nuncius/  (usage.jsonl, tasks/, config.json, claude-limits.json)
                        │
                        ▼
                 nuncius dashboard (127.0.0.1)
```

Decisions behind this shape are in [docs/adr](docs/adr/).
