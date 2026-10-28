# Nuncius

Let AI coding agents hand work to each other across your own subscriptions. Claude Code can use Codex or Cursor, and Cursor can use Codex or Claude. Each task runs in its own git worktree and sandbox, with usage logged per project and agent, budgets enforced, and a local dashboard.

Not affiliated with Anthropic, OpenAI or Anysphere.

## The name

*Nuncius* (say *NUN-see-us*) is Latin for **messenger**: the envoy who carries a message from one party to another and comes back with the answer. That is what this tool does. One agent hands it a task, Nuncius carries it to another AI tool, keeps an eye on it on the way (its own worktree, a sandbox, a budget), and brings the result back for review. The best-known use of the word is Galileo's *Sidereus Nuncius*, the "Starry Messenger" of 1610.

The command, the package, the MCP server and the data folder are all called `nuncius` (`nuncius codex "..."`, `~/.nuncius`). The project is not related to other products, journals or trademarks named Nuncius or Nuntius.

> **Status: early.** Working today for Codex, Cursor and Claude: the `nuncius` CLI and MCP server, a task queue with concurrency limits and timeouts, a git worktree and sandbox for every task, usage logging, budgets, and the dashboard. macOS only, because the sandbox uses `sandbox-exec`. The rest of the design is being built in phases. See [Roadmap](#roadmap).

> **Security:** what Nuncius protects and what it does not (including the known residual risks) is in the [threat model](docs/THREAT_MODEL.md). Run `nuncius doctor` to prove the sandbox on your machine, and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Quick start

**Requirements:** macOS (the sandbox uses `sandbox-exec`), Node 20 or later, git 2.41 or later (Nuncius refuses to run tasks on older git: see [ADR 4](docs/adr/0004-worktree-per-task.md)), and at least one target CLI installed and logged in with your own subscription:

| Target | CLI | Log in once |
|---|---|---|
| Codex | `codex` | `codex login` |
| Cursor | `cursor-agent` | `cursor-agent login` |
| Claude | `claude` | run `claude` and `/login` |

```bash
git clone https://github.com/sdirkse/nuncius.git && cd nuncius
npm link        # puts `nuncius` on PATH
nuncius setup   # a few questions, in your own terminal
nuncius doctor  # proves the sandbox works on this machine
```

`nuncius setup` finds which of the three tools you have and asks:
1. **Your tools:** which of them Nuncius may use.
2. **Budgets:** per tool, how much Nuncius may use: the 5-hour and the weekly subscription window as two separate questions, tasks per day, and Cursor's run time. Each question shows what you can enter, for example `none` for no limit.
3. **Connections:** connecting Nuncius to Claude Code, Codex and Cursor, so they can call it (MCP).
4. **Claude Code extras:** the statusline bridge for Claude's limits, the delegation skill, and the optional hook.

Every answer prints the command that does the same, so you know how to change it later (see [Configuration](#configuration)). Run it again at any time; it skips what's already done. To do the same steps by hand:

```bash
claude mcp add --scope user nuncius -- nuncius mcp    # Claude Code can call nuncius
codex mcp add nuncius -- nuncius mcp                  # Codex can call nuncius
nuncius install-statusline                            # record Claude's 5-hour and weekly limits
ln -s "$PWD/skills/nuncius" ~/.claude/skills/nuncius  # the delegation skill for Claude Code
nuncius install-hook                                  # optional: when Claude starts Codex, Cursor or `claude -p` itself, it uses nuncius
```

For Cursor, add `"nuncius": { "command": "nuncius", "args": ["mcp"] }` under `mcpServers` in `~/.cursor/mcp.json`.

`nuncius doctor` runs real probes under each target's sandbox profile and reports what it proved. A target must not be able to:
- write outside its worktree (your home folder, the shared `/tmp`);
- read files in your home folder (only the task's own files, its repository's git data and toolchains are readable), Nuncius's own data or the recursion-guard canary;
- connect anywhere directly, accept inbound connections, or signal your other processes.

Each check has a control: a "denied" only counts when the same probe can write inside its worktree, and the network check only counts when the connection works outside the sandbox. It starts no target CLI except to ask its `--version`: Nuncius relies on some undocumented CLI behaviour, so it warns (never refuses) when a CLI is newer or older than the versions Nuncius was verified with. After that check, or the MCP `list_targets` call, each task run of that CLI repeats the warning. Run it after installing, after a macOS update, and after changing `sandbox.*` settings; it exits non-zero when a check fails.

Try it from any git repository with at least one commit:

```bash
nuncius codex "Add a unit test for the slugify function in src/text.js"
```

The answer is printed, the work lands on a `nuncius/codex/<id>` branch, and the last lines show how to review and apply it. Nothing is merged for you. In Claude Code, ask for it in plain words: *"Have Codex write the tests for src/text.js and review what it did."*

## Teach your agents

Nuncius is something Claude *can* use, not a route all its work takes. Claude's own model calls, edits, commands and subagents never pass through Nuncius. Claude decides itself whether a task is worth delegating and to which target: it sees in `list_targets` which of your tools are installed and within budget, and picks one (or an alias you configured).

What you can give Claude, from always-on to opt-in:

1. **MCP instructions (automatic).** Every MCP client that connects (Claude Code, Cursor) receives the delegation workflow on `initialize`: pick a target with `list_targets`, write a self-contained brief, wait for the result, review the diff, treat the target's output as untrusted, ask the user before applying `sensitiveFiles`, and report refusals instead of retrying. Nothing to install.
2. **The skill (Claude Code).** [`skills/nuncius/SKILL.md`](skills/nuncius/SKILL.md) is the full guide: when to delegate, what a good brief contains, how to review and apply, what to do when a task is refused or fails, and the CLI path when MCP is not connected. Install it with the `ln -s` line above, and Claude uses it on its own when you ask it to hand work to Codex, Cursor or another model.
3. **A project rule (`CLAUDE.md` / `AGENTS.md`).** To make it the house rule for a project or team, add:

   ```markdown
   ## Delegating to other AI tools
   Hand self-contained coding tasks to Codex, Cursor or another Claude through nuncius
   (MCP tools `list_targets`, `run_task`, `wait_task`; or the `nuncius` CLI). Run them only through
   nuncius, so usage is logged and budgets apply. Review the diff before applying it, and ask me
   before applying anything listed in `sensitiveFiles`. When a task is refused, tell me why.
   ```

**Optional safety net (Claude Code):** `nuncius install-hook` covers one case: Claude starting another agent CLI itself in Bash (`codex exec`, `cursor-agent -p` / `agent -p`, `claude -p`). The hook then tells Claude to use Nuncius instead, so that run is logged, budgeted and sandboxed too. It also refuses `nuncius ... --force` and the commands that change Nuncius's settings (`nuncius config set`, `nuncius setup`, …), so budgets stay your call. Everything else Claude runs in Bash (tests, git, builds) and housekeeping like `codex login` or `--version` pass as normal, and Claude's own work is not affected. Without the hook, Claude can still start those CLIs directly, only unlogged and unsandboxed.

The hook goes in `~/.claude/settings.json` next to your other hooks; `nuncius uninstall-hook` removes only this one. It looks at what a command runs, not at text that merely mentions it: searching the docs, a commit message, or writing a file with `cat > file <<EOF` or `tee file <<EOF` as a command on its own pass. It recognises the common ways of running them (chained with `&&` or `;`, inside `bash -c`, `$(…)`, backticks, a heredoc fed to a shell or piped on, and wrappers like `sudo`, `env` or `script`). Code an interpreter runs (`node -e`, `python3 -c`, `python3 - <<EOF`, a Nuncius script after `node` flags) is checked word by word, because it can start Nuncius in ways no text check can follow. It doesn't catch every possible form, so it is a guardrail rather than a security boundary (see [Limitations](#limitations)). Nuncius itself also refuses these commands from an agent, whatever the hook saw.

## Design in short

- **Callers**: Claude Code and Cursor, through an MCP server, or anyone through the `nuncius` CLI.
- **Targets**: `codex`, `cursor` and `claude`, each driven through its official CLI, so work runs on your subscription.
- **Isolation**: every task gets a git worktree on `nuncius/<target>/<id>`. The caller reviews the result and merges it.
- **Safety**: targets run sandboxed and can write only inside the worktree. Network is limited to the target's own API host through a per-task proxy, plus package registries when a task asks for it. There is no DNS and no full-access mode.
- **Budgets**: subscription windows are tracked for Codex and Claude, and runs, minutes and tokens for Cursor. A task that would exceed a budget is refused, with the reason.
- **Discovery**: Nuncius finds which of the three CLIs you have and offers only those; `list_targets` shows their models (asked from the CLIs), capabilities, budget status and any aliases you configured.

Terms are defined in [CONTEXT.md](CONTEXT.md), and the decisions are recorded in [docs/adr](docs/adr/).

## Roadmap

1. ~~MCP server (`list_targets`, `run_task`, `get_task`, `wait_task`, `usage`) with hybrid sync/async tasks and a queue.~~ Done.
2. ~~A worktree per task and a sandbox per target.~~ Done.
3. ~~Claude as a target, plus the statusline bridge for Claude limits.~~ Done.
4. ~~Dashboard: a Claude column, running and queued tasks, open worktrees.~~ Done.
5. Phase 2: `generate_image`.

## Use from Claude Code or Cursor (MCP)

```bash
npm link                                        # puts `nuncius` on PATH
claude mcp add --scope user nuncius -- nuncius mcp
```

For Cursor, add this to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "nuncius": { "command": "nuncius", "args": ["mcp"] } } }
```

Tools:

| Tool | What it does |
|---|---|
| `list_targets` | The targets installed and enabled here, with their models (Cursor through `cursor-agent models`, Codex through its app-server `model/list`, Claude's model names from the config), capabilities, budget status, limits, queue and your aliases. Missing targets are listed under `unavailable` with the reason. |
| `run_task` | `target` (an available target, or an alias you configured), `prompt`, and optionally `model`, `cwd`, `agent`, `network` (package registries and GitHub, default off), `wait_seconds`. The project (which budgets are keyed on) is always derived from `cwd`. Returns the result if the task finishes within `wait_seconds` (default 300), otherwise the task id with state `running` or `queued`. |
| `get_task` | The current state and result, without waiting. |
| `wait_task` | Waits up to `timeout_seconds` (max 600) and returns the state and result. |
| `usage` | Today's usage, usage per project, Codex and Claude limits (or why Claude's are missing), budgets and the queue. |

Progress: while a task runs, `get_task` and `wait_task` return a `progress` field read from the target's own event stream (Claude's and Cursor's `stream-json`, Codex's `--json`): elapsed time and the timeout, how long ago the target last did anything and what (`lastActivity`), and counts of steps, edited files and commands. After 5 minutes without any event, `quiet` is true: the task may be stuck, or the model may be thinking for a long time. Nuncius only reports this; it stops a task only at the timeout. The activity text comes from the target, so it is cleaned and shortened, and kept out of the `next` hint. The progress stays on the task after it ends, and a task that times out keeps its event stream in `~/.nuncius/runs/<id>.out`.

Tasks run in detached worker processes that keep their state in `~/.nuncius/tasks/`, so they survive an MCP server restart. They queue FIFO under `concurrency.perTarget` (default 2) and `concurrency.total` (default 4), at most `concurrency.maxQueued` (default 20) wait, and they are killed after `tasks.timeoutSeconds` (default 1800). A prompt can be at most 1 MB. Queued and running tasks already count against the daily run caps, so tasks submitted at the same moment (even from several MCP servers) cannot pass a cap together. A target cannot signal any process outside its sandbox, so it cannot kill the worker that enforces its timeout and records its usage; if a worker dies anyway, the next submit records the run and stops the target it left behind. A target always runs with `NUNCIUS_DEPTH=1`. A Nuncius call is refused when that variable is set to anything other than `0`, or when a running Nuncius worker is among its parent processes, so a target cannot escape the guard by unsetting the variable. Nuncius chains cannot loop.

## Isolation: worktree and sandbox

Every task gets its own git worktree under `~/.nuncius-worktrees/`, next to the data dir rather than inside it, on the branch `nuncius/<target>/<id>`:

- **Base:** the caller's `HEAD`, plus one snapshot commit of the caller's uncommitted changes and untracked files that are not ignored. The target sees what the caller sees. Ignored files such as `node_modules` and `.env` are not copied.
- **Result:** when the target finishes, Nuncius commits its work on the task branch and returns the changed files, the diff stat, a patch file, and `review` / `apply` / `applyPatch` commands. **Nothing is merged for you.** The `apply` command (a `git cherry-pick`) runs with hooks off and reads `.gitattributes` from your current HEAD, so a hook or filter the target added cannot run code in your repo when you apply; `applyPatch` is a plain `git apply` of the patch (no commit, no hooks). Files that configure tools or run on their own (CI pipelines, git hooks, `.gitattributes`, `package.json`, `setup.py`, …) are listed in `sensitiveFiles` to review first. If the task made no changes, the worktree and branch are removed right away. Failed or timed-out tasks keep their worktree for inspection.
- **Cleanup:** worktrees whose commit is already in the repo's current branch (merged or cherry-picked) are removed automatically, together with their branch, whenever a task starts or the dashboard refreshes (set `worktrees.autoRemoveApplied` to `false` to turn this off). Work merged elsewhere, for example in a pull request you haven't pulled yet, counts once it's in your current branch. `nuncius cleanup` does the same on demand and also removes worktrees older than `worktrees.keepDays` (7). For those it keeps the branch, so no work is lost. Before any worktree is removed, anything uncommitted in it is first committed on its branch (marked as not reviewed): work a failed task never committed, and edits you made in the worktree after the task finished. Ignored files (`.env`, `node_modules`) are not preserved, the same way they are never copied in.
- Directories that are not git repositories, and repos without commits, are refused.

Every target runs inside a macOS Seatbelt profile (`sandbox-exec`). If no sandbox is available, the task does not run; there is no unsandboxed fallback.

| | Allowed | Denied |
|---|---|---|
| Write | the task worktree and the task's own per-task scratch dirs (cache, `TMPDIR`, the throw-away Codex or Cursor home) | everything else, including the shared system temp (`/private/tmp`, the per-user `/var/folders` temp), the caller's checkout, and the CLIs' real state dirs (`~/.codex`, `~/.cursor`, `~/.claude`) with their config, hooks, rules and MCP files |
| Read | everything outside your home folder, and in it only: the task's worktree and scratch dirs, the repository's shared `.git` (not its working files), the CLI's own install and login, the macOS keychain folder, every `PATH` folder inside your home, the usual toolchain homes and package caches (`~/.rustup`, `~/.cargo`, `~/.nvm`, `~/.pyenv`, `~/.m2/repository`, `~/.npm/_cacache`, pnpm, …), and `sandbox.extraReadable` | the rest of your home folder, including listing it: other repositories, your repository's working files (an ignored `.env` too), shell config, `~/.cache`, app data. On top of that, and also inside the readable folders: `~/.nuncius`; credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.cargo/credentials.toml`, `~/.m2/settings.xml`, …); shell history; `~/.gitconfig`; browser cookies and session storage; plus `sandbox.extraDenyRead`. Inside a task, git runs without your global git config |

