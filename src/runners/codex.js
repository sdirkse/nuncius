import { run } from '../spawn.js';
import { tokens, MAX_RUN_TOKENS } from '../num.js';

// `codex exec --json` emits JSONL: thread.started, turn.started, item.*, turn.completed{usage} | turn.failed.
export function parseCodexJsonl(stdout) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let threadId = null;
  let finalMessage = '';
  let error = null;
  let turns = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'thread.started') threadId = ev.thread_id ?? threadId;
    else if (ev.type === 'turn.completed') {
      turns++;
      const u = ev.usage || {};
      usage.inputTokens += tokens(u.input_tokens);
      usage.cachedInputTokens += tokens(u.cached_input_tokens);
      usage.outputTokens += tokens(u.output_tokens);
    } else if (ev.type === 'turn.failed') {
      error = ev.error?.message || 'turn failed';
    } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      finalMessage = ev.item.text ?? finalMessage;
    }
  }
  for (const k of ['inputTokens', 'cachedInputTokens', 'outputTokens']) usage[k] = Math.min(usage[k], MAX_RUN_TOKENS);
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { threadId, usage, finalMessage, error, turns };
}

export async function runCodex({ bin, prompt, extraArgs, cwd, env, timeoutMs, echoStderr, wrap, onSpawn }) {
  // Codex's own Seatbelt sandbox is not relied on inside the nuncius's (Claude Code's failed to start
  // there; Codex's is unverified), so the nuncius switches it off and its outer sandbox + egress proxy confine Codex and every
  // command it runs (files and network). Only the nuncius sets this; callers cannot (src/args.js).
  const sandbox = ['--sandbox', 'danger-full-access'];
  // `--` ends option parsing, so a prompt starting with '-' can never become a flag.
  const args = ['exec', '--json', ...sandbox, ...extraArgs, '--', prompt];
  const cmd = wrap ? wrap(bin, args) : { bin, args };
  const res = await run(cmd.bin, cmd.args, { cwd, env: cmd.env ?? env, input: cmd.input, timeoutMs, echoStderr, onSpawn });
  const parsed = parseCodexJsonl(res.stdout);
  // Rate limits are not taken from the task: its rollout files are written inside the sandbox, so a
  // target could forge them. Nuncius asks Codex itself afterwards (refreshCodexLimits).
  return {
    exitCode: res.code,
    timedOut: res.timedOut,
    ok: res.code === 0 && !parsed.error,
    error: parsed.error || (res.code !== 0 ? lastLine(res.stderr) || `exit code ${res.code}` : null),
    sessionId: parsed.threadId,
    output: parsed.finalMessage,
    rawStdout: res.stdout,
    usage: parsed.usage,
    limits: null,
  };
}

function lastLine(s) {
  return s.trim().split('\n').pop()?.slice(0, 300) || '';
}
