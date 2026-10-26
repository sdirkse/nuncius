import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig } from './config.js';
import { limitsFromStatusline, writeClaudeLimits, writeBridgeSeen } from './claude-limits.js';
import { claudeSettingsPath, readJson, writeJson, shQuote, stableNode } from './claude-settings.js';

// ADR 6: the statusline bridge. Claude Code feeds the statusline command a JSON object that, for
// Pro/Max accounts, includes rate_limits. `nuncius statusline` records them and then hands the same
// input to whatever statusline the user had before, so their statusline keeps working unchanged.

const NUNCIUS_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuncius.js');
export const bridgeCommand = () => `${shQuote(stableNode())} ${shQuote(NUNCIUS_BIN)} statusline`;
const isBridge = (cmd) => typeof cmd === 'string' && cmd.includes(NUNCIUS_BIN) && cmd.trim().endsWith('statusline');

function pct(w) {
  return w ? `${Math.round(w.usedPercent)}%` : '?';
}

export async function runStatusline() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    // keep going: the statusline must always print something
  }
  let limits = null;
  try {
    limits = limitsFromStatusline(input);
    if (limits) writeClaudeLimits(limits);
    // So nuncius can tell "never ran" from "ran, but Claude Code sent no limits" (API-key login, or
    // before the session's first reply). Only a time and a yes/no, nothing from the session.
    writeBridgeSeen({ at: new Date().toISOString(), rateLimits: !!limits });
  } catch {
    // never break the user's statusline over a write error
  }
  const previous = loadConfig().claude?.statuslineCommand;
  if (previous && !isBridge(previous)) {
    const r = spawnSync('/bin/sh', ['-c', previous], { input: raw, encoding: 'utf8', timeout: 5000 });
    process.stdout.write(r.stdout ?? '');
    return;
  }
  const model = input?.model?.display_name ?? input?.model?.id ?? 'Claude';
  process.stdout.write(limits ? `${model} · 5h ${pct(limits.primary)} · week ${pct(limits.secondary)}` : model);
}

function setNunciusConfig(key, value) {
  loadConfig(); // creates the (empty) file if needed
  const cfg = readJson(configPath(), {});
  cfg.claude = { ...(cfg.claude ?? {}), [key]: value };
  writeJson(configPath(), cfg);
}

export function installStatusline() {
  const p = claudeSettingsPath();
  const settings = readJson(p, {});
  const current = settings.statusLine;
  if (isBridge(current?.command)) {
    // Installed by an older nuncius (e.g. with a node path that has since moved): refresh the command only.
    if (current.command === bridgeCommand()) return { changed: false, message: 'already installed' };
    settings.statusLine = { ...current, command: bridgeCommand() };
    writeJson(p, settings);
    return { changed: true, message: `updated the bridge command in ${p}: ${bridgeCommand()}` };
  }
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.nuncius-backup`);
  setNunciusConfig('statuslineCommand', current?.type === 'command' ? current.command : null);
  setNunciusConfig('statuslinePrevious', current ?? null);
  settings.statusLine = { ...(current ?? {}), type: 'command', command: bridgeCommand() };
  writeJson(p, settings);
  return {
    changed: true,
    message: `statusLine in ${p} now runs the nuncius bridge${current?.command ? `, which passes input on to your previous command: ${current.command}` : ''}. Backup: ${p}.nuncius-backup`,
  };
}

export function uninstallStatusline() {
  const p = claudeSettingsPath();
  const settings = readJson(p, {});
  if (!isBridge(settings.statusLine?.command)) return { changed: false, message: 'not installed' };
  const previous = loadConfig().claude?.statuslinePrevious ?? null;
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  writeJson(p, settings);
  setNunciusConfig('statuslineCommand', null);
  setNunciusConfig('statuslinePrevious', null);
  return { changed: true, message: previous ? `restored your previous statusLine in ${p}` : `removed statusLine from ${p}` };
}

export function statuslineInstalled() {
  try {
    return isBridge(readJson(claudeSettingsPath(), {}).statusLine?.command);
  } catch {
    return false;
  }
}