**Network** goes only through a per-task egress proxy on loopback, which Nuncius starts for each task. The sandbox blocks every other outbound connection, and also DNS, so hostnames cannot be used to smuggle data out. A target also cannot listen on an IP socket: a listener would accept connections from outside the sandbox (on `0.0.0.0`, from the LAN) and bypass the proxy. Unix sockets for local IPC are unaffected. The proxy only tunnels TLS on ports 443 and 80, never to raw IP addresses, and only to:
- the target's own API hosts (`targets.<name>.apiDomains`), verified with the real CLIs: Claude `api.anthropic.com`, Codex `chatgpt.com` / `ab.chatgpt.com`, Cursor `*.cursor.sh`;
- plus `network.domains` (npm, PyPI, GitHub, crates, Go proxy) when a task sets `network: true` (MCP) or `--network` (CLI).

Hosts a task tried to reach but was refused are returned as `blockedHosts`.

Changes to files that configure tools or run code once applied are flagged as `sensitiveFiles` with a warning. These include agent settings (`.claude/`, `CLAUDE.md`, `.cursor/`), CI workflows, git hooks and attributes, and `package.json`.

**Environment:** a target does not get Nuncius's own environment. It gets what a shell and the CLIs need (`PATH`, `HOME`, locale, CA certificates), its own vendor variables (`CODEX_*`/`OPENAI_*`, `CURSOR_*`, `CLAUDE_*`/`ANTHROPIC_*`), and anything listed in `sandbox.passEnv` (names, or prefixes ending in `*`). Tokens such as `GITHUB_TOKEN` or `AWS_*` stay out. Each task gets its own `TMPDIR`. When a target exits, times out or Nuncius is stopped, every process it started in its process group is ended too.

