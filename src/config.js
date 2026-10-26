import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from './settings.js';

// Every setting has one dotted name, used the same way in config.json, `nuncius config` and the README
// (e.g. budgets.cursor.maxRunsPerDay). src/settings.js describes each one for `nuncius config list`.
export const DEFAULT_CONFIG = {
  // Budgets: a task that would go over one is refused, with the reason. null means no cap.
  // Every tool has the same daily caps; Codex and Claude also have their subscription windows.
  budgets: {
    codex: {
      max5HourPercent: 90, // start no new task above this % of the 5-hour window
      maxWeeklyPercent: 80, // ... of the weekly window: lower, it takes days to reset
      maxTokensPerDay: null,
      maxRunsPerDay: null,
      maxAgentMinutesPerDay: null,
    },
    claude: {
      // Windows come from the statusline bridge (nuncius install-statusline); without it, the daily caps apply.
      max5HourPercent: 90,
      maxWeeklyPercent: 80,
      maxTokensPerDay: null,
      maxRunsPerDay: 100,
      maxAgentMinutesPerDay: null,
    },
    cursor: {
      // Cursor has no readable subscription window, so only the daily caps apply.
      maxTokensPerDay: null,
      maxRunsPerDay: 100,
      maxAgentMinutesPerDay: 180,
    },
    // Per project (keyed by project name), the same daily caps in the same shape:
    // { "myapp": { "cursor": { "maxRunsPerDay": 30 } } }. Still global settings: they live here.
    projects: {},
  },
  // Per tool. enabled: false hides an installed tool everywhere. bin: the CLI's name on PATH or a path.
  // models: offered when the CLI can't be asked. blockedModels: refused model ids (`*` at the end:
  // prefix). apiDomains: what the CLI itself must reach through the egress proxy (verified 2026-10).
  targets: {
    codex: { enabled: true, bin: 'codex', models: [], blockedModels: [], capabilities: ['code'], apiDomains: ['chatgpt.com', '*.chatgpt.com', 'api.openai.com', 'auth.openai.com'] },
    cursor: { enabled: true, bin: 'cursor-agent', models: [], blockedModels: [], capabilities: ['code'], apiDomains: ['cursor.sh', '*.cursor.sh', 'cursor.com', '*.cursor.com'] },
    claude: { enabled: true, bin: 'claude', models: ['opus', 'sonnet', 'fable', 'haiku'], blockedModels: [], capabilities: ['code'], apiDomains: ['api.anthropic.com'] },
  },
  // Extra hosts a task may reach when it asks for network (network: true / --network).
  network: {
    domains: [
      'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
      'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
      'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
    ],
  },
  // Optional names callers can use instead of a target: { "<name>": { "target": "codex" | "cursor" |
  // "claude" | "other", "model": "<id>" } }. None by default: which tools someone has differs per
  // person. "other" means any available target that is not the caller's own tool.
  aliases: {},
  concurrency: { perTarget: 2, total: 4, maxQueued: 20 },
  tasks: {
    syncWaitSeconds: 300, // run_task waits this long before handing back a task id
    timeoutSeconds: 1800, // a task is killed after this
    modelCacheSeconds: 3600,
  },
  // passEnv: extra environment variables a target may see (names, or prefixes ending in `*`).
  // extraDenyRead / extraReadable / extraWritable: absolute paths. Use extraWritable sparingly.
  // taskAccounts: run targets as separate macOS accounts (ADR 12; needs scripts/task-accounts/setup.sh once).
  sandbox: { passEnv: [], extraDenyRead: [], extraReadable: [], extraWritable: [], taskAccounts: false },
  // Applied worktrees are removed automatically; `nuncius cleanup` also removes unapplied ones older
  // than keepDays (their branch is kept).
  worktrees: { autoRemoveApplied: true, keepDays: 7 },
  // Days nuncius keeps prompts, answers, raw output and patches of finished tasks (src/retention.js).
  retention: { days: 7 },
  dashboard: { port: 7317 }, // not 4317: that is OpenTelemetry's OTLP port, often taken by a local collector
  // Nuncius's own bookkeeping for `nuncius install-statusline`; not a setting.
  claude: { statuslineCommand: null, statuslinePrevious: null },
};

