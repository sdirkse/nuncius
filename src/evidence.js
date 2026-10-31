import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './config.js';
import { parseClaudeJson } from './runners/claude.js';

// Proof of what actually ran, collected from the target's own records before its throw-away dirs
// are removed. These files are written by the target CLI inside the sandbox, so they show what the
// CLI recorded (not something the nuncius can vouch for); the raw copies make every claim checkable.
// A file over MAX_FILE is copied trimmed, as <name>.trimmed, with its base64 payloads (images) left out.
//   claude: model ids in `modelUsage` of its JSON result (reported per model by the API usage)
//   codex:  `turn_context.model` in its session rollout
//   cursor: `modelName` in its chat store

const MAX_FILE = 20 * 1024 * 1024; // what is kept and copied of one file
const MAX_FILES = 200;
const MAX_TOTAL = 100 * 1024 * 1024; // all evidence files of one task together
// A larger file (images inlined as base64 make them big) is read in chunks and kept trimmed: every
// run of MIN_RUN or more base64 characters is replaced by a short marker. Hard limits keep a huge
// file from stalling a task: files over MAX_SCAN are skipped, and at most MAX_SCAN_TOTAL bytes of
// large files are read per task.
const MAX_SCAN = 256 * 1024 * 1024;
const MAX_SCAN_TOTAL = 512 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const MIN_RUN = 1024;

// Regular files only (no symlinks: the target controls these dirs), bounded in size and count.
// The caller seals the dirs first (see sealDirs in tasks.js), so nothing can change them while
// this runs; the checks below are a second line of defence.
function walk(dir, filter, out = [], depth = 0) {
  if (depth > 8 || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, filter, out, depth + 1);
    else if (e.isFile() && filter(p)) out.push(p);
  }
  return out;
}

// `base` was created by nuncius; every component below it must be a real directory, not a link
// the target planted (e.g. `.cursor` -> ~/.ssh), or nothing under it is collected.
function realDir(base, ...parts) {
  try {
    if (!fs.lstatSync(base).isDirectory()) return null;
  } catch {
    return null;
  }
  let p = base;
  for (const part of parts) {
    p = path.join(p, part);
    try {
      if (!fs.lstatSync(p).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return p;
}

// Read a file without following a symlink in its last component, and only if it is still a
// regular file within the size limits (no FIFOs or devices: O_NONBLOCK keeps open from hanging).
// Returns { data } for a file up to MAX_FILE, { data, trimmed } for a larger one (see trimFile).
function readRegular(file, scan) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    // nlink > 1: a hard link to a file elsewhere (the sandbox already refuses links to denied
    // files; this keeps nuncius from copying one even if a link slipped through).
    if (!st.isFile() || st.nlink > 1) return null;
    if (st.size > MAX_FILE) {
      if (st.size > MAX_SCAN || scan.left < st.size) return null;
      scan.left -= st.size;
      return trimFile(fd, st.size);
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { data: buf.subarray(0, off) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const B64 = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') B64[c.charCodeAt(0)] = 1;

// Stream a large file through a fixed-size chunk and keep it with its base64 payloads removed:
// each run of MIN_RUN or more base64 characters becomes "<nuncius: N base64 bytes removed>". The
// marker has no quote or backslash, so a JSON line stays valid JSON; everything else (model
// fields, tool calls, text) is kept byte for byte. Memory stays bounded: one chunk, one pending
// run of under MIN_RUN bytes and the output, which stops at MAX_FILE (then `truncated` is set
// and the rest of the file is not read).
function trimFile(fd, size) {
  const out = Buffer.alloc(MAX_FILE);
  let outLen = 0;
  let truncated = false;
  const emit = (src, start, end) => {
    const room = MAX_FILE - outLen;
    if (end - start > room) {
      end = start + room;
      truncated = true;
    }
    outLen += src.copy(out, outLen, start, end);
  };
  const pending = Buffer.alloc(MIN_RUN);
  let run = 0;
  let removed = 0;
  const endRun = () => {
    if (run >= MIN_RUN) {
      const marker = Buffer.from(`<nuncius: ${run} base64 bytes removed>`);
      emit(marker, 0, marker.length);
      removed += run;
    } else if (run) {
      emit(pending, 0, run);
    }
    run = 0;
  };
  const chunk = Buffer.alloc(CHUNK);
  let pos = 0;
  while (pos < size && !truncated) {
    const n = fs.readSync(fd, chunk, 0, Math.min(CHUNK, size - pos), pos);
    if (n === 0) break;
    pos += n;
    let i = 0;
    while (i < n && !truncated) {
      let j = i;
      if (B64[chunk[i]]) {
        while (j < n && B64[chunk[j]]) j++;
        if (run < MIN_RUN) chunk.copy(pending, run, i, Math.min(j, i + MIN_RUN - run));
        run += j - i;
      } else {
        while (j < n && !B64[chunk[j]]) j++;
        endRun();
        emit(chunk, i, j);
      }
      i = j;
    }
  }
  if (!truncated) endRun();
  // A copy at its own size: the MAX_FILE buffer is not kept alive per file.
  return { data: Buffer.from(out.subarray(0, outLen)), trimmed: { size, read: pos, removed, truncated } };
}

const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x && x.length < 200))];

function codexModels(files) {
  const models = [];
  for (const f of files) {
    for (const line of f.data.toString('utf8').split('\n')) {
      if (!line.includes('turn_context')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'turn_context') models.push(o.payload?.model);
      } catch {
        // partial line
      }
    }
  }
  return uniq(models);
}

function cursorModels(files) {
  const models = [];
  for (const f of files) {
    const text = f.data.toString('latin1');
    for (const m of text.matchAll(/"modelName":"([A-Za-z0-9._\-]+)"/g)) models.push(m[1]);
  }
  return uniq(models);
}

function claudeModels(rawStdout) {
  return uniq(Object.keys(parseClaudeJson(rawStdout)?.modelUsage ?? {}));
}

const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);