**Nested Nuncius calls** from inside a task are refused (ADR 8). Nuncius checks a canary file, `~/.nuncius-canary`, that every task sandbox hides, and it also checks the process tree. So a target cannot get around this by changing environment variables or by detaching itself.

**Known residual risk:** commands a target runs can also reach that target's API host. With an attacker's own API key, a prompt-injected target could send data it can read to that attacker's account. See ADR 5.

macOS refuses to apply a sandbox inside a sandbox, so the CLIs' own sandboxes are switched off and Nuncius's sandbox covers them. Per target:
- **Codex:** `--sandbox danger-full-access`, set only by Nuncius and only inside Nuncius's sandbox. Callers cannot pass it. Codex gets a throw-away `CODEX_HOME` per task that links only to your `auth.json`. Your `config.toml` is left out, because it can declare MCP servers. Your real `~/.codex` cannot be written, and the limits a task reports can only make budgets stricter.
- **Cursor:** `--force`, set by Nuncius, so edits are applied in the worktree. Cursor gets a throw-away `HOME` per task. It holds a copy of your CLI settings and a link to the macOS keychain folder, so your login still works. Your plugins, MCP servers (for example Atlassian), hooks and rules are not loaded, and your real `~/.cursor` is never written.
- **Claude:** headless with `--permission-mode dontAsk` (only Read, Edit, Write, Glob, Grep, Bash and Agent are allowed), project settings only (no user hooks or permission rules), `--strict-mcp-config` (no MCP servers, so not Nuncius itself), no WebFetch/WebSearch, and `--no-session-persistence`. Callers can only add `--model` and `--max-turns`.

