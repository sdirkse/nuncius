import { configPath, loadConfig } from './config.js';
import { listSettings, getSetting, setSetting, unsetSetting, changeList, formatValue, valuesOf, spec } from './settings.js';
import { underAgent } from './tasks.js';

// `nuncius config ...`: read and change settings without editing config.json by hand.

export const CONFIG_HELP = `nuncius config — show and change nuncius's settings (stored in ~/.nuncius/config.json)

  nuncius config                        every setting: value, default, what it does
  nuncius config list [filter]          the same, only keys containing <filter> (e.g. budgets, cursor)
  nuncius config get <key>              one setting
  nuncius config set <key> <value>      change a setting (lists: comma-separated)
  nuncius config add <key> <item>...    add items to a list setting
  nuncius config remove <key> <item>... remove items from a list setting
  nuncius config unset <key>            back to the default
  nuncius config --json                 the effective settings as JSON

Values: numbers, true/false, text, or "none" to switch a limit off.

Examples:
  nuncius config set budgets.cursor.maxRunsPerDay 50
  nuncius config set budgets.codex.max5HourPercent 70
  nuncius config set budgets.projects.myapp.claude.maxTokensPerDay 2000000
  nuncius config set targets.claude.enabled false
  nuncius config set aliases.review.target other
  nuncius config add sandbox.passEnv NPM_TOKEN
  nuncius config unset budgets.cursor.maxRunsPerDay`;

// Changing settings (budgets, sandbox, enabled tools) is the user's call; agents may read them.
function refuseUnderAgent(what) {
  if (!underAgent()) return null;
  return `nuncius: ${what} only works when you run it yourself, not from an agent (Claude Code, Codex, Cursor). Ask the user to run it in their own terminal.`;
}

function table(rows) {
  if (!rows.length) return 'no settings match';
  const w = Math.min(48, Math.max(...rows.map((r) => r.key.length)));
  let section = '';
  const out = [];
  for (const r of rows) {
    const top = r.key.split('.').slice(0, r.key.startsWith('budgets.') || r.key.startsWith('targets.') ? 2 : 1).join('.');
    if (top !== section) {
      section = top;
      out.push(`\n${section}`);
    }
    const value = formatValue(r.value);
    const def = r.changed ? `  (default: ${formatValue(r.default)})` : '';
    const pad = ' '.repeat(w);
    out.push(`  ${r.key.padEnd(w)}  ${value}${def}\n  ${pad}  ${r.description}\n  ${pad}  values: ${valuesOf(r)}`);
  }
  return `${out.join('\n').trim()}\n\nChange one with: nuncius config set <key> <value>   (only your changes are stored, in ${configPath()})`;
}

export function runConfig(args, { json = false } = {}) {
  const [sub, key, ...rest] = args;
  const print = (s) => console.log(s);
  if (json) {
    print(JSON.stringify(loadConfig(), null, 2));
    return 0;
  }
  if (!sub || sub === 'list') {
    const filter = (key ?? '').toLowerCase();
    print(table(listSettings().filter((r) => !filter || r.key.toLowerCase().includes(filter))));
    return 0;
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    print(CONFIG_HELP);
    return 0;
  }
  if (!['get', 'set', 'unset', 'add', 'remove'].includes(sub)) {
    console.error(`nuncius config: unknown command "${sub}"\n\n${CONFIG_HELP}`);
    return 2;
  }
  if (!key) {
    console.error(`nuncius config ${sub}: which setting? See: nuncius config list`);
    return 2;
  }
  try {
    if (sub === 'get') {
      const r = getSetting(key);
      print(`${r.key} = ${formatValue(r.value)}${r.changed ? `  (default: ${formatValue(r.default)})` : '  (default)'}\n${r.description}\nvalues: ${valuesOf(r)}`);
      return 0;
    }
    const refused = refuseUnderAgent(`nuncius config ${sub}`);
    if (refused) {
      console.error(refused);
      return 2;
    }
    if (sub === 'unset') {
      const removed = unsetSetting(key);
      const s = spec(key);
      print(removed ? `${key} is back to the default${s ? `: ${formatValue(getSetting(key).value)}` : ''}` : `${key} was not set; nothing changed`);
      return 0;
    }
    if (sub === 'set') {
      if (!rest.length) {
        const s = spec(key);
        console.error(`nuncius config set ${key}: which value?${s ? ` Expected ${valuesOf(s)}.` : ''}`);
        return 2;
      }
      const value = setSetting(key, rest.join(' '));
      print(`${key} = ${formatValue(value)}`);
      return 0;
    }
    if (!rest.length) {
      console.error(`nuncius config ${sub} ${key}: which items?`);
      return 2;
    }
    const value = changeList(key, rest, { remove: sub === 'remove' });
    print(`${key} = ${formatValue(value)}`);
    return 0;
  } catch (err) {
    console.error(`nuncius config: ${err.message}`);
    return 2;
  }
}
