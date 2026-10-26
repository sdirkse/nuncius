#!/usr/bin/env node
// Stand-in for `cursor-agent -p --output-format json`.
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(`${process.env.FAKE_VERSION ?? '2026.10.16-e3cb207'}`);
  process.exit(0);
}
if (args[0] === 'models') {
  console.log('Available models:\n  * composer-1.5 (current)\n  * gpt-5.3-codex\n  * sonnet-4.5\nTip: use --model <id>');
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) (await import('node:fs')).writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const fullPrompt = args[args.length - 1];
// The nuncius prepends a preamble; the actual task follows "Task:".
const prompt = fullPrompt.includes('\nTask:\n') ? fullPrompt.slice(fullPrompt.indexOf('\nTask:\n') + 7) : fullPrompt;
// Test hooks: WRITE:<rel> edits a file in cwd; ESCAPE:<abs> and READ:<abs> probe the sandbox.
const fsx = await import('node:fs');
const notes = [];
for (const [, rel] of prompt.matchAll(/WRITE:(\S+)/g)) fsx.writeFileSync(rel, `written by fake\n`);
for (const [, abs] of prompt.matchAll(/ESCAPE:(\S+)/g)) {
  try { fsx.writeFileSync(abs, 'escaped'); notes.push(`escape ${abs} OK`); } catch (e) { notes.push(`escape ${abs} ${e.code}`); }
}
for (const [, abs] of prompt.matchAll(/READ:(\S+)/g)) {
  try { fsx.readFileSync(abs); notes.push(`read ${abs} OK`); } catch (e) { notes.push(`read ${abs} ${e.code}`); }
}
if (process.env.FAKE_PROMPT_FILE) fsx.writeFileSync(process.env.FAKE_PROMPT_FILE, fullPrompt);
// "SLEEP:<ms>" anywhere in the prompt makes the fake take that long, to exercise queueing and timeouts.
const sleepMs = Number(/SLEEP:(\d+)/.exec(prompt)?.[1] ?? 0);
if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
if (prompt.includes('FAIL')) {
  console.error('fake cursor: not logged in');
  process.exit(1);
}
console.log(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 95000,
    duration_api_ms: 90000,
    result: `Cursor did: ${prompt}${notes.length ? ' | ' + notes.join(' | ') : ''}`,
    session_id: 'c-123',
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 },
  }),
);
