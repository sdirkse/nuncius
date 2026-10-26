# Security policy

Nuncius runs other AI coding tools on your machine, so its sandbox and review path are the product. Reports about them are very welcome.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub: the repository's **Security** tab → **Report a vulnerability** ([direct link](https://github.com/sdirkse/nuncius/security/advisories/new)).

Include what you can of:
- what an attacker controls (repository content, a prompt, a target's output, a config file, another local user);
- the steps or a minimal proof of concept;
- what it achieves (escaping the sandbox, reading a secret, running code on apply, bypassing a budget, …);
- your macOS, git, Node and target CLI versions, and the output of `nuncius doctor`.

You will get an acknowledgement, and a fix or an explanation once the report is understood. Please give us a reasonable time to ship a fix before disclosing it publicly.

## Scope

In scope: anything that breaks a boundary described in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), for example:
- a target writing outside its worktree and scratch dirs, reading a denied location, reaching the network other than through Nuncius's proxy, or affecting processes outside its sandbox;
- code from a task running outside the sandbox when Nuncius snapshots, reviews, applies or cleans up, without a `sensitiveFiles` / `repoDrivers` warning;
- a target starting Nuncius tasks itself, or escaping its usage record or budget.

Known and documented residual risks (the "Known residual risks" list in the threat model) are not new vulnerabilities, but a practical exploit or a fix for one is still very welcome.

Out of scope: what the calling agent can do as you (it runs with your full access), and the target CLIs' own behaviour outside Nuncius.

## Supported versions

Only the latest release on the `main` branch gets security fixes.
