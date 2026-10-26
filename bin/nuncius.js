#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, usageLogPath, runsDir } from '../src/config.js';
import { readUsage } from '../src/log.js';
import { detectProject, detectAgent } from '../src/project.js';
import { summarise } from '../src/summary.js';
import { submitTask, executeTask, listTasks, publicTask, underAgent, freshCodexLimits } from '../src/tasks.js';
import { displayName } from '../src/worktree.js';
import { statuslineInstalled } from '../src/statusline.js';
import { claudeLimitsHint, readBridgeSeen } from '../src/claude-limits.js';

const HELP = `nuncius — hand tasks to Codex, Cursor or Claude on your own subscriptions, isolated and budgeted

Usage:
  nuncius codex  [options] "<prompt>" [-- --model <id> | -c model_reasoning_effort=<v>]
  nuncius cursor [options] "<prompt>" [-- --model <id>]
  nuncius status [--json]
  nuncius tasks [--json]          last 20 tasks and their state
  nuncius doctor [--json]         prove the sandbox works on this machine (run once after installing)
  nuncius cleanup [--days <n>] [--dry-run]   remove applied or old task worktrees
  nuncius claude [options] "<prompt>" [-- --model <alias|id> | --max-turns <n>]
  nuncius mcp                     MCP server over stdio (for Claude Code, Cursor)
  nuncius install-statusline      record Claude's 5h/weekly limits via your Claude Code statusline
  nuncius uninstall-statusline    restore your previous statusline
  nuncius setup                   first-time setup: finds your tools, sets budgets, connects Claude Code/Codex/Cursor
  nuncius config                  show and change settings (nuncius config help for the commands)
  nuncius install-hook            optional: when Claude Code starts codex / cursor-agent / claude -p itself, send it to nuncius
  nuncius uninstall-hook          remove that hook again
  nuncius dashboard [--port <n>]

Options:
  --project <name>  Project to log under (default: NUNCIUS_PROJECT, git root name, folder name)
  --agent <name>    Who asked (default: NUNCIUS_AGENT, "claude" inside Claude Code, else "manual")
  --force           Run even when a budget is exceeded (only from an interactive terminal)
  --network         Let the target reach package registries and GitHub (network.domains), besides its own API
  --raw             Print the tool's raw output instead of only the final answer
  Use "-" as prompt to read it from stdin.

Every task runs in its own git worktree (branch nuncius/<target>/<id>) inside a sandbox; the nuncius
commits the result there and prints how to review and apply it. Nothing is merged for you.

Exit codes: 0 ok · 2 usage error · 3 refused (budget or nested nuncius call) · 124 timeout · otherwise the tool's exit code.
Data: ${usageLogPath()}`;

function parseArgs(argv) {
  const opts = { extra: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts.extra = argv.slice(i + 1);
      break;
    } else if (a === '--project') opts.project = argv[++i];
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--network') opts.network = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--raw') opts.raw = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  return { opts, rest };
}

const fmt = (n) => Math.round(n).toLocaleString('nl-NL');
// Project, agent and prompt strings come from callers and targets: no terminal escapes in output.
const shown = (v) => displayName(String(v ?? ''));

// --force skips budgets, which exist to stop agents spending without asking. It is checked here, on
// the arguments as nuncius receives them (after any quoting or expansion a hook cannot see through):
// only on a terminal, and not when an agent CLI is among our ancestors or Claude Code's marker is set.
// A terminal alone is no proof of a person (script(1) makes one). The calling agent runs as the user
// and could still edit the config, so against it budgets are a guardrail; the targets themselves are
// sandboxed and cannot reach nuncius at all (ADR 8).
const forceAllowed = () => !!(process.stdin.isTTY && process.stderr.isTTY) && !underAgent();

function readRawOutput(id) {
  try {
    return fs.readFileSync(`${runsDir()}/${id}.out`, 'utf8');
  } catch {
    return '';
  }
}

