# 11. Global settings, changed through the CLI

Status: accepted · 2026-10-20

## Decision
- **One global settings file**, `~/.nuncius/config.json`, holding only what the user changed; Nuncius creates it empty. There are no settings files in projects: a repository (and a target writing in its worktree) must not be able to change budgets, the sandbox or which tools run. Budgets per project exist, but live in the same global file under `budgets.projects.<project>`.
- **`nuncius config`** lists, reads and changes settings by their dotted name (`budgets.cursor.maxRunsPerDay`), which is the same name in the file and the README. Values are validated per setting; unknown names get suggestions.
- **`nuncius setup`** is the first-time walk-through: tools, budgets, MCP connections, Claude extras. Each answer prints the equivalent command.
- **Agents read, people write.** `nuncius config set|unset|add|remove`, `nuncius setup` and `nuncius uninstall-hook` are refused when Nuncius runs under an agent CLI, and the hook blocks them, like `--force`. The calling agent runs as the user, so this is a guardrail, not a boundary (see ADR 5).
- **Names:** `max5HourPercent` / `maxWeeklyPercent` (not primary/secondary), project caps in the same shape as the global ones, and everything about a tool under `targets.<tool>` (incl. `bin`). Old names in existing files are still read and are rewritten on the next change.

## Config is validated on load; the dashboard and handshake tolerate a bad one (2026-10-21)
A multi-model red-team review found that a hand-edited `config.json` could silently weaken Nuncius:
- A value of the wrong kind (`"maxRunsPerDay": "1"`, or `"budgets": "none"`) passed `loadConfig` untouched, and `capOf` then read it as "no cap" — the budget was silently off. `loadConfig` now validates the user's file against the same schema `nuncius config` uses and throws with the exact problem, so a wrong kind fails closed (the task is refused). It checks the *kind* and range of the keys Nuncius knows, not integer-ness (a fractional value is still honoured) and not unknown keys (which may be internal or from a newer release). `getSetting` no longer reads the merged config for unchanged keys, so `nuncius config` still works to fix a broken file.
- A non-object top-level (`[1,2]`) was merged in as the whole config. It is now refused.
- A broken `config.json` made the MCP `initialize` throw, so the client received no tools. `initialize` now falls back to the default instructions; the tool calls still report the config error, so the user sees it without losing the tools.
- The dashboard crashed on a malformed request URL and on a corrupt log line or task file. The URL is parsed in a `try`/`catch` (400 on failure), each request is wrapped (500 on failure, the server lives on), `readUsage` keeps only object records, and the live-task and sort paths no longer assume a string. The Host-header check is case-insensitive (RFC 9110), and the dashboard uses `hasOwnProperty` for tool lookups so a record with `tool: "constructor"` cannot reach `Object.prototype`.
- A long-lived `nuncius mcp` server keeps the code it started with. `usage` now reports the running version and, when the version on disk is newer, a hint to restart the server; the README says upgrades need an MCP restart.
