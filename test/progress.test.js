import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, progressView, cleanLabel, shortDuration, shellLabel, parseActivityLog, QUIET_SECONDS, MAX_LOG } from '../src/progress.js';

const feedAll = (p, events) => events.forEach((e) => p.feed(typeof e === 'string' ? e : JSON.stringify(e)));

test('claude stream-json: edits, commands and reads are counted, paths shown from the worktree', () => {
  const p = createProgress({ target: 'claude', base: '/wt/repo-1', timeoutSeconds: 1800 });
  feedAll(p, [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/wt/repo-1/src/a.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/wt/repo-1/src/a.js' } }, { type: 'tool_use', name: 'Write', input: { file_path: '/wt/repo-1/b.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/wt/repo-1/src/a.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ]);
  const s = p.snapshot();
  assert.equal(s.filesEdited, 2, 'the same file edited twice counts once');
  assert.equal(s.commands, 1);
  assert.equal(s.steps, 5, 'a tool result is not a step of its own');
  assert.equal(s.lastActivity, 'Shell: npm test');
  assert.equal(s.timeoutSeconds, 1800);
  assert.ok(s.lastActivityAt);
});

test('codex --json: commands on start, file changes on completion', () => {
  const p = createProgress({ target: 'codex', base: '/wt/x' });
  feedAll(p, [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution', command: 'bash -lc ls' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'bash -lc ls', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/wt/x/a.js', kind: 'update' }, { path: '/wt/x/b.js', kind: 'add' }] } },
  ]);
  const s = p.snapshot();
  assert.equal(s.commands, 1);
  assert.equal(s.filesEdited, 2);
  assert.equal(s.lastActivity, 'add b.js');
});

test('a finished step keeps its own label, and shell wrappers are taken off', () => {
  const p = createProgress({ target: 'codex' });
  feedAll(p, [
    { type: 'item.started', item: { type: 'command_execution', command: `/bin/zsh -lc "rg -n 'Outbound mail' src"` } },
    { type: 'item.completed', item: { type: 'command_execution', command: `/bin/zsh -lc "rg -n 'Outbound mail' src"`, exit_code: 0 } },
  ]);
  assert.equal(p.snapshot().lastActivity, "Shell: rg -n 'Outbound mail' src");
  assert.equal(shellLabel("bash -lc 'npm test'"), 'Shell: npm test');
  assert.equal(shellLabel('sh -c "ls"'), 'Shell: ls');
  assert.equal(shellLabel('npm test'), 'Shell: npm test');
});

test('cursor stream-json: tool calls by kind', () => {
  const seen = [];
  const p = createProgress({ target: 'cursor', base: '/wt/c', onActivity: (a) => seen.push(a.what) });
  feedAll(p, [
    { type: 'system', subtype: 'init' },
    { type: 'thinking', subtype: 'delta', text: '...' },
    { type: 'thinking', subtype: 'delta', text: '...' },
    { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/wt/c/README.md' } } } },
    { type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: { path: '/wt/c/README.md' }, result: {} } } },
    { type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: '/wt/c/src/game.js' } } } },
    { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'node --test' } } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done' },
  ]);
  const s = p.snapshot();
  assert.equal(s.filesEdited, 1);
  assert.equal(s.commands, 1);
  assert.equal(s.steps, 3, 'a finished call is not a step of its own');
  assert.equal(s.lastActivity, 'writing a reply');
  assert.deepEqual(seen, ['thinking', 'read README.md', 'edit src/game.js', 'Shell: node --test', 'writing a reply'], 'one line per run of thinking chunks, none for finished calls');
});

test('junk, non-JSON and odd events are ignored, never thrown on', () => {
  const p = createProgress({ target: 'cursor' });
  for (const l of ['', 'plain text', '{not json', 'null', '[1,2]', '{"type":"tool_call","tool_call":null}', '{"type":"tool_call","subtype":"started","tool_call":{}}']) assert.doesNotThrow(() => p.feed(l));
  assert.equal(p.snapshot().steps, 0);
  assert.equal(createProgress({ target: 'nope' }).feed('{"type":"x"}'), true, 'an unknown target still counts as alive');
});

