import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, configPath, dataDir, loadConfig, upgradeLegacy } from './config.js';

// Every setting nuncius knows, with its type and meaning: what `nuncius config` lists, validates and
// writes. Keys are the dotted paths of config.json, so the file, the CLI and the README use one name.

const TOOLS = ['codex', 'claude', 'cursor'];
const NAMES = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };

// Value types. parse(text, spec) turns command-line text into the stored value or throws with a reason.
// `values` says what may be entered, including what 0 and none mean where they mean something; it is
// shown by nuncius config and nuncius setup. A 0 that can only be a mistake is refused with what was
// probably meant (no limit, or switching the tool off).
const NONE = /^(null|none|off|-)$/i;
const TYPES = {
  cap: { values: 'a whole number of 1 or more · none = no limit', parse: (v, s) => (NONE.test(v) ? null : int(v, 0) || zero(s)) },
  percent: { values: '1 to 100 · none = no limit (tasks may use the whole window)', parse: (v, s) => (NONE.test(v) ? null : num(v, 0, 100) || zero(s)) },
  count: { values: 'a whole number of 1 or more', parse: (v) => int(v, 1) },
  timeout: { values: 'seconds, 1 or more (a task must be able to end)', parse: (v) => int(v, 1) },
  wait: { values: '0 to 600 seconds · 0 = return the task id at once', parse: (v) => int(v, 0, 600) },
  seconds: { values: 'a whole number of seconds', parse: (v) => int(v, 0) },
  days: { values: 'a whole number of days', parse: (v) => int(v, 0) },
  retention: { values: 'days · 0 = remove it as soon as a task ends · none = keep everything', parse: (v) => (NONE.test(v) ? null : int(v, 0)) },
  port: { values: 'a port number from 1 to 65535', parse: (v) => int(v, 1, 65535) },
  bool: {
    values: 'true or false',
    parse: (v) => {
      if (/^(true|yes|on|1)$/i.test(v)) return true;
      if (/^(false|no|off|0)$/i.test(v)) return false;
      throw new Error('expected true or false');
    },
  },
  text: { values: 'text', parse: (v) => (v.trim() ? v.trim() : fail('expected some text')) },
  optionalText: { values: 'text · none = the tool\'s default', parse: (v) => (NONE.test(v) ? null : v.trim() || null) },
  target: { values: 'codex, cursor, claude, or other (any tool but the caller\'s own)', parse: (v) => (['codex', 'cursor', 'claude', 'other'].includes(v) ? v : fail('expected codex, cursor, claude or other')) },
  list: { values: 'a comma-separated list · none = empty', list: true, item: (v) => v },
  envList: { values: 'variable names or prefixes ending in *, comma-separated · none = empty', list: true, item: (v) => (/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(v) ? v : fail(`not a variable name: ${v}`)) },
  domainList: { values: 'host names (a leading *. matches subdomains), comma-separated', list: true, item: (v) => (/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) ? v.toLowerCase() : fail(`not a host name: ${v}`)) },
  pathList: { values: 'absolute paths, comma-separated · none = empty', list: true, item: (v) => (path.isAbsolute(v) ? v : fail(`not an absolute path: ${v}`)) },
  modelList: { values: 'model ids (a trailing * matches a prefix), comma-separated · none = empty', list: true, item: (v) => (/^[\w.:\-/*]+$/.test(v) ? v : fail(`not a model id: ${v}`)) },
};
function fail(msg) {
  throw new Error(msg);
}

// A 0 budget would refuse every task: almost always someone meaning "no limit". Say so, with the
// commands for what they probably wanted. (The message replaces the usual "expected ..." text.)
function zero(s) {
  const name = NAMES[s.tool];
  const what = s.type === 'percent' ? `0% would let no ${name} task start` : `0 would refuse every ${name} task`;
  const lines = [`${what}${s.project ? ` in project ${s.project}` : ''}.`, `  No limit?  nuncius config set ${s.key} none`];
  if (!s.project) lines.push(`  Not use ${name} at all?  nuncius config set targets.${s.tool}.enabled false`);
  throw Object.assign(new Error(lines.join('\n')), { complete: true });
}
function int(v, min, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(v.trim())) throw new Error(`expected a whole number, got "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw new Error(`expected a number from ${min} to ${max}`);
  return n;
}
function num(v, min, max) {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < min || n > max) throw new Error(`expected a number from ${min} to ${max}, got "${v}"`);
  return n;
}
const parseList = (type, v) => (NONE.test(v.trim()) || v.trim() === '' ? [] : [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean).map(type.item))]);

const DAILY = {
  maxTokensPerDay: 'tokens per day (input + output)',
  maxRunsPerDay: 'tasks per day',
  maxAgentMinutesPerDay: 'minutes of task run time per day',
};

// Fixed keys: [key, type, description]. Pattern keys (per project, per alias) are matched in spec().
const FIXED = [
  ...['codex', 'claude'].flatMap((t) => [
    [`budgets.${t}.max5HourPercent`, 'percent', `start no new ${NAMES[t]} task above this % of the 5-hour window (resets within hours)`, { tool: t }],
    [`budgets.${t}.maxWeeklyPercent`, 'percent', `start no new ${NAMES[t]} task above this % of the weekly window (resets after days: keep room for your own work)`, { tool: t }],
  ]),
  ...TOOLS.flatMap((t) => Object.entries(DAILY).map(([k, d]) => [`budgets.${t}.${k}`, 'cap', `${NAMES[t]}: ${d}, all projects together`, { tool: t }])),
  ...TOOLS.flatMap((t) => [
    [`targets.${t}.enabled`, 'bool', `offer and run ${NAMES[t]} (false hides it even when installed)`],
    [`targets.${t}.bin`, 'text', `${NAMES[t]}'s CLI: a name on PATH or an absolute path`],
    [`targets.${t}.blockedModels`, 'modelList', `${NAMES[t]} models nuncius refuses to run`],
    [`targets.${t}.models`, 'list', `${NAMES[t]} models to offer when the CLI can't be asked`],
    [`targets.${t}.apiDomains`, 'domainList', `hosts ${NAMES[t]}'s CLI itself must reach (change only if a CLI update needs a new one)`],
  ]),
  ['network.domains', 'domainList', 'extra hosts a task may reach when it asks for network'],
  ['concurrency.perTarget', 'count', 'tasks running at once per tool'],
  ['concurrency.total', 'count', 'tasks running at once overall'],
  ['concurrency.maxQueued', 'count', 'tasks waiting in the queue at most; a submit beyond that is refused'],
  ['tasks.timeoutSeconds', 'timeout', 'stop a task (and everything it started) after this'],
  ['tasks.syncWaitSeconds', 'wait', 'how long run_task waits before returning the task id'],
  ['tasks.modelCacheSeconds', 'seconds', 'how long discovered model lists are reused', { values: 'seconds · 0 = ask the CLIs every time' }],
  ['sandbox.passEnv', 'envList', 'extra environment variables a target may see'],
  ['sandbox.extraDenyRead', 'pathList', 'extra paths targets may not read'],
  ['sandbox.extraReadable', 'pathList', 'extra paths in your home folder targets may read (the rest of it is closed, apart from toolchains and the task\'s own files)'],
  ['sandbox.taskAccounts', 'bool', 'run Codex and Claude tasks as separate macOS accounts as well as in the sandbox (needs scripts/task-accounts/setup.sh once, with sudo, and a claude setup-token in the keychain; Cursor keeps running as you in the sandbox; tasks are refused when the accounts are not ready)'],
  ['sandbox.extraWritable', 'pathList', 'extra paths targets may write (every task!)'],
  ['worktrees.autoRemoveApplied', 'bool', 'remove a worktree once its work is in your branch'],
  ['retention.days', 'retention', 'how long nuncius keeps the prompts, answers, raw output and patches of finished tasks (the usage numbers stay; a task with an open worktree keeps everything)'],
  ['worktrees.keepDays', 'days', 'nuncius cleanup removes unapplied worktrees older than this (their branch stays)', { values: 'days · 0 = nuncius cleanup removes every unapplied worktree' }],
  ['dashboard.port', 'port', 'port of nuncius dashboard'],
].map(([key, type, description, extra = {}]) => ({ key, type, description, ...extra }));
const FIXED_BY_KEY = new Map(FIXED.map((s) => [s.key, s]));

const NAME_RE = /^[\w.@+-]{1,64}$/;

// The setting a key names, or null. Project and alias names may contain dots, so those keys are
// read from both ends: budgets.projects.<name>.<tool>.<cap> and aliases.<name>.<target|model>.
export function spec(key) {
  if (typeof key !== 'string') return null;
  if (FIXED_BY_KEY.has(key)) return FIXED_BY_KEY.get(key);
  const parts = key.split('.');
  if (key.startsWith('budgets.projects.') && parts.length >= 5) {
    const [tool, cap] = parts.slice(-2);
    const project = parts.slice(2, -2).join('.');
    if (TOOLS.includes(tool) && DAILY[cap] && NAME_RE.test(project))
      return { key, type: 'cap', description: `project ${project}, ${NAMES[tool]}: ${DAILY[cap]}`, path: ['budgets', 'projects', project, tool, cap], tool, project };
  }
  if (key.startsWith('aliases.') && parts.length >= 3) {
    const field = parts.at(-1);
    const name = parts.slice(1, -1).join('.');
    if (NAME_RE.test(name) && field === 'target') return { key, type: 'target', description: `tool the alias ${name} runs (other: any tool but the caller's own)`, path: ['aliases', name, 'target'] };
    if (NAME_RE.test(name) && field === 'model') return { key, type: 'optionalText', description: `model the alias ${name} uses (none: the tool's default)`, path: ['aliases', name, 'model'] };
  }
  return null;
}
const pathOf = (s) => s.path ?? s.key.split('.');

// Closest known keys, for "did you mean" on a typo.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function suggest(key) {
  const k = String(key ?? '').toLowerCase();
  return FIXED.map((s) => ({ key: s.key, d: distance(k, s.key.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(k.length / 4)) || x.key.toLowerCase().endsWith(k.split('.').at(-1)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.key);
}

function unknown(key) {
  const close = suggest(key);
  return new Error(`unknown setting "${key}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} See all with: nuncius config list`);
}

const at = (o, keys) => keys.reduce((x, k) => (x && typeof x === 'object' && Object.hasOwn(x, k) ? x[k] : undefined), o);

// The user's own file (only what they changed), with old names upgraded.
function readOwn() {
  try {
    return upgradeLegacy(JSON.parse(fs.readFileSync(configPath(), 'utf8'))) ?? {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${configPath()} is not valid JSON (${err.message}). Fix the file first.`);
  }
}

function writeOwn(own) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(own, null, 2)}\n`);
  fs.renameSync(tmp, configPath());
}

export function getSetting(key) {
  const s = spec(key);
  if (!s) throw unknown(key);
  const own = at(readOwn(), pathOf(s));
  const fallback = at(DEFAULT_CONFIG, pathOf(s));
  return { ...s, value: own !== undefined ? own : (fallback ?? null), default: fallback ?? null, changed: own !== undefined };
}

// Parse and store one value. Returns the stored value.
export function setSetting(key, raw) {
  const s = spec(key);
  if (!s) throw unknown(key);
  const type = TYPES[s.type];
  let value;
  try {
    value = type.list ? parseList(type, String(raw)) : type.parse(String(raw), s);
  } catch (err) {
    throw new Error(err.complete ? err.message : `${key}: ${err.message} (expected ${valuesOf(s)})`);
  }
  const own = readOwn();
  const keys = pathOf(s);
  let o = own;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
  // An alias needs a target; a model alone would point nowhere.
  if (keys[0] === 'aliases' && !own.aliases[keys[1]].target) throw new Error(`set the alias's tool first: nuncius config set aliases.${keys[1]}.target <codex|cursor|claude|other>`);
  writeOwn(own);
  return value;
}

// Add or remove items of a list setting.
export function changeList(key, items, { remove = false } = {}) {
  const s = spec(key);
  if (!s) throw unknown(key);
  const type = TYPES[s.type];
  if (!type.list) throw new Error(`${key} is not a list; use: nuncius config set ${key} <value>`);
  const given = parseList(type, items.join(','));
  const current = getSetting(key).value ?? [];
  const next = remove ? current.filter((x) => !given.includes(x)) : [...new Set([...current, ...given])];
  return setSetting(key, next.length ? next.join(',') : 'none');
}

// Back to the default: the key leaves the file (and so do objects it leaves empty).
export function unsetSetting(key) {
  const s = spec(key) ?? (key.startsWith('aliases.') && key.split('.').length === 2 ? { key, path: ['aliases', key.slice(8)] } : null);
  if (!s) throw unknown(key);
  const own = readOwn();
  const keys = pathOf(s);
  const trail = [own];
  for (const k of keys.slice(0, -1)) {
    const next = trail.at(-1)?.[k];
    if (!next || typeof next !== 'object') return false;
    trail.push(next);
  }
  if (!Object.hasOwn(trail.at(-1), keys.at(-1))) return false;
  delete trail.at(-1)[keys.at(-1)];
  for (let i = trail.length - 1; i > 0; i--) if (!Object.keys(trail[i]).length) delete trail[i - 1][keys[i - 1]];
  writeOwn(own);
  return true;
}

// Every setting with its current value, the default and whether the user changed it, including
// each project cap and alias present in the file.
export function listSettings() {
  const own = readOwn();
  const keys = FIXED.map((s) => s.key);
  for (const [project, caps] of Object.entries(own.budgets?.projects ?? {}))
    for (const t of TOOLS) for (const c of Object.keys(DAILY)) if (caps?.[t]?.[c] !== undefined) keys.push(`budgets.projects.${project}.${t}.${c}`);
  for (const [name, a] of Object.entries(own.aliases ?? {})) {
    keys.push(`aliases.${name}.target`);
    if (a?.model !== undefined) keys.push(`aliases.${name}.model`);
  }
  return keys.map(getSetting);
}

export const formatValue = (v) => (v === null || v === undefined ? 'none' : Array.isArray(v) ? (v.length ? v.join(', ') : '(empty)') : String(v));
// What may be entered for a setting, including what 0 and none mean (where they mean something).
export const valuesOf = (s) => s.values ?? TYPES[s.type].values;

// Parse a value for a setting without storing it (nuncius setup checks answers this way).
export function parseFor(key, raw) {
  const s = spec(key);
  if (!s) throw unknown(key);
  const type = TYPES[s.type];
  return type.list ? parseList(type, String(raw)) : type.parse(String(raw), s);
}

// --- Validation of a hand-edited config.json ---------------------------------------------------
// loadConfig() calls this so a wrong-typed value fails closed (the task is refused with a clear
// message) instead of silently disabling a budget. It checks only the types of keys nuncius knows;
// unknown keys are left alone (they may be internal or from a newer release).

// Every dotted prefix of a known key is a container that must hold an object (so `budgets: "none"`
// is caught, not silently treated as "no budgets").
const CONTAINERS = new Set(['budgets.projects', 'aliases']);
for (const s of FIXED) {
  const parts = s.key.split('.');
  for (let i = 1; i < parts.length; i++) CONTAINERS.add(parts.slice(0, i).join('.'));
}

// A number in range. The CLI writes whole numbers, but a hand-edited fractional value is still a
// number and still honoured, so validation checks type and range, not integer-ness: what it must
// catch is a wrong *kind* (a string or object) silently switching a budget off.
const numIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// True when `value` is a valid stored value for a setting of this type.
function validType(type, value) {
  switch (type) {
    case 'cap': return value === null || numIn(value, 1, Number.MAX_SAFE_INTEGER);
    case 'percent': return value === null || numIn(value, 1, 100);
    case 'count': return numIn(value, 1, Number.MAX_SAFE_INTEGER);
    case 'timeout': return numIn(value, 0.001, Number.MAX_SAFE_INTEGER);
    case 'wait': return numIn(value, 0, 600);
    case 'seconds': case 'days': return numIn(value, 0, Number.MAX_SAFE_INTEGER);
    case 'retention': return value === null || numIn(value, 0, Number.MAX_SAFE_INTEGER);
    case 'port': return numIn(value, 1, 65535);
    case 'bool': return typeof value === 'boolean';
    case 'text': return typeof value === 'string' && value.trim() !== '';
    case 'optionalText': return value === null || typeof value === 'string';
    case 'target': return ['codex', 'cursor', 'claude', 'other'].includes(value);
    default: return isStrArray(value); // the list types
  }
}

function walkValidate(node, prefix, problems) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const s = spec(key);
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    if (s) {
      const listType = TYPES[s.type].list;
      if (isObj && !listType) problems.push(`${key}: expected ${valuesOf(s)}, got an object`);
      else if (!validType(s.type, v)) problems.push(`${key}: expected ${valuesOf(s)}, got ${JSON.stringify(v)}`);
    } else if (isObj) {
      walkValidate(v, key, problems);
    } else if (CONTAINERS.has(key)) {
      problems.push(`${key}: expected a group of settings (an object), got ${JSON.stringify(v)}`);
    } else if (key.startsWith('budgets.projects.') || key.startsWith('aliases.')) {
      // Everything under these two is nuncius's own: a wrong shape here (a project set to "none", a
      // misspelt cap, a project name nuncius cannot match) would otherwise silently drop a budget.
      problems.push(`${key}: not a setting nuncius knows (project budgets are budgets.projects.<project>.<codex|cursor|claude>.<${Object.keys(DAILY).join('|')}>; aliases are aliases.<name>.target and .model), got ${JSON.stringify(v)}`);
    }
    // else: a leaf nuncius does not know (internal or newer release) — left alone.
  }
}

// Returns a list of human-readable problems with the user's own config (empty = fine).
export function validateConfig(own) {
  const problems = [];
  walkValidate(own, '', problems);
  return problems;
}
