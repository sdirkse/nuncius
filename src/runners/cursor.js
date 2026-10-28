import { run } from '../spawn.js';
import { num, tokens } from '../num.js';

// `cursor-agent -p --output-format stream-json` prints one JSON object per line while it works
// (system, user, assistant, thinking, tool_call started/completed) and ends with the type "result"
// object that plain json prints alone:
// { type, subtype, is_error, duration_ms, duration_api_ms, result, session_id, request_id,
//   usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } } (usage since 2026-10).
// No result object (the run broke off): the last object that reports an error, so its reason still reaches the caller.
export function parseCursorJson(stdout) {
  const lines = stdout.trim().split('\n');
  let failure = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue; // not JSON
    }
    if (o?.type === 'result') return o;
    if (!failure && (o?.is_error === true || o?.type === 'error')) failure = o;
  }
  return failure;
}

export async function runCursor({ bin, prompt, extraArgs, cwd, env, timeoutMs, echoStderr, wrap, onSpawn, onLine }) {
  // In print mode Cursor only proposes edits unless --force is given. The nuncius adds it itself
  // (callers cannot) because the outer sandbox (wrap) confines writes to the worktree.
  // Network for Cursor and its commands goes through the nuncius's egress proxy.
  // `--` ends option parsing, so a prompt starting with '-' can never become a flag.
  // --disable-auto-update (a hidden option, in the CLI since at least 2026.10.16): without it Cursor
  // checks for a new version two seconds in, downloads it into the task's throw-away HOME, and starts
  // a detached cleanup process that outlives the task. A task runs the version the user installed.
  // stream-json, not json: nuncius sees what Cursor does while it works (src/progress.js), and a run
  // that times out still leaves a record of its steps in runs/<id>.out.
  const args = ['-p', '--output-format', 'stream-json', '--force', '--disable-auto-update', ...extraArgs, '--', prompt];
  const cmd = wrap ? wrap(bin, args) : { bin, args };
  const res = await run(cmd.bin, cmd.args, { cwd, env: cmd.env ?? env, input: cmd.input, timeoutMs, echoStderr, onSpawn, onLine });
  const obj = parseCursorJson(res.stdout);
  const ok = res.code === 0 && obj?.type === 'result' && !obj.is_error;
  return {
    exitCode: res.code,
    timedOut: res.timedOut,
    ok,
    error: ok ? null : cursorError(obj) || lastLine(res.stderr) || `exit code ${res.code}`,
    sessionId: obj?.session_id ?? null,
    output: obj?.type === 'result' ? (obj.result ?? '') : '',
    rawStdout: res.stdout,
    usage: cursorUsage(obj),
    limits: null,
  };
}

// The reason in a failed result, or in an error object (its message, or its error as text).
function cursorError(obj) {
  if (!obj) return '';
  const why = obj.type === 'result' ? (obj.is_error ? obj.result : null) : (obj.message ?? obj.error ?? obj.result);
  if (why == null || why === '') return '';
  return (typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 300);
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