async function runTool(tool, opts, rest) {
  let prompt = rest.join(' ');
  if (prompt === '-') prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.trim()) {
    console.error(`nuncius ${tool}: missing prompt\n\n${HELP}`);
    return 2;
  }
  const cwd = process.cwd();
  const project = detectProject(cwd, opts.project);
  const { autoCleanup } = await import('../src/cleanup.js');
  autoCleanup();
  if (opts.force && !forceAllowed()) {
    console.error('nuncius: --force only works when you type it yourself in a terminal, not from an agent (Claude Code, Codex, Cursor); ask the user to run it there or to raise the budget');
    return 2;
  }
  const { targetStatus } = await import('../src/targets.js');
  const bin = targetStatus(loadConfig()).find((t) => t.name === tool)?.bin;
  if (bin) {
    // Only a version a check already read (nuncius doctor, list_targets): never run the CLI for this.
    const { cachedCliVersion, versionCheck } = await import('../src/versions.js');
    const version = cachedCliVersion(bin);
    const { note } = version ? versionCheck(tool, version) : { note: null };
    if (note) console.error(`[nuncius] note: ${note}`);
  }
  const submitted = await submitTask({
    target: tool, prompt, extraArgs: opts.extra, cwd, project, agent: detectAgent(opts.agent), caller: 'cli', force: !!opts.force, network: !!opts.network,
  });
  if (submitted.error) {
    console.error(`nuncius ${tool}: ${submitted.error}`);
    return 2;
  }
  if (submitted.state === 'refused') {
    // The hint only where --force can help: not for nested calls, and not without a terminal.
    const hint = submitted.nested || !forceAllowed() ? '' : '\nUse --force to run anyway.';
    console.error(`[nuncius] Refused ${tool} run for ${shown(project)}:\n  - ${submitted.result.reasons.map(shown).join('\n  - ')}${hint}`);
    return 3;
  }

  // The CLI runs the task in-process but still waits for a queue slot like every other caller.
  const task = await executeTask(submitted.id, { echoStderr: true });
  if (!task) {
    console.error(`[nuncius] Task ${submitted.id}: its record is missing or damaged.`);
    return 1;
  }
  const res = task.result ?? {};
  if (task.state === 'refused') {
    console.error(`[nuncius] Refused ${tool} run for ${shown(project)}:\n  - ${res.reasons.map(shown).join('\n  - ')}`);
    return 3;
  }
  process.stdout.write(opts.raw ? readRawOutput(task.id) : res.output ? res.output.replace(/\n?$/, '\n') : '');

  const bits = [`[nuncius] ${tool}`, shown(project), `${((task.wallMs ?? 0) / 1000).toFixed(1)}s`];
  if (res.usage?.totalTokens != null) {
    bits.push(`${fmt(res.usage.totalTokens)} tokens`);
    if (res.limits?.primary) bits.push(`5h ${res.limits.primary.usedPercent}%`);
    if (res.limits?.secondary) bits.push(`week ${res.limits.secondary.usedPercent}%`);
  }
  if (!res.ok) bits.push(`FAILED: ${shown(res.error)}`);
  const wt = task.worktree;
  if (wt?.changed) bits.push(`changes on ${wt.branch} (${wt.files.length} file${wt.files.length === 1 ? '' : 's'})`);
  else if (wt?.changed === false) bits.push('no file changes');
  else if (wt && !wt.removed) bits.push(`worktree kept at ${shown(wt.path)}`);
  console.error(bits.join(' · '));
  if (wt?.changed) console.error(`[nuncius] review: ${shown(wt.review)}\n[nuncius] apply:  ${shown(wt.apply)}`);
  for (const w of task.warnings ?? []) console.error(`[nuncius] WARNING: ${shown(w)}`);
  if (wt?.repoDrivers?.length) console.error(`[nuncius] WARNING: this repo has git filter/merge drivers that run code from the repo (${wt.repoDrivers.map(displayName).join('; ')}). Applying runs them outside the sandbox, with whatever the task changed, so every changed file is flagged.`);
  if (wt?.sensitiveFiles?.length) console.error(`[nuncius] WARNING: changes to files that configure tools or run code: ${wt.sensitiveFiles.map(displayName).join(', ')}. Review them before applying.`);
  if (task.state === 'timeout') return 124;
  return res.ok ? 0 : res.exitCode || 1;
}

function tasks(opts) {
  const list = listTasks().slice(-20).reverse().map(publicTask);
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) console.log('no tasks yet');
  for (const t of list)
    console.log(`${t.id}  ${t.state.padEnd(8)} ${t.target.padEnd(7)} ${shown(t.project).padEnd(20)} ${t.createdAt}  ${shown(t.promptPreview.slice(0, 50))}`);
  return 0;
}

