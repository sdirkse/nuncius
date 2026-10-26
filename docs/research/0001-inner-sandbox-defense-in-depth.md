# Research: letting Codex and Cursor run code in their own sandbox

Status: findings · 2026-10-21 · no code change yet

## Question
Nuncius runs every target inside its own macOS Seatbelt profile and **turns the target CLI's own
sandbox off** (Codex gets `--sandbox danger-full-access`; Claude Code's Bash sandbox and Codex's
Seatbelt are disabled). Can we instead let the CLIs run model-generated commands inside *their own*
sandbox, as a second layer (defense in depth)?

## What the CLIs use
- **Codex**: its native binary reports `MacosSeatbelt` / `LinuxSeccomp` / `WindowsRestrictedToken`.
  On macOS it builds a Seatbelt profile (`seatbelt_base_policy.sbpl`, `(version 1)`,
  `(deny file-write* …)`, a separate network policy) and applies it — the same mechanism Nuncius uses.
- **Cursor**: the agent is a bundled Node program; on macOS it likewise relies on the OS sandbox.
- **Claude Code**: its Bash tool applies a Seatbelt profile for the commands it runs.

## The hard constraint
macOS does not allow a process that is already inside a Seatbelt sandbox to apply a second profile.
Minimal reproduction:

```
$ sandbox-exec -f outer.sb /bin/sh -c "sandbox-exec -f inner.sb /bin/echo hi"
sandbox-exec: sandbox_apply: Operation not permitted
```

So inside Nuncius's profile, the CLI's own Seatbelt **cannot** start. This is exactly the
`sandbox_apply: Operation not permitted` that ADR 5 already records for Claude Code's Bash sandbox,
and it applies equally to Codex's `workspace-write`. It is an OS limitation, not a Nuncius bug.

Consequence: on macOS you get **one** Seatbelt layer, not two. Nuncius chose to make that one layer
Nuncius's own, because Nuncius's profile also enforces things the CLI sandboxes do not: the egress
proxy (hosts are allowlisted and resolved outside the sandbox; no DNS), the recursion-guard canary,
the exact worktree/runtime write boundary, and the credential read-deny list.

Important nuance: the model-generated commands **are** already sandboxed — by Nuncius's profile. The
goal "run code in a sandbox" is met; what is not possible on macOS is running it in the CLI's *own*
sandbox *in addition to* Nuncius's.

## Options

### A. Keep one strong layer (current, recommended for macOS)
Nuncius's profile is a superset of what the CLI sandbox would grant for files, plus network control the
CLI sandbox does not have. The CLI's inner sandbox would be redundant and cannot run anyway. Cost:
nothing. This is the right default on macOS.

To make the "one layer" story airtight, two follow-ups (independent of the CLIs' sandboxes):
- Verify, per CLI, that Nuncius's profile is at least as strict as the CLI's own `workspace-write`
  would be (it already denies more: no network except the proxy, no writes outside the worktree).
- Keep `apiDomains` as narrow as each CLI allows (already done).

### B. Let the CLI own the sandbox, Nuncius drops its Seatbelt — rejected
If Nuncius applied no profile, Codex `--sandbox workspace-write` / Cursor's sandbox could run. But Nuncius
would lose the egress proxy enforcement, the canary recursion guard, the worktree write boundary, and
the secret read-deny — its core guarantees. The CLI sandboxes do not route traffic through Nuncius's
allowlisting proxy. Net security would drop. Not worth it.

### C. Second layer by a different mechanism than Seatbelt
Nesting is only forbidden for Seatbelt-on-Seatbelt. A second boundary built differently can coexist:
- **Separate UID for model-generated commands.** Run the target (or just the commands it spawns) as a
  dedicated unprivileged user, so they cannot read the CLI's own API token or share its network
  identity — this is the real fix for the vendor-API exfil residual in ADR 5, not just a second file
  sandbox. Needs a pre-created user and a privileged helper to drop to it; a notable but bounded lift.
- **Lightweight VM** (Apple Virtualization.framework) or a container per task. Strongest isolation,
  and the inner CLI sandbox *can* run inside the guest (its own kernel). Large lift; heavier per-task
  startup. Best if Nuncius ever needs to run fully untrusted repos at scale.

### D. Linux support (bubblewrap/seccomp/namespaces)
On Linux, nesting works: Nuncius could use a `bwrap`/namespace outer boundary and let the CLI's seccomp
layer run inside it, giving genuine two-layer defense in depth. This also opens non-macOS hosts.
Biggest lift (a whole second platform backend), but the only path to true nested sandboxes.

## Recommendation
On macOS, keep option A — one nuncius-owned Seatbelt layer — because the OS makes a second Seatbelt
layer impossible and Nuncius's layer already subsumes the CLI's for files while adding network control.
Spend effort where it changes the threat model instead of duplicating it:
1. Close the vendor-API exfil residual with option C's per-UID separation (highest value).
2. Add a Linux backend (option D) if/when Nuncius needs to run on Linux or wants real nested layers.
3. Keep documenting clearly that model-generated commands run in Nuncius's sandbox, not the CLI's.

No code change is proposed here; this records the constraint and the options so the choice is explicit.
