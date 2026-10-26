# 7. Aliases and model discovery

Status: accepted · 2026-10-17

## Decision
- The caller picks a target and a model, or names an alias. The default aliases are `fast`, `strong` and `review`. `review` always resolves to a target other than the caller's own tool.
- The available models are discovered (Cursor `agent models`, Codex app-server `model/list`, the Claude CLI aliases) and cached for about 1 hour. The config holds the capabilities that cannot be discovered, the aliases, and the blocked models.
- `list_targets` returns the models, the capabilities and the current budget status, so the caller can choose sensibly.
- Fully automatic routing is postponed until there is usage data to base it on.

## Since 2026-10-19
- **No default aliases.** Which tools someone has, and which models they want to spend their plan on, differs per person, so aliases are opt-in and documented with examples. `"target": "other"` still means any available tool other than the caller's own.
- **Only available targets are offered.** A target is available when its CLI is found (on `PATH` or at the configured path) and `targets.<tool>.enabled` is not `false`. `list_targets`, the MCP instructions, `nuncius status` and the dashboard show only those; a task for an unavailable target is refused before anything is queued.
- **Codex models are discovered** through `codex app-server` (`initialize`, then `model/list`), the CLI's default first. It starts no task and uses no tokens. Claude's model names (`opus`, `sonnet`, `fable`, `haiku`) stay in the config; the CLI resolves each to the latest model of that line.
