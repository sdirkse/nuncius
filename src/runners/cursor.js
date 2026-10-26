import { run } from '../spawn.js';
import { num, tokens } from '../num.js';

// `cursor-agent -p --output-format json` prints one JSON object on success:
// { type, subtype, is_error, duration_ms, duration_api_ms, result, session_id, request_id,
//   usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } } (usage since 2026-10).
export function parseCursorJson(stdout) {
  const text = stdout.trim();
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export async function runCursor({ bin, prompt, extraArgs, cwd, env, timeoutMs, echoStderr, wrap, onSpawn }) {
  // In print mode Cursor only proposes edits unless --force is given. The nuncius adds it itself
  // (callers cannot) because the outer sandbox (wrap) confines writes to the worktree.
  // Network for Cursor and its commands goes through the nuncius's egress proxy.
  // `--` ends option parsing, so a prompt starting with '-' can never become a flag.
  // --disable-auto-update (a hidden option, in the CLI since at least 2026.10.16): without it Cursor
  // checks for a new version two seconds in, downloads it into the task's throw-away HOME, and starts
  // a detached cleanup process that outlives the task. A task runs the version the user installed.
  const args = ['-p', '--output-format', 'json', '--force', '--disable-auto-update', ...extraArgs, '--', prompt];
  const cmd = wrap ? wrap(bin, args) : { bin, args };
  const res = await run(cmd.bin, cmd.args, { cwd, env: cmd.env ?? env, input: cmd.input, timeoutMs, echoStderr, onSpawn });
  const obj = parseCursorJson(res.stdout);
  const ok = res.code === 0 && !!obj && !obj.is_error;
  return {
    exitCode: res.code,
    timedOut: res.timedOut,
    ok,
    error: ok ? null : obj?.result && obj.is_error ? String(obj.result).slice(0, 300) : lastLine(res.stderr) || `exit code ${res.code}`,
    sessionId: obj?.session_id ?? null,
    output: obj?.result ?? '',
    rawStdout: res.stdout,
    usage: cursorUsage(obj),
    limits: null,
  };
}

function lastLine(s) {
  return s.trim().split('\n').pop()?.slice(0, 300) || '';
}

export function cursorUsage(obj) {
  const timing = { durationMs: obj?.duration_ms == null ? null : num(obj.duration_ms), apiDurationMs: obj?.duration_api_ms == null ? null : num(obj.duration_api_ms) };
  // Older CLIs and error results carry no usage: unknown, not zero.
  if (!obj?.usage) return { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, ...timing };
  const u = obj.usage;
  const cached = tokens(u.cacheReadTokens);
  const input = tokens(u.inputTokens) + cached + tokens(u.cacheWriteTokens);
  const output = tokens(u.outputTokens);
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
    ...timing,
  };
}
