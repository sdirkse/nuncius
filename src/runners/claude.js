import { run } from '../spawn.js';
import { num, tokens } from '../num.js';
import { readClaudeLimits } from '../claude-limits.js';

// `claude -p --output-format stream-json --verbose` prints one JSON object per line; the one with
// type "result" carries:
// { result, is_error, session_id, total_cost_usd, usage, modelUsage: { <model>: { inputTokens, outputTokens,
//   cacheReadInputTokens, cacheCreationInputTokens, costUSD } }, ... }. modelUsage includes subagents; usage does not.
export function parseClaudeJson(stdout) {
  // stream-json: the result object is not necessarily the last line (a task_summary may follow).
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o.type === 'result') return o;
    } catch {
      // not JSON
    }
  }
  return null;
}

export function claudeUsage(obj) {
  const u = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, models: [] };
  const per = obj?.modelUsage && Object.keys(obj.modelUsage).length ? obj.modelUsage : null;
  if (per) {
    for (const [model, m] of Object.entries(per)) {
      u.models.push(model);
      u.inputTokens += tokens(m?.inputTokens) + tokens(m?.cacheReadInputTokens) + tokens(m?.cacheCreationInputTokens);
      u.cachedInputTokens += tokens(m?.cacheReadInputTokens);
      u.outputTokens += tokens(m?.outputTokens);
    }
  } else if (obj?.usage) {
    const x = obj.usage;
    u.inputTokens = tokens(x.input_tokens) + tokens(x.cache_read_input_tokens) + tokens(x.cache_creation_input_tokens);
    u.cachedInputTokens = tokens(x.cache_read_input_tokens);
    u.outputTokens = tokens(x.output_tokens);
  }
  u.totalTokens = u.inputTokens + u.outputTokens;
  // What this would cost on the API; the subscription is not billed per task.
  u.apiCostEstimateUsd = typeof obj?.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd) ? obj.total_cost_usd : null;
  return u;
}

// ADR 5 for Claude: its own Bash sandbox cannot start inside the nuncius's (nested Seatbelt is
// refused, and with failIfUnavailable Bash is simply disabled), so it is switched off and the
// nuncius's outer sandbox + egress proxy confine Claude and its commands. On top of that: dontAsk
// denies tools not listed, only project settings load (no user hooks or permission rules), no MCP
// servers (so not the nuncius itself), no web tools, no session files in ~/.claude.
export function claudeArgs({ extraArgs = [] }) {
  return [
    // stream-json (with --verbose) records every message and tool call; its type "result" line is
    // the same object as plain json (see parseClaudeJson).
    '-p', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash,Agent',
    '--disallowedTools', 'WebFetch,WebSearch',
    '--settings', JSON.stringify({ sandbox: { enabled: false } }),
    ...extraArgs,
  ];
}

export async function runClaude({ bin, prompt, extraArgs, cwd, env, timeoutMs, echoStderr, wrap, onSpawn, onLine }) {
  // `--` ends option parsing, so a prompt starting with '-' can never become a flag.
  const args = [...claudeArgs({ extraArgs }), '--', prompt];
  const cmd = wrap ? wrap(bin, args) : { bin, args };
  const res = await run(cmd.bin, cmd.args, { cwd, env: cmd.env ?? env, input: cmd.input, timeoutMs, echoStderr, onSpawn, onLine });
  const obj = parseClaudeJson(res.stdout);
  const ok = res.code === 0 && !!obj && !obj.is_error;
  return {
    exitCode: res.code,
    timedOut: res.timedOut,
    ok,
    error: ok ? null : obj?.is_error ? String(obj.result ?? obj.subtype ?? 'error').slice(0, 300) : lastLine(res.stderr) || `exit code ${res.code}`,
    sessionId: obj?.session_id ?? null,
    output: obj?.result ?? '',
    rawStdout: res.stdout,
    usage: { ...claudeUsage(obj), durationMs: obj?.duration_ms == null ? null : num(obj.duration_ms) },
    limits: readClaudeLimits(),
  };
}

function lastLine(s) {
  return s.trim().split('\n').pop()?.slice(0, 300) || '';
}
