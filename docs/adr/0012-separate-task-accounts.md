# ADR 12: Run tasks as separate macOS accounts (opt-in)

Status: implemented for Codex and Claude (opt-in: `sandbox.taskAccounts`); Cursor excluded for now.

## Context
Every task runs as the user. The Seatbelt profile (ADR 5) is the only wall between a task and the user's account, and it is a single mechanism: each gap found in it (three automated review rounds found several) is a gap in everything. Three of the known residual risks exist *because* the task runs as the user:

- it can write to the user's other terminals (`/dev/ttys*` accept writes from their owner, and the sandbox must leave `/dev` writable for the CLIs' own ptys);
- a `setsid` descendant can outlive the timeout (Nuncius can only kill the process group);
- Claude tasks share Claude Code's fixed temp folder (`/tmp/claude-<uid>`) with the user's own sessions.

A Linux backend is postponed (no Linux machine; ADR 5, research 0002). macOS offers no per-process network identity or Endpoint Security without Apple-granted entitlements, so the remaining lever is the classic one: a different Unix user.

## Decision
Opt-in "task accounts": with a one-time admin setup, Nuncius runs each target CLI as one of a small pool of hidden, powerless macOS accounts, *inside* the existing Seatbelt profile. Two independent walls instead of one. Without the setup, Nuncius works exactly as before.

### Accounts
- Group `_nuncius` (GID 460) and accounts `_nuncius1`…`_nuncius4` (UID 461–464): one per concurrent task slot (`concurrency.total`, default 4), so killing "everything of that account" at a timeout never touches another task.
- Primary group `_nuncius`, **not** `staff`: the user's home folder is `drwxr-x---` group `staff`, and every normal account is in `staff`. Shell `/usr/bin/false`, no password, hidden.
- Each account has a private home in `/var/db/nuncius-homes` (the CLIs read macOS preferences from it; Codex fails with `/var/empty`). Nuncius empties it after each task. It is under `/var/db`, which only root can write, because setup runs as root: a world-writable parent such as `/Users/Shared` would let another account plant a link that setup then follows. setup refuses paths that are links or owned by someone else.
- The user is added to `_nuncius`, so Nuncius (running as the user) can read and clean up what tasks write (group permissions, setgid folders, task umask 002).

### Starting a task
- A sudoers rule in `/etc/sudoers.d/nuncius` lets the user run commands *as these accounts* without a password. Running something as a weaker account gives the user's processes no extra power; the rule grants nothing as root.
- Nuncius starts `sudo -n -u _nunciusN -- /usr/bin/env -i <task env> /usr/bin/sandbox-exec -p <profile> <cli> …`. The environment is passed explicitly (`env -i`), so nothing from the user's environment leaks in.
- At the end or timeout: `sudo -n -u _nunciusN /usr/bin/pkill -KILL -u _nunciusN`, which reaches every process of the account however it detached. Then Nuncius normalises permissions in the worktree as the task account (`chmod -R g+rwX`), because a target could make its files unreadable to the user.

### Files and git (option A: pass-through home)
- The user's home folder is `drwxr-x---` group `staff`; a task account cannot enter it, yet Claude and Cursor are installed in it (`~/.local`), and so are toolchains and repositories. Chosen: one ACL entry on the home folder, `group:_nuncius allow search` — task accounts may *pass through* it (open a path they already know) but not list it. Everything below keeps its own permissions.
- So the second wall protects, for reading, what is private to the user: `600`/`700` files and folders (SSH private keys, `~/.codex/auth.json`, the keychain files, and `Documents`, `Desktop`, `Downloads`, `Library`, which macOS makes `700`). World-readable files in development folders (repositories, dotfiles) are protected by the Seatbelt allowlist alone, as before. Option B (home fully closed, hard-linked CLIs and toolchains, a git mirror per repository) was rejected for its upkeep: every CLI and toolchain update would have to be followed.
- Nuncius's own data folder (`~/.nuncius`) becomes `700`: it holds every prompt and answer, and was world-readable (`755`/`644`), so any account in `staff` could already read it.
- Worktrees and per-task runtime folders get group `_nuncius` (setgid, group-writable), so the task account can write them and Nuncius can read and remove what it wrote. git works on the user's repository directly: its objects are read-only for everyone and its folders `755`, so a task account can read them through the pass-through; it still cannot write them (the repository stays write-denied in Seatbelt too).
- The shadow git config of ADR 5 still applies.

### Logins (kept in the user's keychain)
Task accounts have no keychain they could unlock. Nuncius, running as the user, reads the login at task start and hands it only to that task process:
- **Claude:** a long-lived token from `claude setup-token`, stored by Nuncius in the user's keychain, passed through `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` (not visible in the environment).
- **Cursor:** `CURSOR_AUTH_TOKEN`, read fresh from Cursor's own keychain item each task, or a personal API key (`CURSOR_API_KEY`) Nuncius stores in the keychain. The prototype decides which is reliable.
- **Codex:** Codex keeps its login in `~/.codex/auth.json` (no keychain store). Nuncius copies it into the task's private Codex home (group-readable), as today; refreshes inside the task are discarded, as today.

