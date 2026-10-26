# Threat model

What Nuncius protects, what it does not, and why. Each "protected" item below has a regression test (`test/redteam.test.js`) and, for the sandbox, a check you can run yourself: `nuncius doctor`.

## The parties

| Party | Trust | Why |
|---|---|---|
| **You** | Trusted | You install Nuncius, set the budgets and decide what gets applied. |
| **The calling agent** (Claude Code, Codex, Cursor talking to Nuncius over MCP) | Runs as you, not sandboxed by Nuncius | It already has your full access. Nuncius does not try to contain it; it can only make the safe path the easy one. |
| **The target** (the Codex / Cursor / Claude CLI Nuncius starts for a task) and **everything it runs** | **Untrusted** | Model output can be wrong, prompt-injected by repository content, or hostile. Nuncius assumes the worst. |
| **Target output** (its answer, the files it writes, usage numbers it reports) | **Untrusted data** | Shown to you and the calling agent as data, never as instructions; numbers it reports are clamped to what Nuncius measured itself. |

## What is a security boundary

These are enforced by the OS or by Nuncius's own code, outside the target's reach:

- **The sandbox** (macOS Seatbelt, [ADR 5](adr/0005-sandbox-by-default.md)). A target can write only its worktree and its per-task scratch dirs. Its view of your home folder is an allowlist: only the task's own files, the repository's git data (without its config, which can hold credentials: a task's git reads a cleaned copy), the CLI's install and login, and toolchains are readable; everything else (other repositories, your repository's working files, shell config, caches, app data) is closed, and so are Nuncius's own data, the recursion-guard canary and credential stores, also inside those readable folders. It cannot signal processes outside its sandbox, create launchd jobs, use DNS, connect anywhere except Nuncius's per-task egress proxy, or listen on an IP socket. There is no unsandboxed fallback: no sandbox, no task.
- **The egress proxy.** Only the target's own vendor API hosts (plus package registries when a task asks for `network`), TLS on 443/80, never raw IPs.
- **The worktree** ([ADR 4](adr/0004-worktree-per-task.md)). The target works on a copy; your checkout and its `.git` are write-denied. Nuncius commits the result on a `nuncius/<target>/<id>` branch and **never merges**.
- **Review before apply.** Nuncius's own git runs with hooks, fsmonitor and in-tree `.gitattributes` disabled (git 2.41+ required, enforced). The `apply` command runs with hooks off and attributes from your HEAD. Files that configure tools or run code are listed in `sensitiveFiles`; when your repo has git filter/merge drivers that run repo code, *every* changed file is listed (`repoDrivers`), because applying runs those drivers outside the sandbox.
- **Recursion guard** ([ADR 8](adr/0008-recursion-guard.md)). A target cannot start Nuncius tasks itself.
- **Task accounts** (optional, [ADR 12](adr/0012-separate-task-accounts.md)). With `sandbox.taskAccounts`, Codex and Claude run as a separate, powerless macOS account inside the sandbox: Unix permissions keep it from your private files, terminals and processes, and a pf firewall rule keeps it to Nuncius's proxy, independently of the sandbox.
- **Usage records.** A target cannot kill Nuncius to skip its record, forge its run time, or report absurd token counts; budgets are checked under a lock that counts queued and running tasks.
- **What reaches the calling agent.** A target's answer is stored and returned up to 256 K characters; the rest stays in `~/.nuncius/runs/<id>.out`.
- **The dashboard.** Bound to 127.0.0.1, it rejects non-loopback Host headers (DNS rebinding), and its data API needs a random token printed with its URL each run, so another account on the same Mac cannot read prompts or output through it.

## What is a guardrail, not a boundary

These stop well-behaved agents and mistakes, not a determined process running as you:

- **Budgets and `--force`.** The calling agent runs as you and could edit `~/.nuncius/config.json`. Nuncius refuses `--force` and config changes from agents, and the optional Claude Code hook blocks them, but that is policy, not isolation.
- **The Claude Code hook.** It steers Claude to Nuncius instead of starting agent CLIs directly. Anything that runs as you can bypass it.
- **`sensitiveFiles`.** A list to make you look, not a verdict. Nuncius cannot judge whether a change is correct or safe; **you review the diff**.

## Known residual risks

Found and accepted for now, each reproduced and documented in the ADRs:

1. **Vendor-API channel.** Commands a target runs can reach the same vendor API host as the CLI. A prompt-injected target holding an attacker's API key could send data to that attacker's account there. TLS hides the contents from the proxy, and Seatbelt cannot tell the CLI and its children apart. A fix needs a network identity per process, which macOS does not offer without Apple-granted entitlements; task accounts ([ADR 12](adr/0012-separate-task-accounts.md)) do not help here, because the CLI and the commands it runs share one account.
2. **What stays readable.** The home folder is closed except an allowlist, but what is outside the home folder (`/opt`, `/usr/local`, `/Library`, other volumes) stays readable, and toolchain and package-cache folders in it are readable on purpose. Keep secrets out of delegated repositories and out of those folders, and add locations with `sandbox.extraDenyRead`. The macOS keychain stays reachable (the CLIs need it for their login; items are gated by securityd).
3. **Other terminals.** `/dev` stays writable because the CLIs create ptys for the commands they run; a target can write to another terminal of yours. *Closed for Codex and Claude with task accounts* (`sandbox.taskAccounts`): your terminals do not accept writes from another account.
4. **A `setsid` descendant can outlive the task.** It stays inside the sandbox, but can keep changing the worktree after Nuncius committed it. Review the commit Nuncius reports, not the live worktree. *Narrowed:* before it commits, Nuncius stops every process started since the task that works in, or runs something from, the task's own folders (worktree, throw-away HOME, caches); the reaper does the same for a task whose worker died. Cursor's own updater was such a process. A descendant that moves out of those folders and runs only system binaries is still missed. *Closed for Codex and Claude with task accounts:* Nuncius stops every process of the account before it commits.
5. **Claude's shell cwd file.** Claude Code writes `/tmp/claude-<hex>-cwd`; that filename shape stays writable for Claude tasks. *With task accounts* the files belong to the task account, so a task cannot touch your own Claude sessions' files.
6. **macOS only, on a deprecated tool.** `sandbox-exec` is marked deprecated by Apple (it still works, and Codex uses the same Seatbelt mechanism for its own sandbox). If it disappears, Nuncius refuses to run rather than run unsandboxed. A Linux backend (bubblewrap/seccomp) is on the roadmap.

## What you should do

- Run `nuncius doctor` after installing, after a macOS update and after changing `sandbox.*` settings.
- Commit or stash before delegating, and keep secrets (`.env`, keys) out of repositories you delegate.
- Read the diff (`review`) before `apply`, and take `sensitiveFiles` and `repoDrivers` warnings seriously.
- Keep `network` off unless a task must install packages.
- Restart the MCP server after upgrading Nuncius (a running server keeps its old code; `usage` shows a hint).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
