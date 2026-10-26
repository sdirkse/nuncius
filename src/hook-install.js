import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSettingsPath, readJson, writeJson, shQuote, stableNode } from './claude-settings.js';

// ADR 10: `nuncius install-hook` adds hooks/require-nuncius.js as a Claude Code PreToolUse hook on Bash,
// so agents cannot run codex / cursor-agent / claude -p directly (unlogged, unbudgeted) or pass
// --force to nuncius. Opt-in; `nuncius uninstall-hook` removes exactly what it added.

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'require-nuncius.js');
export const hookCommand = () => `${shQuote(stableNode())} ${shQuote(HOOK)}`;
const isOurs = (h) => h?.type === 'command' && typeof h.command === 'string' && (h.command === hookCommand() || h.command.includes(HOOK));

function groups(settings) {
  const list = settings.hooks?.PreToolUse;
  return Array.isArray(list) ? list : [];
}

export function hookInstalled() {
  try {
    return groups(readJson(claudeSettingsPath(), {})).some((g) => (g.hooks ?? []).some(isOurs));
  } catch {
    return false;
  }
}

export function installHook() {
  const p = claudeSettingsPath();
  const settings = readJson(p, {});
  const existing = groups(settings).flatMap((g) => g.hooks ?? []).filter(isOurs);
  if (existing.length) {
    // Installed by an older nuncius (e.g. with a node path that has since moved): refresh the command only.
    if (existing.every((h) => h.command === hookCommand())) return { changed: false, message: `already installed in ${p}` };
    for (const h of existing) h.command = hookCommand();
    writeJson(p, settings);
    return { changed: true, message: `updated the hook command in ${p}` };
  }
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.nuncius-hook-backup`);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  settings.hooks.PreToolUse = [...groups(settings), { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand() }] }];
  writeJson(p, settings);
  return {
    changed: true,
    message: `PreToolUse hook added to ${p}: when Claude starts codex / cursor-agent / claude -p itself in Bash, it is told to use nuncius instead, and \`nuncius --force\` is left to you. Claude's own work is not affected. Backup: ${p}.nuncius-hook-backup. Restart Claude Code sessions to load it.`,
  };
}

export function uninstallHook() {
  const p = claudeSettingsPath();
  const settings = readJson(p, {});
  const before = groups(settings);
  if (!before.some((g) => (g.hooks ?? []).some(isOurs))) return { changed: false, message: 'not installed' };
  // Remove only our entry; groups that held nothing else go too, other hooks stay as they were.
  const after = before
    .map((g) => ((g.hooks ?? []).some(isOurs) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
  if (after.length) settings.hooks.PreToolUse = after;
  else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJson(p, settings);
  return { changed: true, message: `removed the nuncius hook from ${p}` };
}