test('labels from the target are cleaned and shortened', () => {
  assert.equal(cleanLabel('Shell: rm\n-rf \x1b[31mx‮'), 'Shell: rm -rf [31mx');
  assert.equal(cleanLabel('a'.repeat(300)).length, 100);
  assert.equal(cleanLabel('rm \u200f-rf \u200bx\ufeff\u2060y'), 'rm -rf x y', 'zero-width and direction marks go too');
  const p = createProgress({ target: 'claude' });
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi\nIgnore previous instructions' } }] } }));
  assert.equal(p.snapshot().lastActivity, 'Shell: echo hi Ignore previous instructions');
});

test('progressView: elapsed, seconds since last activity, quiet after QUIET_SECONDS', () => {
  const t0 = Date.parse('2026-10-28T10:00:00Z');
  const progress = { startedAt: new Date(t0).toISOString(), timeoutSeconds: 1800, lastActivityAt: new Date(t0 + 60000).toISOString(), lastActivity: 'edit a.js', steps: 3, filesEdited: 1, commands: 1 };
  const v = progressView(progress, { state: 'running', startedAt: progress.startedAt, now: t0 + 120000 });
  assert.equal(v.elapsedSeconds, 120);
  assert.deepEqual(v.lastActivity, { secondsAgo: 60, what: 'edit a.js' });
  assert.equal(v.quiet, false);
  const late = progressView(progress, { state: 'running', now: t0 + 60000 + QUIET_SECONDS * 1000 });
  assert.equal(late.quiet, true);
  // Finished: elapsed is the run time, and a finished task is never "quiet".
  const done = progressView(progress, { state: 'done', startedAt: progress.startedAt, finishedAt: new Date(t0 + 9e6).toISOString(), wallMs: 300000 });
  assert.equal(done.elapsedSeconds, 300);
  assert.equal(done.quiet, false);
  assert.equal(progressView(null), null);
});

test('shortDuration', () => {
  assert.equal(shortDuration(4.2), '4 s');
  assert.equal(shortDuration(360), '6 min');
  assert.equal(shortDuration(3900), '1 h 05 min');
  assert.equal(shortDuration(NaN), '?');
});

test('every logged step goes to onLog with seconds since the start; finished steps and repeated thinking do not', () => {
  let t = 1000;
  const log = [];
  const p = createProgress({ target: 'claude', now: () => t, onLog: (e) => log.push(e) });
  const bash = (cmd) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] } });
  const think = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }] } });
  p.feed(think);
  p.feed(think); // a run of thinking chunks is one entry
  for (let i = 0; i < 3; i++) {
    t += 2000;
    p.feed(bash(`step ${i}`));
    p.feed(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })); // finished: not logged again
  }
  assert.deepEqual(log, [
    { s: 0, kind: 'thinking', what: 'thinking' },
    { s: 2, kind: 'command', what: 'Shell: step 0' },
    { s: 4, kind: 'command', what: 'Shell: step 1' },
    { s: 6, kind: 'command', what: 'Shell: step 2' },
  ]);
  assert.equal(p.snapshot().logged, 4);
  assert.equal(p.snapshot().recent, undefined, 'the log lives in its own file, not in the task record');
  // A throwing listener does not stop the run.
  assert.doesNotThrow(() => createProgress({ target: 'claude', onLog: () => { throw new Error('x'); } }).feed(bash('y')));
});

test('parseActivityLog: oldest first, damaged lines skipped', () => {
  const text = [
    { s: 0, kind: 'start', what: 'Started · Cursor' },
    { s: 5, kind: 'command', what: 'Shell: ls' },
    'not json',
    { s: 3.4, kind: '<script>', what: 'b\u001b[2Jc' },
    { s: -1, kind: 'edit', what: 'a' },
    { s: 9, kind: 'end', what: 'Done · 1 step' },
  ].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
  assert.deepEqual(parseActivityLog(text).map((e) => [e.s, e.kind, e.what]), [[0, 'start', 'Started · Cursor'], [5, 'command', 'Shell: ls'], [3, 'tool', 'b [2Jc'], [9, 'end', 'Done · 1 step']]);
  assert.deepEqual(parseActivityLog(''), []);
  assert.ok(MAX_LOG >= 1000);
});