// What the agent did, step by step, from the CLI's own event stream or transcript.
function actionsFrom(target, rawStdout, files) {
  const out = [];
  const lines = (text) => text.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (target === 'claude') {
    for (const e of lines(rawStdout)) {
      if (e.type !== 'assistant') continue;
      for (const c of e.message?.content ?? []) if (c.type === 'tool_use') out.push({ tool: c.name, detail: short(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? JSON.stringify(c.input)) });
    }
  } else if (target === 'codex') {
    for (const e of lines(rawStdout)) {
      if (e.type !== 'item.completed') continue;
      const it = e.item ?? {};
      if (it.type === 'command_execution') out.push({ tool: 'command', detail: short(it.command), exitCode: it.exit_code ?? null });
      else if (it.type === 'file_change') out.push({ tool: 'file_change', detail: short((it.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(', ')) });
    }
  } else if (target === 'cursor') {
    for (const f of files.filter((x) => x.path.endsWith('.jsonl'))) {
      for (const e of lines(f.data.toString('utf8'))) {
        for (const c of e.message?.content ?? []) if (c.type === 'tool_use' || c.type === 'tool-call') out.push({ tool: c.name ?? c.toolName, detail: short(c.input?.command ?? c.input?.path ?? c.input?.file_path ?? c.input?.pattern ?? c.input?.glob_pattern ?? JSON.stringify(c.input ?? c.args)) });
      }
    }
  }
  return out.slice(0, 500);
}

export function collectEvidence({ id, target, rawStdout = '', codexHomeDir, cursorHome }) {
  let paths = [];
  let source;
  let root;
  if (target === 'claude') {
    source = 'claude -p stream-json result: keys of modelUsage';
  } else if (target === 'codex' && codexHomeDir) {
    root = codexHomeDir;
    const sessions = realDir(codexHomeDir, 'sessions');
    paths = sessions ? walk(sessions, (p) => p.endsWith('.jsonl')) : [];
    source = 'codex session rollout: turn_context.model';
  } else if (target === 'cursor' && cursorHome) {
    root = realDir(cursorHome, '.cursor');
    const chats = root && realDir(root, 'chats');
    const projects = root && realDir(root, 'projects');
    paths = [
      ...(chats ? walk(chats, (p) => /(store\.db|meta\.json)$/.test(p)) : []),
      ...(projects ? walk(projects, (p) => p.includes(`${path.sep}agent-transcripts${path.sep}`) && p.endsWith('.jsonl')) : []),
    ];
    source = 'cursor chat store: modelName';
  }
  // Read each file once, safely; models, actions and the audit copy all come from that one read.
  const files = [];
  let total = 0;
  const scan = { left: MAX_SCAN_TOTAL };
  for (const p of paths) {
    const rel = path.relative(root, p);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    const read = readRegular(p, scan);
    if (!read) continue;
    if (total + read.data.length > MAX_TOTAL) break;
    total += read.data.length;
    files.push({ path: p, rel, ...read });
  }
  const models = target === 'claude' ? claudeModels(rawStdout)
    : target === 'codex' ? codexModels(files)
    : target === 'cursor' ? cursorModels(files.filter((f) => f.path.endsWith('store.db')))
    : [];
  const copied = [];
  const trimmed = [];
  if (files.length) {
    const dest = path.join(runsDir(), `${id}-evidence`);
    for (const f of files) {
      // A trimmed copy is not the original file (a trimmed store.db is no longer a database), so
      // its name says so.
      const to = path.join(dest, f.trimmed ? `${f.rel}.trimmed` : f.rel);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, f.data, { flag: 'wx' });
        copied.push(to);
        if (f.trimmed) trimmed.push({ file: to, ...f.trimmed });
      } catch {
        // a failed audit copy must not lose the models and actions read above
      }
    }
  }
  let actions = [];
  try {
    actions = actionsFrom(target, rawStdout, files);
  } catch {
    // never fail a task over its audit trail
  }
  return { models, source: source ?? null, files: copied, ...(trimmed.length ? { trimmed } : {}), actions };
}
