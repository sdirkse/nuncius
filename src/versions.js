import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { dataDir } from './config.js';

// Nuncius depends on some undocumented behaviour of the target CLIs (Claude's snapshot dir naming,
// Codex's app-server API, each CLI's API hosts and output format). These are the versions that were
// last run end to end against the real CLIs under nuncius's sandbox. A version outside this range gets
// a warning, never a refusal: it will usually work, but if a task fails oddly, this is a likely cause.
// Widen a range only after running the real CLI through nuncius (see docs/adr/0005).
export const VERIFIED = {
  codex: { min: '0.163.0', max: '0.163.0' },
  cursor: { min: '2026.10.16', max: '2026.10.16' },
  claude: { min: '2.1.299', max: '2.1.299' },
};
const NAMES = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' };

// The first dotted number in `--version` output: "codex-cli 0.163.0", "2026.10.16-e3cb207",
// "2.1.299 (Claude Code)".
export function parseVersion(text) {
  return /\d+(?:\.\d+)+/.exec(String(text ?? ''))?.[0] ?? null;
}

export function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// { version, verified, note }: note is set when the version is unknown or outside VERIFIED.
export function versionCheck(target, version) {
  const range = VERIFIED[target];
  if (!range) return { version, verified: false, note: null };
  const name = NAMES[target];
  const span = range.min === range.max ? range.min : `${range.min} to ${range.max}`;
  if (!version) return { version: null, verified: false, note: `could not read the ${name} version; nuncius was verified with ${span}` };
  if (compareVersions(version, range.max) > 0)
    return { version, verified: false, note: `${name} ${version} is newer than the versions nuncius was verified with (${span}). It will usually work; if tasks fail oddly, this is a likely cause.` };
  if (compareVersions(version, range.min) < 0)
    return { version, verified: false, note: `${name} ${version} is older than the versions nuncius was verified with (${span}). Update it if tasks fail.` };
  return { version, verified: true, note: null };
}

// `--version` is run once per binary build: cached by the binary's real path, size and mtime.
const cachePath = () => path.join(dataDir(), 'cli-versions.json');
function cacheKey(bin) {
  try {
    const real = fs.realpathSync(bin);
    const st = fs.statSync(real);
    return `${real}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
}
function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}
function writeCache(key, version) {
  try {
    const c = readCache();
    c[key] = version;
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${cachePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, cachePath());
  } catch {
    // a cache only
  }
}

// The version a check (doctor, list_targets) already read for this exact binary, without running it.
// A task run uses only this: it must not start the CLI outside the sandbox just to print a note.
export function cachedCliVersion(bin) {
  const key = cacheKey(bin);
  const v = key ? readCache()[key] : null;
  return typeof v === 'string' ? v : null;
}

export function cliVersionSync(bin) {
  const key = cacheKey(bin);
  if (!key) return null;
  const cached = readCache()[key];
  if (typeof cached === 'string') return cached;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = parseVersion(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  if (version) writeCache(key, version);
  return version;
}

export function cliVersion(bin) {
  const key = cacheKey(bin);
  if (!key) return Promise.resolve(null);
  const cached = readCache()[key];
  if (typeof cached === 'string') return Promise.resolve(cached);
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }, (err, stdout, stderr) => {
      const version = parseVersion(`${stdout ?? ''}\n${stderr ?? ''}`);
      if (version) writeCache(key, version);
      resolve(version);
    });
  });
}