Every prompt gets a short preamble that tells the target it is in a worktree, must not commit or push, what its network status is, and that it should end with a summary.

### Task accounts (optional, Codex and Claude)

A second wall next to the sandbox: Codex and Claude tasks run as one of four hidden, powerless macOS accounts instead of as you ([ADR 12](docs/adr/0012-separate-task-accounts.md)). A task account cannot read your private files (SSH keys, the Codex login, `Documents`, `Desktop`, `Downloads`, `Library`, Nuncius's data), write to your terminals or signal your processes; at the end, everything it started is stopped, however it detached; and a firewall rule keeps it to Nuncius's proxy. Your world-readable files (repositories, dotfiles) stay protected by the sandbox allowlist, as without accounts.

```bash
sudo ./scripts/task-accounts/setup.sh                                   # once: accounts, a sudo rule (only down to these accounts), home pass-through, firewall
claude setup-token                                                      # Claude needs a long-lived token as a task account
security add-generic-password -U -a "$USER" -s nuncius-claude-token -w  # paste it as one piece (in macOS Terminal)
nuncius config set sandbox.taskAccounts true
nuncius doctor                               # proves the account wall
```

`./scripts/task-accounts/prove.sh` checks each claim on its own; `sudo ./scripts/task-accounts/undo.sh` removes everything again. When the mode is on and the accounts are not ready, Codex and Claude tasks are refused, never run as you instead. Cursor keeps running as you inside the sandbox: its tool helper does not work in another account yet.

## Dashboard

```bash
nuncius dashboard        # http://localhost:7317 (loopback only); another port: --port 8080, or nuncius config set dashboard.port 8080
```

Open the full URL it prints: it ends in `#t=<token>`, a random token for this run that the data API requires, so other accounts on the same Mac cannot read your prompts and output through it.

It refreshes every 15 seconds and filters by period (7, 30 or 90 days) and by project. It shows:
- **Subscription limits:** Codex and Claude, 5-hour and weekly. The meter shows where Nuncius starts refusing tasks. If Claude's limits have not been recorded yet, it points to `nuncius install-statusline`. Cursor exposes no subscription usage, so its tile shows Nuncius's own daily caps for Cursor (runs, tokens, agent minutes) and how close today is to the nearest one.
- **Today:** tokens and runs per tool, against the daily token caps when set.
- **Now:** running and queued tasks, with tool, project, agent, a live duration against the timeout, and the last activity: how long ago, and the step on one line (the full text and the counts of steps, edited files and commands are in its tooltip), marked when a task has been quiet for 5 minutes. The table keeps its shape while tasks work. This section refreshes every 2 seconds; the rest of the page every 15, and at once when a task starts or finishes.
- **Activity log:** click a task's last activity (or its prompt) to open the task with its latest 50 steps, newest first, timed from the task's start. While the task runs, new steps come in every 2 seconds; when you have scrolled down to read, the list stays put and offers the new steps instead. A finished or timed-out task keeps its log until `retention.days` removes the task's content.
- **Tokens per day**, Codex, Claude and Cursor stacked.
- **Tokens per project**, per tool, with the number of failed tasks and the last task; the most recently active project first.
- **Token split:** input (of which cached) and output tokens per tool for the period.
- **Open worktrees:** newest first, filterable by state (ready to review, sensitive files, running, failed) and tool, 25 per page. Each shows its status, a warning for files that configure tools or run code, the number of changed files, and a button that copies the review command.
- **Tasks:** every task in the period, newest start first, in pages of 10 to 100. Filter by tool and outcome (succeeded, failed, refused) and search the prompt, agent, model or task id; the filters run on Nuncius's side, so counts and pages are exact. Your page and filters survive the 15-second refresh. Click a task to see its full prompt, the target's answer, the model it used, the token split, blocked hosts and its worktree.

## Claude limits (statusline bridge)

Claude Code shows your 5-hour and weekly usage only to interactive sessions, through the statusline input. Run this once:

```bash
nuncius install-statusline
```

From then on `nuncius statusline` records those limits in `~/.nuncius/claude-limits.json` and passes the input on to your previous statusline, so that keeps working. Your previous setting is saved, and `settings.json` is backed up as `settings.json.nuncius-backup`. Undo it with `nuncius uninstall-statusline`. No new Claude task starts once `budgets.claude.max5HourPercent` (90%) or `maxWeeklyPercent` (80%) is reached. Without recorded limits, the daily caps `budgets.claude.maxRunsPerDay` and `maxTokensPerDay` apply instead.

When limits stay missing, `nuncius status` and the dashboard say why:
- **Not run yet:** Claude Code's documentation only describes the statusline for the interactive terminal CLI (`claude`). The desktop app and the IDE extensions may never run it. Open `claude` in a terminal and send one message.
- **Ran, but no limits:** Claude Code only sends them for Pro and Max subscriptions (not API keys), after the first reply in a session.

Running `nuncius install-statusline` again updates a bridge installed by an older Nuncius, for example after a Node upgrade moved the binary.

## CLI

```bash
nuncius codex  "Write tests for src/parser.ts"
nuncius cursor --project unbound --agent frontend-dev "Make the navbar responsive"
nuncius claude "Add tests for the date parser" -- --model sonnet
nuncius status
nuncius tasks                           # last 20 tasks
nuncius doctor [--json]                 # prove the sandbox works on this machine
nuncius config                          # effective settings: defaults plus your config.json
nuncius cleanup [--days 7] [--dry-run]  # remove applied (also automatic) and old worktrees
nuncius dashboard [--port 7317]         # http://localhost:7317
```

- stdout carries only the target's final answer. While the task runs, stderr shows what the target does, one line per step (`[nuncius] 9 s edit calc.py`, `[nuncius] 11 s Shell: npm test`). At the end stderr gets one usage line, for example `[nuncius] codex · unbound · 42.1s · 12.800 tokens · 5h 34% · week 12%`.
- Extra target arguments after `--` are allowlisted: `--model` / `-m` for both targets, plus `-c model_reasoning_effort|model_reasoning_summary|model_verbosity=<value>` for Codex. Anything that could touch the sandbox, approvals or config is refused with exit code 2. The prompt is always passed after `--`, so a prompt starting with `-` cannot become a flag.
- The CLI uses the same queue, worktree and sandbox as MCP callers: it waits for a slot, then runs the task in-process, and prints `review` / `apply` lines when there are changes.
- `--force` runs a task even when a budget is exceeded, but only when you type it in a terminal yourself: Nuncius refuses it when Claude Code's `CLAUDECODE` marker is set or an agent CLI (`claude`, `codex`, `cursor-agent`) is among its parent processes, and the Claude Code hook also refuses `nuncius ... --force` (also wrapped in `script` or `unbuffer`). This keeps well-behaved agents from overriding budgets. It is a guardrail, not a security boundary: the calling agent runs as you and could edit `~/.nuncius/config.json`. The targets Nuncius starts are sandboxed and cannot call Nuncius at all.
- Models listed in `targets.<name>.blockedModels` (exact ids, or prefixes ending in `*`) are refused with exit code 2.
- Exit codes: `0` ok · `2` usage error · `3` refused (budget or nested Nuncius call) · `124` timeout · otherwise the target's own exit code.
- Project: `--project`, then `NUNCIUS_PROJECT`, then the repository's folder name (every `git worktree add` checkout of a repository is the same project), then the folder name. Agent: `--agent`, then `NUNCIUS_AGENT`, then `claude` (inside Claude Code) or `manual`.
- Data: `~/.nuncius/usage.jsonl`, raw output in `~/.nuncius/runs/`, settings in `~/.nuncius/config.json` (see [Configuration](#configuration); move it all with `NUNCIUS_HOME`). Nothing leaves your machine: Nuncius has no telemetry.
- Retention: prompts, answers, raw output and patches of finished tasks are removed after `retention.days` (default 7), automatically and by `nuncius cleanup`. The usage numbers stay (budgets and the 30/90-day dashboard need them), without the prompt preview, error text and folder path. A task whose worktree is still open keeps everything until that worktree is gone.
- The dashboard binds to 127.0.0.1, rejects requests whose Host header is not loopback (DNS-rebinding protection), and its data API needs the per-run token in the URL it prints.
- A target's answer is returned up to 256 K characters; anything longer is cut with a note, and the full output stays in `~/.nuncius/runs/<id>.out`.

What it measures today:

| | Codex | Cursor | Claude |
|---|---|---|---|
| Per task | input, cached and output tokens | input, cached and output tokens, plus duration | input, cached and output tokens (all models, incl. subagents), API cost estimate |
| Limits | 5-hour and weekly window %, asked from Codex itself (`codex app-server`, outside the sandbox) and from your own `~/.codex/sessions` | own caps: runs, agent minutes and tokens per day | 5-hour and weekly window %, via the statusline bridge; otherwise daily caps |
| Model used | from its session rollout | from its chat store | from `modelUsage` in its result |

## Configuration

Run `nuncius setup` once to get going (see [Quick start](#quick-start)). After that, change any setting with `nuncius config`; there's no need to open a file.

```bash
nuncius config                                   # every setting: its value, the default, what it does
nuncius config list budgets                      # only the settings whose name contains "budgets"
nuncius config get budgets.cursor.maxRunsPerDay  # one setting
nuncius config set budgets.cursor.maxRunsPerDay 50
nuncius config unset budgets.cursor.maxRunsPerDay  # back to the default
nuncius config add sandbox.passEnv NPM_TOKEN       # add to a list (remove works the same way)
nuncius config --json                              # the effective settings as JSON
```

How it works:
- **One name per setting.** Names are dotted paths such as `budgets.cursor.maxRunsPerDay`, the same in `nuncius config`, in `~/.nuncius/config.json` and in this README. A typo gets a "did you mean".
- **Values:** numbers, `true`/`false`, text, comma-separated lists, or `none` to switch a limit off. `nuncius config list` and `nuncius config get` show for every setting what you can enter, including what `0` and `none` mean where they mean something. A value of the wrong kind is refused with what was expected — on the command line, and when Nuncius reads the file: a hand-edited `config.json` with a setting of the wrong kind (a budget as a string, or `budgets` set to `none`) is refused with the exact problem, so a typo can't silently switch a budget off. Fix it in the file, or with `nuncius config set`/`unset`.
- **`0` is not "no limit".** For a budget, `0` would refuse every task, so Nuncius refuses it and tells you what you probably meant: `none` for no limit, or `targets.<tool>.enabled false` to stop using that tool. Where `0` does mean something, it's allowed and described: `tasks.syncWaitSeconds 0` returns the task id at once, `tasks.modelCacheSeconds 0` asks the tools for their models every time, and `worktrees.keepDays 0` makes `nuncius cleanup` remove every unapplied worktree.
- **Only your changes are stored**, in `~/.nuncius/config.json` (or `$NUNCIUS_HOME`). Everything else follows the defaults, including better ones in later versions. `unset` restores the default.
- **Setting changes apply right away**, with nothing to restart. (An *upgrade* is different: a running `nuncius mcp` server keeps the code it started with, so after `npm i -g nuncius` reconnect the MCP server, or restart your client, to pick up the new version. `usage` reports a restart hint when the running version is behind the one on disk.)
- **Settings are global.** There are no settings files in projects: a repository can't change your budgets or sandbox. Budgets per project exist, but they live in the same global settings (see below).
- **Agents can read settings but not change them.** `nuncius config set|unset|add|remove`, `nuncius setup` and `nuncius uninstall-hook` are refused when an agent runs them, and the hook blocks them. An agent tells you the command; you run it.
- **Old names still work** in an existing `config.json`: `codexBin`, `maxPrimaryPercent`, `cursorRunsPerDay`, `dashboardPort` and so on are read as their new names. The next `nuncius config set` rewrites the file with the new names.

### Budgets

A task that would go over a budget is refused, with the reason. Nuncius checks budgets **before it starts a task**: a running task is not stopped when it crosses one, so a long task that starts at 88% can end above 90%. Every tool has the same three **daily limits**, counted from midnight local time over the tasks that ran (refused tasks don't count). The run-time limit is the total of all that tool's tasks that day, not the length of one task.

| Setting | Codex | Claude | Cursor | Meaning |
|---|---|---|---|---|
| `budgets.<tool>.maxTokensPerDay` | none | none | none | tokens (input + output) per day |
| `budgets.<tool>.maxRunsPerDay` | none | 100 | 100 | tasks per day |
| `budgets.<tool>.maxAgentMinutesPerDay` | none | none | 180 | minutes of run time per day, all tasks together |
| `budgets.<tool>.max5HourPercent` | 90 | 90 | – | start no new task above this % of the 5-hour subscription window (resets within hours) |
| `budgets.<tool>.maxWeeklyPercent` | 80 | 80 | – | start no new task above this % of the weekly subscription window. Lower by default: it takes days to reset, and you want room for your own work |

`<tool>` is `codex`, `claude` or `cursor`. Cursor doesn't share its subscription usage, so only its daily limits apply. Claude's windows need the statusline bridge (see [Claude limits](#claude-limits-statusline-bridge)); until it has recorded them, only Claude's daily limits apply.

**Per project:** the same daily limits under `budgets.projects.<project>.<tool>`. `<project>` is the git repository's folder name (or `--project`); a second checkout made with `git worktree add` counts as the same project, whatever its folder is called. A project limit applies on top of the global one, and the first one reached refuses the task:

```bash
nuncius config set budgets.projects.side-project.cursor.maxRunsPerDay 10
nuncius config set budgets.projects.unbound.claude.maxTokensPerDay 5000000
```

### Tools (`targets.<tool>`)

Nuncius offers only the tools it finds: each CLI on your `PATH`, or at `targets.<tool>.bin`. Someone with only Codex never sees Cursor or Claude in `list_targets`, the MCP instructions or the dashboard, and a task for a missing tool is refused right away instead of queued. `nuncius status` and the dashboard header show what was found and why the rest is missing.

| Setting | Default | Meaning |
|---|---|---|
| `targets.<tool>.enabled` | `true` | `false` hides an installed tool everywhere: Nuncius neither offers nor runs it |
| `targets.<tool>.bin` | `codex`, `cursor-agent`, `claude` | the CLI's name on `PATH`, or an absolute path |
| `targets.<tool>.blockedModels` | empty | model ids Nuncius refuses (case-insensitive; a trailing `*` matches a prefix). Only applies to a model asked for explicitly, not the tool's default or Cursor's `auto` |
| `targets.<tool>.models` | Claude: `opus, sonnet, fable, haiku` | models to offer when the CLI can't be asked (Codex and Cursor are asked) |
| `targets.<tool>.apiDomains` | the vendor's API hosts | hosts the CLI itself may reach. Change only if a CLI update needs a new one (see `blockedHosts` on a failed task) |

### Aliases (`aliases.<name>`)

Optional names callers can use instead of a tool. There are none by default, because which tools someone has (and which models they want to spend their plan on) differs per person.
- `aliases.<name>.target` is `codex`, `cursor`, `claude` or `other`. `other` means any available tool that isn't the caller's own, which is what a second opinion needs.
- `aliases.<name>.model` is optional. Without it, the tool uses its own default. `list_targets` shows the models each tool offers on your account.

```bash
nuncius config set aliases.review.target other
nuncius config set aliases.deep.target codex
nuncius config set aliases.deep.model gpt-6-astra
nuncius config unset aliases.deep                # remove the alias
```

An alias to a tool that isn't available is reported as such in `list_targets`, and the MCP instructions name the aliases you configured.

What the vendors say, as a starting point for your own aliases (October 2026):
- **Cursor:** its own models (`auto`, `composer-2.5`) draw on the usage included in your plan. Pinning a third-party model in Cursor (Claude, GPT, Grok) is billed at API prices from a smaller pool ([Cursor](https://cursor.com/blog/increased-agent-usage)).
- **Codex:** `gpt-6.1-sol` (the default) for complex coding, `gpt-6-astra` for the most demanding work, `gpt-6-luna` for focused, high-volume tasks ([OpenAI](https://developers.openai.com/api/docs/guides/latest-model)).
- **Claude:** `opus` for most work, `fable` for the hardest long-running work, `sonnet` and `haiku` for speed ([Anthropic](https://platform.claude.com/docs/en/models/overview)). The Claude CLI resolves these names to the latest model of each line.

### Network, sandbox, tasks, worktrees, dashboard

| Setting | Default | Meaning |
|---|---|---|
| `network.domains` | npm, Yarn, PyPI, GitHub, crates.io, Go proxy | extra hosts a task may reach when it asks for network (`network: true`, `--network`). A leading `*.` matches subdomains |
| `sandbox.passEnv` | empty | extra environment variables a target may see: names, or prefixes ending in `*` |
| `sandbox.extraReadable` | empty | absolute paths in your home folder that targets may read, for a toolchain or data the built-in list misses (the rest of the home folder is closed) |
| `sandbox.extraDenyRead` | empty | absolute paths targets may not read, on top of the built-in credential, history and browser-data list |
| `sandbox.extraWritable` | empty | absolute paths targets may write besides their worktree. Use sparingly: every task can write there |
| `concurrency.perTarget` | 2 | tasks running at once per tool; more wait in the queue |
| `concurrency.total` | 4 | tasks running at once overall |
| `concurrency.maxQueued` | 20 | tasks waiting in the queue at most; a submit beyond that is refused with an error |
| `tasks.timeoutSeconds` | 1800 | stop a task (and everything it started) after this; 1 or more, because a task must be able to end |
| `tasks.syncWaitSeconds` | 300 | how long `run_task` waits for the result before it returns the task id (0 to 600; 0 = return the id at once) |
| `tasks.modelCacheSeconds` | 3600 | how long discovered model lists are reused (0 = ask the tools every time) |
| `worktrees.autoRemoveApplied` | `true` | remove a worktree (and its branch) once its work is in your current branch |
| `retention.days` | 7 | how long Nuncius keeps the prompts, answers, raw output and patches of finished tasks; the usage numbers stay, and a task with an open worktree keeps everything (0 = remove as soon as a task ends · none = keep everything) |
| `worktrees.keepDays` | 7 | `nuncius cleanup` removes unapplied worktrees older than this; their branch is kept (0 = remove every unapplied worktree) |
| `dashboard.port` | 7317 | port of `nuncius dashboard` (`--port` overrides it once) |

### Examples

Keep Cursor in check: at most 40 tasks, 2 million tokens and 2 hours of run time a day, whichever comes first.

```bash
nuncius config set budgets.cursor.maxRunsPerDay 40
nuncius config set budgets.cursor.maxTokensPerDay 2000000
nuncius config set budgets.cursor.maxAgentMinutesPerDay 120
```

Leave more of your subscriptions for your own work (the defaults are 90% of the 5-hour and 80% of the weekly window):

```bash
nuncius config set budgets.codex.max5HourPercent 75
nuncius config set budgets.codex.maxWeeklyPercent 60
nuncius config set budgets.claude.max5HourPercent 75
nuncius config set budgets.claude.maxWeeklyPercent 60
```

Keep Claude for yourself, and refuse Claude Opus models inside Cursor:

```bash
nuncius config set targets.claude.enabled false
nuncius config add targets.cursor.blockedModels "claude-opus-*"
```

A private package registry and its token:

```bash
nuncius config add network.domains npm.example.com
nuncius config add sandbox.passEnv NPM_TOKEN
```

Longer tasks, fewer at once:

```bash
nuncius config set tasks.timeoutSeconds 3600
nuncius config set concurrency.perTarget 1
nuncius config set concurrency.total 2
```

## Development

```bash
npm test
```

The tests use fake `codex`, `cursor-agent` and `claude` binaries (`test/fixtures/`), so the real CLIs are not needed, but they do run the real sandbox, so they need macOS. Requires Node 20 or later. There are no dependencies. One test (`--force` from a terminal) only runs outside an agent: run `npm test` from a plain terminal to include it.

## Limitations

Know these before you rely on Nuncius (the full list of residual risks is in the [threat model](docs/THREAT_MODEL.md#known-residual-risks)):

- **macOS only.** The sandbox is `sandbox-exec`; on other systems no task runs (there is no unsandboxed fallback).
- **The vendor API is a channel.** A target, and the commands it runs, can reach its own vendor's API. A prompt-injected target holding an attacker's API key could send data it can read to that account (ADR 5). The target reads with the real `$HOME` (for Codex and Claude), so although credential stores, shell history, `~/.gitconfig` and browser data are blocked, the deny list is not a proof that nothing sensitive is readable: keep secrets out of the repositories you delegate from, and add their paths to `sandbox.extraDenyRead`.
- **Budgets and the hook are guardrails against the calling agent.** The caller (Claude Code, Cursor) runs as you: it could edit `~/.nuncius/config.json`, unset markers or run CLIs in ways the hook does not recognise. They keep well-behaved agents within budget; the hard boundary is the sandbox around targets, which cannot call Nuncius at all. The hook exists for Claude Code only.
- **Limits are only as fresh as their source.** Nuncius asks Codex for its limits (cached for a minute) before a task starts and after it ends, and never believes what a task writes. If Codex does not answer (logged out, offline), the last reading and your own session files are used. Claude limits only arrive through the statusline of an interactive Claude Code session (`nuncius install-statusline`); without it the daily caps apply. Cursor has no readable subscription window: only Nuncius's own run, minute and token caps.
- **Usage is what the CLIs report.** Nuncius validates the numbers (no negative or non-numeric values, and no more tokens than a run of that length could use: 5 million a minute, at least 1 million per run) but cannot verify them; Cursor time uses Nuncius's wall clock as a floor.
- **Models.** Cursor's models are discovered; Codex and Claude use the lists in the config. `blockedModels` catches a model passed with `--model`, not a CLI's default model or Cursor's `auto`.
- **What the target sees.** Your HEAD plus uncommitted and untracked files, but not ignored files (`.env`, `node_modules`) and not untracked nested repositories. Network is off for commands unless the task asks for it, and then only the listed registries are reachable.
- **Logins.** If Codex refreshes its login during a task, that copy is discarded (Nuncius never writes a target's file into `~/.codex`); the task reports it, and you may need `codex login`.
- **Processes.** Everything a target starts in its process group ends with it; a process that leaves the group (e.g. a daemon that calls `setsid`, or Cursor's own updater) is stopped too when it works in, or runs from, the task's folders. One that also moves out of them is still confined by the sandbox but can outlive the task (with task accounts, Codex and Claude cannot leave anything behind). It cannot hold the task open: Nuncius stops waiting for its output two seconds after the target exits.
- **Review is yours.** Nuncius commits the target's work to a branch and flags risky files; it never merges, and it cannot judge whether the change is correct.
- **Upgrades need an MCP restart.** A `nuncius mcp` server runs the code it was started with. After upgrading Nuncius, reconnect the MCP server (or restart the client); the CLI and new tasks use the new code at once, but a long-lived MCP server does not until it restarts. `usage` shows a restart hint when they differ.

## License

Apache License 2.0. See [LICENSE](LICENSE).