async function status(opts) {
  const { targetStatus } = await import('../src/targets.js');
  const found = targetStatus(loadConfig());
  // Codex's windows as Codex itself reports them now (cached a minute).
  if (found.find((t) => t.name === 'codex')?.available) await freshCodexLimits(loadConfig());
  const s = summarise(readUsage(), { days: 7 });
  if (opts.json) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  // Only the tools this user has, plus any that still has usage in the period.
  console.log(`Targets: ${found.map((t) => `${t.name} ${t.available ? '✓' : `– ${t.reason}`}`).join(' · ')}\n`);
  const shows = (tool) => found.find((t) => t.name === tool)?.available || s.totals[`${tool}Runs`] > 0;
  if (!found.some((t) => t.available)) console.log('No target CLI is installed and enabled: install codex, cursor-agent or claude, and log in.\n');
  for (const [name, l, hint] of [
    ['Codex', s.codexLimits, 'Codex did not report them (is it logged in? try `codex login`)'],
    ['Claude', s.claudeLimits, `not recorded yet. ${claudeLimitsHint({ installed: statuslineInstalled(), seen: readBridgeSeen() })}`],
  ].filter(([n]) => shows(n.toLowerCase()))) {
    console.log(`${name} limits (last seen${l?.observedAt ? ` ${l.observedAt}` : ''}):`);
    if (!l) console.log(`  unknown — ${hint}`);
    else
      for (const [k, label] of [['primary', '5-hour'], ['secondary', 'weekly']])
        if (l[k]) console.log(`  ${label.padEnd(7)} ${String(Math.round(l[k].usedPercent)).padStart(5)}%   resets ${l[k].resetsAt ?? '?'}`);
  }
  const t = s.today;
  const NAMES = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };
  const tools = Object.keys(NAMES).filter(shows);
  if (tools.length) console.log(`\nToday: ${tools.map((k) => `${NAMES[k]} ${t[`${k}Runs`]} runs (${fmt(t[`${k}Tokens`])} tokens)`).join(' · ')}`);
  console.log('\nLast 7 days per project:');
  if (!s.projects.length) console.log('  no runs yet');
  for (const p of s.projects)
    console.log(`  ${shown(p.name).padEnd(24)} ${tools.map((k) => `${k} ${String(p[`${k}Runs`]).padStart(3)}× ${fmt(p[`${k}Tokens`]).padStart(11)} tok`).join('   ')}   failed ${p.failures}`);
  return 0;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { opts, rest } = parseArgs(argv);
  if (!cmd || opts.help || ['help', '--help', '-h'].includes(cmd)) {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'codex' || cmd === 'cursor' || cmd === 'claude') return runTool(cmd, opts, rest);
  if (cmd === 'status') return await status(opts);
  if (cmd === 'tasks') return tasks(opts);
  if (cmd === 'doctor') {
    const { doctor, printDoctor } = await import('../src/doctor.js');
    const checks = doctor();
    if (opts.json) {
      console.log(JSON.stringify({ ok: !checks.some((c) => c.status === 'fail'), checks }, null, 2));
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }
    return printDoctor(checks);
  }
  if (cmd === 'statusline') {
    const { runStatusline } = await import('../src/statusline.js');
    await runStatusline();
    return 0;
  }
  if (cmd === 'install-statusline' || cmd === 'uninstall-statusline') {
    // The bridge feeds Claude's window budgets and edits the user's Claude Code settings: their call.
    // (Removing it would quietly drop those budgets back to the daily caps.)
    if (underAgent()) {
      console.error(`nuncius: ${cmd} only works when you run it yourself, not from an agent.`);
      return 2;
    }
    const m = await import('../src/statusline.js');
    const r = cmd === 'install-statusline' ? m.installStatusline() : m.uninstallStatusline();
    console.log(r.message);
    return 0;
  }
  if (cmd === 'config') {
    const { runConfig } = await import('../src/config-cli.js');
    return runConfig(rest, { json: opts.json });
  }
  if (cmd === 'setup') {
    const { runSetupCli } = await import('../src/setup.js');
    return runSetupCli();
  }
  if (cmd === 'install-hook' || cmd === 'uninstall-hook') {
    // Removing the guard is the user's call, not something an agent should do to itself.
    if (cmd === 'uninstall-hook' && underAgent()) {
      console.error('nuncius: uninstall-hook only works when you run it yourself, not from an agent.');
      return 2;
    }
    const m = await import('../src/hook-install.js');
    console.log((cmd === 'install-hook' ? m.installHook() : m.uninstallHook()).message);
    return 0;
  }
  if (cmd === 'cleanup') {
    const { cleanup } = await import('../src/cleanup.js');
    const actions = cleanup({ days: opts.days, dryRun: opts.dryRun });
    const { pruneOldContent } = await import('../src/retention.js');
    const pruned = pruneOldContent({ dryRun: opts.dryRun });
    if (pruned.tasks || pruned.runFiles || pruned.usageRecords)
      console.log(`${opts.dryRun ? 'would remove' : 'removed'} the content of tasks older than ${pruned.days} days: ${pruned.tasks} task record(s), ${pruned.runFiles} run file(s), and the prompt/error text of ${pruned.usageRecords} usage record(s) (their numbers stay)`);
    if (!actions.length && !pruned.tasks && !pruned.runFiles && !pruned.usageRecords) console.log('nothing to clean up');
    for (const a of actions) {
      if (a.kept) console.log(`kept ${displayName(a.path)} (${a.reason})`);
      else console.log(`${opts.dryRun ? 'would remove' : 'removed'} ${displayName(a.path)} (${a.reason})${a.branchDeleted ? `, deleted ${a.branch}` : `, kept branch ${a.branch}`}${a.savedCommit ? `, saved its unfinished work as ${a.savedCommit.slice(0, 12)}` : ''}`);
    }
    return 0;
  }
  if (cmd === 'mcp') {
    const { startMcpServer } = await import('../src/mcp.js');
    startMcpServer();
    return null; // keep running
  }
  if (cmd === '__worker') {
    await executeTask(rest[0]);
    return 0;
  }
  if (cmd === 'dashboard') {
    const { startServer } = await import('../src/server.js');
    const port = opts.port || loadConfig().dashboard.port;
    startServer(port);
    return null; // keep running
  }
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err) => {
    console.error(`nuncius: ${err.message}`);
    process.exitCode = 1;
  },
);