// Names from before 2026-10-20, still read so existing files keep working: top-level codexBin /
// cursorBin / claudeBin, maxPrimaryPercent / maxSecondaryPercent, flat project caps such as
// cursorRunsPerDay, and dashboardPort. A new name in the same file wins over its old one.
export function upgradeLegacy(own) {
  if (!own || typeof own !== 'object' || Array.isArray(own)) return own;
  const out = structuredClone(own);
  const obj = (o, k) => (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : (o[k] = {}));
  const move = (from, fromKey, to, toKey) => {
    if (!Object.hasOwn(from, fromKey)) return;
    if (!Object.hasOwn(to, toKey)) to[toKey] = from[fromKey];
    delete from[fromKey];
  };
  for (const t of ['codex', 'cursor', 'claude']) {
    if (Object.hasOwn(out, `${t}Bin`)) move(out, `${t}Bin`, obj(obj(out, 'targets'), t), 'bin');
  }
  if (out.budgets && typeof out.budgets === 'object') {
    for (const t of ['codex', 'claude']) {
      const b = out.budgets[t];
      if (b && typeof b === 'object') {
        move(b, 'maxPrimaryPercent', b, 'max5HourPercent');
        move(b, 'maxSecondaryPercent', b, 'maxWeeklyPercent');
      }
    }
    const projects = out.budgets.projects;
    if (projects && typeof projects === 'object') {
      for (const p of Object.keys(projects)) {
        const caps = projects[p];
        if (!caps || typeof caps !== 'object') continue;
        for (const t of ['codex', 'claude', 'cursor']) {
          for (const [oldKey, newKey] of [['TokensPerDay', 'maxTokensPerDay'], ['RunsPerDay', 'maxRunsPerDay'], ['AgentMinutesPerDay', 'maxAgentMinutesPerDay']]) {
            if (Object.hasOwn(caps, `${t}${oldKey}`)) move(caps, `${t}${oldKey}`, obj(caps, t), newKey);
          }
        }
      }
    }
  }
  if (Object.hasOwn(out, 'dashboardPort')) move(out, 'dashboardPort', obj(out, 'dashboard'), 'port');
  return out;
}

// The task timeout in seconds. 0 or anything that is not a positive number falls back to the default:
// a task must always be able to end (spawn treats 0 as "no timeout").
export function taskTimeoutSeconds(config) {
  const t = config.tasks?.timeoutSeconds;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_CONFIG.tasks.timeoutSeconds;
}

export function dataDir() {
  return process.env.NUNCIUS_HOME || path.join(os.homedir(), '.nuncius');
}

export function usageLogPath() {
  return path.join(dataDir(), 'usage.jsonl');
}

export function runsDir() {
  return path.join(dataDir(), 'runs');
}

export function configPath() {
  return path.join(dataDir(), 'config.json');
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

// The file holds only what the user changed. It starts empty, so later releases can improve a default
// and everyone who never touched that setting gets the new one. `nuncius config` prints the effective
// settings (defaults merged with the file).
export function loadConfig() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = configPath();
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '{}\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  let own;
  try {
    own = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`${p} is not valid JSON (${err.message}). Fix the file, or move it away to start again from the defaults.`);
  }
  if (own !== null && (typeof own !== 'object' || Array.isArray(own)))
    throw new Error(`${p}: the top level must be a JSON object like { "budgets": { ... } }, not ${Array.isArray(own) ? 'an array' : typeof own}. Fix the file, or move it away to start again from the defaults.`);
  const upgraded = upgradeLegacy(own) ?? {};
  // A wrong-typed value must fail closed (the task is refused), never silently switch a budget off.
  const problems = validateConfig(upgraded);
  if (problems.length)
    throw new Error(`${p} has settings of the wrong kind:\n  - ${problems.join('\n  - ')}\nFix them in the file, or with the config command (unset puts a key back to its default).`);
  return merge(DEFAULT_CONFIG, upgraded);
}
