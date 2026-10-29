import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULT_CONFIG } from './config.js';
import { targetStatus, findBin, TOOL_NAMES as NAMES } from './targets.js';
import { setSetting, unsetSetting, getSetting, parseFor, spec, valuesOf, formatValue } from './settings.js';
import { statuslineInstalled, installStatusline } from './statusline.js';
import { hookInstalled, installHook } from './hook-install.js';
import { readJson, writeJson } from './claude-settings.js';
import { underAgent } from './tasks.js';

// `nuncius setup`: a short first-time walk-through. It finds the tools, asks for the budgets, and
// connects nuncius to the tools that can call it. Every step prints the command that does the same,
// so people learn how to change it later. The walk-through itself (runSetup) takes its input and
// output as functions, so it can be tested without a terminal.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGIN = { codex: 'codex login', cursor: 'cursor-agent login', claude: 'claude (then /login)' };

// How the tools should start nuncius's MCP server: `nuncius` when it is on PATH, else node + nuncius.js.
export function nunciusCommand() {
  return findBin('nuncius') ? ['nuncius', 'mcp'] : [process.execPath, path.join(ROOT, 'bin', 'nuncius.js'), 'mcp'];
}

const yes = (answer, dflt) => (answer.trim() === '' ? dflt : /^y(es)?$/i.test(answer.trim()));

