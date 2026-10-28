import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { spawn } from 'node:child_process';
import { run } from './spawn.js';
import { runCodex } from './runners/codex.js';
import { runCursor } from './runners/cursor.js';
import { runClaude } from './runners/claude.js';

export const TARGETS = {
  codex: { run: runCodex },
  cursor: { run: runCursor },
  claude: { run: runClaude },
};

// How each tool is named to people.
export const TOOL_NAMES = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude' };

// Own keys only: names like "constructor" or "__proto__" must never pass as a target.
export const isTarget = (name) => typeof name === 'string' && Object.hasOwn(TARGETS, name);

export const targetBin = (target, config) => config.targets?.[target]?.bin;

// Resolve a binary like a shell would, without running it.
export function findBin(bin) {
  const executable = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!bin) return null;
  if (bin.includes('/')) return executable(bin) ? bin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (dir && executable(p)) return p;
  }
  return null;
}

// Which targets this user has: a CLI that is installed (on PATH, or at the configured path) and not
// switched off with targets.<name>.enabled: false. Everything that offers targets goes through this,
// so someone with only Codex never sees Cursor or Claude offered.
export function targetStatus(config) {
  return Object.keys(TARGETS).map((name) => {
    const enabled = config.targets?.[name]?.enabled !== false;
    const bin = findBin(targetBin(name, config));
    const reason = !enabled ? `disabled in the config (targets.${name}.enabled)` : !bin ? `${targetBin(name, config)} not found on PATH` : null;
    return { name, enabled, installed: !!bin, available: enabled && !!bin, bin, reason };
  });
}

export const availableTargets = (config) => targetStatus(config).filter((t) => t.available).map((t) => t.name);

// Which of our targets the calling client itself is, from the MCP clientInfo name.
export function callerTool(clientName = '') {
  if (/cursor/i.test(clientName)) return 'cursor';
  if (/codex/i.test(clientName)) return 'codex';
  if (/claude/i.test(clientName)) return 'claude';
  return null;
}

// Turn "codex" | "cursor" | alias into { target, model?, alias? } or { error }.
export function resolveTarget(name, { config, caller }) {
  if (isTarget(name)) return { target: name };
  const alias = config.aliases && Object.hasOwn(config.aliases, name) ? config.aliases[name] : null;
  if (!alias || typeof alias !== 'object') return { error: `unknown target or alias "${name}" (targets: ${Object.keys(TARGETS).join(', ')}; aliases: ${Object.keys(config.aliases || {}).join(', ')})` };
  if (alias.target === 'other') {
    const pick = availableTargets(config).find((t) => t !== caller);
    if (!pick) return { error: `alias "${name}" needs an installed target other than ${caller ?? 'the caller'}` };
    return { target: pick, model: alias.model, alias: name };
  }
  if (!isTarget(alias.target)) return { error: `alias "${name}" points to unknown target "${alias.target}"` };
  return { target: alias.target, model: alias.model, alias: name };
}

const cachePath = () => path.join(dataDir(), 'models-cache.json');

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return {};
  }
}

// `cursor-agent models` prints a human list; keep the first token of each line that looks like a model id.
export function parseCursorModels(stdout) {
  const ids = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/^[\s*•\-–>]+/, '').trim();
    const id = line.split(/\s+/)[0];
    if (!id || /:$/.test(id) || /^(available|models?|current|default|tip)$/i.test(id)) continue;
    // Real output (2026-10): "auto - Auto (default)" then "<id> - <label>" per line.
    if ((id === 'auto' || (/^[a-z0-9][\w.\-]*$/i.test(id) && /[\d-]/.test(id))) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// `codex app-server` speaks JSON-RPC on stdio; `model/list` returns the models this account can use,
// with the CLI's default marked. Read-only: it starts no task and uses no tokens.
// One request to `codex app-server` (JSON-RPC over stdio), run by nuncius itself outside any sandbox,
// so its answer comes from Codex and not from a task. Resolves to the result, or null on any failure.
export function codexAppServer(bin, method, params = {}, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 4 * 1024 * 1024) return finish(null);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method, params });
        } else if (msg?.id === 2) {
          finish(msg.result ?? null);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nuncius', version: '0' } } });
  });
}

export async function discoverCodexModels(bin, { timeoutMs = 15000 } = {}) {
  const result = await codexAppServer(bin, 'model/list', {}, { timeoutMs });
  const list = Array.isArray(result?.data) ? result.data : [];
  const ids = list.filter((m) => m && typeof m.id === 'string' && /^[\w.:\-]{1,80}$/.test(m.id)).sort((a, b) => (b.isDefault === true) - (a.isDefault === true)).map((m) => m.id);
  return [...new Set(ids)];
}

// Models for a target: discovered (cached) when the CLI supports it, otherwise from config.
export async function discoverModels(target, config, { refresh = false } = {}) {
  const configured = config.targets?.[target]?.models ?? [];
  const cache = readCache();
  const hit = cache[target];
  const maxAge = (config.tasks?.modelCacheSeconds ?? 3600) * 1000;
  if (!refresh && hit && Date.now() - hit.at < maxAge) return { models: hit.models, source: 'discovered (cached)' };

  const bin = findBin(targetBin(target, config));
  if ((target === 'cursor' || target === 'codex') && bin) {
    let models = [];
    if (target === 'cursor') {
      const res = await run(bin, ['models'], { cwd: process.cwd(), timeoutMs: 15000 });
      models = res.code === 0 ? parseCursorModels(res.stdout) : [];
    } else {
      models = await discoverCodexModels(bin);
    }
    if (models.length) {
      cache[target] = { at: Date.now(), models };
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
      return { models, source: 'discovered' };
    }
  }
  // Claude takes its model aliases (fable, opus, sonnet, haiku) from config; the CLI resolves each to
  // the latest model of that line.
  return { models: configured, source: configured.length ? 'config' : 'unknown — pass any model id the CLI accepts, or omit to use its default' };
}
