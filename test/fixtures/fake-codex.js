#!/usr/bin/env node
// Stand-in for `codex exec --json`: emits JSONL like Codex and writes a rollout with rate limits.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_VERSION ?? '0.163.0'}`);
  process.exit(0);
}
// `codex app-server`: answer initialize and model/list like the real CLI, for model discovery.
if (args[0] === 'app-server') {
  const rl = (await import('node:readline')).createInterface({ input: process.stdin });
  for await (const line of rl) {
    const msg = JSON.parse(line);
    if (msg.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }));
    if (msg.method === 'model/list') console.log(JSON.stringify({ id: msg.id, result: { data: [{ id: 'fake-luna', isDefault: false }, { id: 'fake-sol', isDefault: true }] } }));
    // The account's real windows, as nuncius asks Codex for them (outside the sandbox).
    // FAKE_CODEX_PRIMARY sets the 5-hour window; "none" answers without limits.
    if (msg.method === 'account/rateLimits/read') {
      const raw = process.env.FAKE_CODEX_PRIMARY ?? '34';
      const now = Math.floor(Date.now() / 1000);
      const rateLimits = raw === 'none' ? null : {
        primary: { usedPercent: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw, windowDurationMins: 300, resetsAt: now + 3600 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: now + 86400 * 3 },
      };
      console.log(JSON.stringify({ id: msg.id, result: { rateLimits } }));
    }
  }
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
  console.error('fake codex: something broke');
  process.exit(1);
}
const threadId = '0199aaaa-bbbb-cccc-dddd-' + String(Date.now()).slice(-12).padStart(12, '0');
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'thread.started', thread_id: threadId });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } });
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `Done: ${prompt}${notes.length ? ' | ' + notes.join(' | ') : ''}` } });
out({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 4000, output_tokens: 800 } });

// What the task itself writes into its (throw-away) Codex home: nuncius must not believe it.
const usedRaw = process.env.FAKE_CODEX_ROLLOUT_PRIMARY ?? '34';
const used = /^-?\d+(\.\d+)?$/.test(usedRaw) ? Number(usedRaw) : usedRaw; // non-numbers simulate a malformed report
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '17');
fs.mkdirSync(dir, { recursive: true });
const now = Math.floor(Date.now() / 1000);
fs.writeFileSync(
  path.join(dir, `rollout-2026-10-17T12-00-00-${threadId}.jsonl`),
  [
    { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: threadId } },
    { timestamp: new Date().toISOString(), type: 'turn_context', payload: { model: args[args.indexOf('--model') + 1] && args.includes('--model') ? args[args.indexOf('--model') + 1] : 'fake-default' } },
    {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 12000, output_tokens: 800 } },
        rate_limits: {
          primary: { used_percent: used, window_minutes: 300, resets_at: typeof used === 'string' ? 'bogus-date' : now + 3600 },
          secondary: { used_percent: 12, window_minutes: 10080, resets_at: now + 86400 * 3 },
        },
      },
    },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n',
);