export async function runSetup({ ask, say, sh = defaultSh, home = os.homedir() }) {
  const done = [];
  const command = (c) => {
    done.push(c);
    say(`  → ${c}`);
  };
  // Store a value only when it differs from the default; back to the default otherwise.
  const store = (key, value, dflt) => {
    if (value === dflt || (value === null && dflt === null)) {
      if (unsetSetting(key)) command(`nuncius config unset ${key}`);
      return;
    }
    setSetting(key, value === null ? 'none' : String(value));
    command(`nuncius config set ${key} ${value === null ? 'none' : value}`);
  };

  say('nuncius setup: a few questions to get nuncius going. Each step shows the command that does the same, so you can change it later.\n');

  // 1. Which tools nuncius may use.
  say('1. Your tools');
  const status = targetStatus(loadConfig());
  const use = [];
  for (const t of status) {
    if (!t.installed) {
      say(`  ${NAMES[t.name]}: not found (${loadConfig().targets[t.name].bin}). Install it and log in (${LOGIN[t.name]}), then run nuncius setup again;`);
      say(`    installed somewhere else? nuncius config set targets.${t.name}.bin /path/to/${loadConfig().targets[t.name].bin}`);
      continue;
    }
    const on = yes(await ask(`  ${NAMES[t.name]} found at ${t.bin}. Let nuncius use it? [Y/n] `), true);
    store(`targets.${t.name}.enabled`, on, true);
    if (on) use.push(t.name);
  }
  if (!use.length) {
    say('\nNo tool to delegate to yet. Install Codex, Cursor or Claude, log in, and run nuncius setup again.');
    return done;
  }

  // 2. Budgets for the tools in use: a task that would go over one is refused, with the reason.
  say('\n2. Budgets: nuncius checks them before it starts a task (a running task is not stopped by them).');
  // Each question shows what can be entered (from the setting itself) and checks the answer the same
  // way `nuncius config set` would, so a 0 that means "no limit" gets the same explanation.
  const askSetting = async (key, question) => {
    const current = getSetting(key).value;
    for (;;) {
      const a = (await ask(`${question}\n    Enter = ${formatValue(current)} · ${valuesOf(spec(key))}\n    > `)).trim();
      if (a === '') return current;
      try {
        return parseFor(key, a);
      } catch (err) {
        say(`    ${err.message.split('\n').join('\n    ')}`);
      }
    }
  };
  for (const t of use) {
    const d = DEFAULT_CONFIG.budgets[t];
    if (t === 'codex' || t === 'claude') {
      const k5 = `budgets.${t}.max5HourPercent`;
      const kw = `budgets.${t}.maxWeeklyPercent`;
      store(k5, await askSetting(k5, `  ${NAMES[t]}, 5-hour window (resets within hours): start no new task above what %?`), d.max5HourPercent);
      store(kw, await askSetting(kw, `  ${NAMES[t]}, weekly window (resets after days, so keep room for your own work): start no new task above what %?`), d.maxWeeklyPercent);
    }
    const kr = `budgets.${t}.maxRunsPerDay`;
    store(kr, await askSetting(kr, `  ${NAMES[t]}: at most how many tasks per day?`), d.maxRunsPerDay);
    if (t === 'cursor') {
      const km = 'budgets.cursor.maxAgentMinutesPerDay';
      store(km, await askSetting(km, '  Cursor: at most how many minutes of run time per day, all Cursor tasks together?'), d.maxAgentMinutesPerDay);
    }
  }

  // 3. Connect nuncius to the tools that can call it (as an MCP server).
  say('\n3. Let your tools use nuncius (MCP)');
  const mcp = nunciusCommand();
  if (status.find((t) => t.name === 'claude')?.installed) {
    if (sh('claude', ['mcp', 'get', 'nuncius']).status === 0) say('  Claude Code: already connected.');
    else if (yes(await ask('  Connect Claude Code to nuncius (all your projects)? [Y/n] '), true)) {
      const args = ['mcp', 'add', '--scope', 'user', 'nuncius', '--', ...mcp];
      const r = sh('claude', args);
      if (r.status === 0) command(`claude ${args.join(' ')}`);
      else say(`  That did not work: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    }
  }
  if (status.find((t) => t.name === 'codex')?.installed) {
    if (sh('codex', ['mcp', 'get', 'nuncius']).status === 0) say('  Codex: already connected.');
    else if (yes(await ask('  Connect Codex to nuncius? [Y/n] '), true)) {
      const args = ['mcp', 'add', 'nuncius', '--', ...mcp];
      const r = sh('codex', args);
      if (r.status === 0) command(`codex ${args.join(' ')}`);
      else say(`  That did not work: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    }
  }
  if (status.find((t) => t.name === 'cursor')?.installed) {
    const file = path.join(home, '.cursor', 'mcp.json');
    let current;
    try {
      current = readJson(file, {});
    } catch {
      current = null;
    }
    if (current === null) say(`  Cursor: ${file} is not valid JSON; add nuncius there yourself: "nuncius": { "command": "${mcp[0]}", "args": ${JSON.stringify(mcp.slice(1))} }`);
    else if (current.mcpServers?.['nuncius']) say('  Cursor: already connected.');
    else if (yes(await ask('  Connect Cursor to nuncius? [Y/n] '), true)) {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.nuncius-backup`);
      writeJson(file, { ...current, mcpServers: { ...(current.mcpServers ?? {}), 'nuncius': { command: mcp[0], args: mcp.slice(1) } } });
      command(`added "nuncius" to ${file} (backup: mcp.json.nuncius-backup)`);
    }
  }

  // 4. Claude Code extras.
  if (status.find((t) => t.name === 'claude')?.installed) {
    say('\n4. Claude Code extras');
    if (!use.includes('claude')) say('  Claude limits: not needed, nuncius does not run Claude tasks.');
    else if (statuslineInstalled()) say('  Claude limits: already recorded through your statusline.');
    else if (yes(await ask("  Record Claude's 5-hour and weekly limits through the Claude Code statusline? [Y/n] "), true)) {
      installStatusline();
      command('nuncius install-statusline');
    }
    const skill = path.join(home, '.claude', 'skills', 'nuncius');
    if (fs.existsSync(skill)) say('  Delegation skill: already installed.');
    else if (yes(await ask('  Install the skill that teaches Claude how to delegate with nuncius? [Y/n] '), true)) {
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      fs.symlinkSync(path.join(ROOT, 'skills', 'nuncius'), skill);
      command(`ln -s ${path.join(ROOT, 'skills', 'nuncius')} ${skill}`);
    }
    if (hookInstalled()) say('  Hook: already installed.');
    else if (yes(await ask('  When Claude starts Codex, Cursor or claude -p itself, send it through nuncius too (optional hook)? [y/N] '), false)) {
      installHook();
      command('nuncius install-hook');
    }
  }

  say(`\nDone.${done.length ? ' What changed:' : ' Nothing needed changing.'}`);
  for (const c of done) say(`  ${c}`);
  say('\nLater: nuncius status (what nuncius sees) · nuncius config (all settings) · nuncius config set <key> <value> · nuncius dashboard');
  return done;
}

function defaultSh(cmd, args) {
  const bin = findBin(cmd);
  if (!bin) return { status: 127, stdout: '', stderr: `${cmd} not found` };
  return spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 });
}

// The command: a person at a terminal only (the answers change budgets and what nuncius may run).
export async function runSetupCli() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('nuncius setup asks questions, so it needs a terminal. Run it yourself in one.');
    return 2;
  }
  if (underAgent()) {
    console.error('nuncius setup only works when you run it yourself, not from an agent (Claude Code, Codex, Cursor).');
    return 2;
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runSetup({ ask: (q) => rl.question(q), say: (s) => console.log(s) });
  } finally {
    rl.close();
  }
  return 0;
}