### Firewall (second network wall)
A pf anchor (`com.apple/250.nuncius`, loaded at boot by a launchd job; `/etc/pf.conf` already includes `com.apple/*` anchors, so it is not edited) that allows the task accounts' TCP/UDP only to `127.0.0.1` (Nuncius's proxy) and blocks everything else, inbound included. Independent of Seatbelt.

## What it fixes and what it does not
- Fixed: other terminals; `setsid` survivors; Claude's shared temp folder. The user's private files are blocked twice (Seatbelt allowlist and Unix permissions); world-readable files in the home folder once (Seatbelt). Network blocked twice (Seatbelt and pf).
- Not fixed: the vendor-API channel (the CLI and its commands share one account); `sandbox-exec` being deprecated.

## Costs and risks
- One admin setup and an undo script (`scripts/task-accounts/`). macOS updates may need `nuncius doctor` to re-verify.
- Nuncius sets group ownership and permissions on worktrees and runtime folders in this mode, and starts targets through `sudo`.
- A sudoers rule is security-sensitive configuration; it is validated with `visudo -c` before it is installed, and only targets the task accounts.

## Prototype (before any Nuncius code)
Prove on the real accounts, each with a test that would fail without it:
1. A task account cannot read the user's home folder, write to the user's terminals, or signal the user's processes.
2. `pkill -u` at the end removes a `setsid` survivor.
3. Group sharing works both ways without a re-login (the user reads and deletes what the task wrote).
4. git status, log and diff work for a task account in a worktree of a repository in the home folder; Nuncius commits the result as before.
5. Each CLI logs in through the keychain-backed mechanism above and completes a task.
6. pf blocks a direct connection from a task account and allows the proxy.

## Outcome (2026-10-23)
**Prototype** (`scripts/task-accounts/prove.sh`, 19 checks, without Nuncius's sandbox, on the real accounts): an account cannot list the home folder, read the Codex login, `~/Documents`, Nuncius's data or an SSH private key; cannot write to the user's terminal or signal the user's processes; `pkill -u` removes a `setsid` escapee; group folders work both ways without a re-login; git works in a worktree; pf blocks direct connections and allows loopback.

**Built** (`src/accounts.js`, `sandbox.taskAccounts`):
- Only Codex and Claude run as an account. The account is claimed under the queue lock (one per running task, at most four).
- `sudo -n -u _nunciusN -- /usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c <launcher> sh /usr/bin/sandbox-exec -p <profile> <cli> …`. Only `PATH` is on the command line (argv is visible to every process); the whole environment, logins included, goes over stdin as `KEY=base64` lines, so values arrive exactly. An automated review flagged the first version, which had the environment on the command line.
- Worktree and per-task folders get group `_nuncius` (setgid, group-writable); their roots are group-searchable only. Codex and Claude get a throw-away `HOME`.
- git refuses a repository owned by another account ("dubious ownership"); the task's own worktree is named as `safe.directory` through the environment, nothing wider.
- Codex's login: the account writes the content of `~/.codex/auth.json` itself (mode 600), so other task accounts cannot read it. Claude's: a long-lived token from `claude setup-token`, stored as keychain item `nuncius-claude-token`, passed in over stdin. Claude Code's own keychain token was tried and rejected: it rotates whenever Claude Code refreshes it (401 shortly after).
- At the start of each task and in the reaper: every process of the account is stopped and its home emptied (so a worker that died cannot leave state for the next task). After a run: processes stopped, ownership of what the account wrote handed back (`chmod g+rwX` run as the account), home emptied.
- The accounts' homes are in `/var/db/nuncius-homes` (root-only parent; an automated review flagged `/Users/Shared`, where another account could plant a link that setup, as root, would follow).
- `nuncius doctor` proves the account wall on its own when the mode is on.

**Cursor is excluded.** As an account it logs in (with its keychain token, not with a personal API key in the tested setup) but its tools fail: its exec-daemon with its own `cursorsandbox` helper does not start, its server calls partly report "unauthenticated", it updates itself into the task home, and it insists on saving its login to a keychain — without one, macOS shows the user a "keychain not found" dialog; with the keychain tool blocked, Cursor crashes. It keeps running as the user inside the sandbox, as before. Since then Nuncius starts it with `--disable-auto-update` (no download into the task home, no detached cleanup process) and stops what it leaves running in the task's folders (`src/strays.js`).

**Verified with the real CLIs:** Codex as `_nuncius1` — `whoami` `_nuncius1`, git log and status work, the file it wrote is committed by Nuncius, the account home is empty afterwards. Claude as `_nuncius1` with a `claude setup-token` token — its Bash tool ran `whoami` (`_nuncius1`), git log and status; the file it wrote is committed by Nuncius; the account home is empty afterwards. (Storing the token: a terminal that limits a typed line to its width truncates it silently; check the stored length — the full token is 108 characters.)
