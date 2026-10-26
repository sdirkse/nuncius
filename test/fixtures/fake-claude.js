#!/usr/bin/env node
// Stand-in for `claude -p --output-format json`.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(`${process.env.FAKE_VERSION ?? '2.1.299'} (Claude Code)`);
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const fullPrompt = args[args.length - 1];
const prompt = fullPrompt.includes('\nTask:\n') ? fullPrompt.slice(fullPrompt.indexOf('\nTask:\n') + 7) : fullPrompt;
for (const [, rel] of prompt.matchAll(/WRITE:(\S+)/g)) fs.writeFileSync(rel, 'written by fake claude\n');
if (prompt.includes('FAIL')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'something broke' }));
  process.exit(1);
}
// stream-json: messages first, the result object last.
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'c.txt' } }, { type: 'tool_use', name: 'Bash', input: { command: 'node --test' } }] } }));
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, result: `Claude did: ${prompt}`, session_id: 's-1',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
  modelUsage: {
    'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 500, costUSD: 0.01 },
    'claude-haiku-5-5': { inputTokens: 5, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 100, costUSD: 0.0023 },
  },
}));
// Real stream-json output ends with a system/task_summary line after the result.
console.log(JSON.stringify({ type: 'system', subtype: 'task_summary', detail: 'done' }));
