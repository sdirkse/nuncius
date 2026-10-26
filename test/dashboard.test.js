import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPage, summarise, outcomeOf } from '../src/summary.js';

// The dashboard's lists: paged on the server, newest first, filtered before paging.

const now = new Date('2026-10-22T12:00:00');
const at = (daysAgo, minute = 0) => new Date(now.getTime() - daysAgo * 86400000 + minute * 60000).toISOString();
// Records in log order, which is finish order: a long task that started earlier is logged later.
const records = [
  ...Array.from({ length: 60 }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, tool: i % 2 ? 'codex' : 'cursor', project: 'p', agent: 'a', startedAt: at(2, i), ok: i % 10 !== 0, promptPreview: i === 7 ? 'Fix the Parser' : `task ${i}` })),
  { id: 'late', tool: 'claude', project: 'p', agent: 'reviewer', startedAt: at(2, -5), ok: false, refused: true, error: 'refused: budget', promptPreview: 'old start, logged last' },
  { id: 'old', tool: 'codex', project: 'p', agent: 'a', startedAt: at(40), ok: true, promptPreview: 'outside the period' },
];

test('tasks are paged newest start first, not in log order', () => {
  const p1 = taskPage(records, { days: 30, page: 1, size: 25, now });
  assert.equal(p1.total, 61);
  assert.equal(p1.pages, 3);
  assert.equal(p1.items.length, 25);
  assert.equal(p1.items[0].id, 't59');
  const starts = [...p1.items, ...taskPage(records, { days: 30, page: 2, size: 25, now }).items, ...taskPage(records, { days: 30, page: 3, size: 25, now }).items].map((r) => r.startedAt);
  assert.equal(starts.length, 61, 'every task is reachable through the pages');
  assert.ok(starts.every((s, i) => i === 0 || starts[i - 1] >= s), 'sorted by start, newest first');
  // The task that started earliest but was logged last is on the last page, at the bottom.
  assert.equal(taskPage(records, { days: 30, page: 3, size: 25, now }).items.at(-1).id, 'late');
});

test('filters apply before paging, and the page is clamped to what is left', () => {
  assert.equal(taskPage(records, { days: 30, tool: 'codex', now }).total, 30);
  assert.equal(taskPage(records, { days: 30, outcome: 'failed', now }).total, 6);
  assert.equal(taskPage(records, { days: 30, outcome: 'refused', now }).total, 1);
  assert.equal(taskPage(records, { days: 30, outcome: 'ok', now }).total, 54);
  assert.deepEqual(taskPage(records, { days: 30, q: 'parser', now }).items.map((r) => r.id), ['t07'], 'search is case-insensitive');
  assert.deepEqual(taskPage(records, { days: 30, q: 'REVIEWER', now }).items.map((r) => r.id), ['late'], 'search covers the agent');
  const clamped = taskPage(records, { days: 30, tool: 'claude', page: 3, now });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.items.length, 1);
  assert.equal(taskPage(records, { days: 30, q: 'nothing like this', now }).pages, 1);
});

test('odd paging input falls back to safe values', () => {
  assert.equal(taskPage(records, { days: 30, size: 7, now }).size, 25, 'only the offered page sizes');
  assert.equal(taskPage(records, { days: 30, size: 100, now }).items.length, 61);
  assert.equal(taskPage(records, { days: 30, page: 'abc', now }).page, 1);
  assert.equal(taskPage(records, { days: 30, page: -4, now }).page, 1);
});

test('outcomeOf and the most recently active project first', () => {
  assert.equal(outcomeOf({ ok: true }), 'ok');
  assert.equal(outcomeOf({ ok: false, error: 'boom' }), 'failed');
  assert.equal(outcomeOf({ ok: false, refused: true }), 'refused');
  const s = summarise([
    { tool: 'codex', project: 'busy-but-old', startedAt: at(5), ok: true },
    { tool: 'codex', project: 'busy-but-old', startedAt: at(5, 1), ok: true },
    { tool: 'codex', project: 'busy-but-old', startedAt: at(5, 2), ok: true },
    { tool: 'codex', project: 'new', startedAt: at(0), ok: true },
  ], { days: 30, now });
  assert.deepEqual(s.projects.map((p) => p.name), ['new', 'busy-but-old']);
  assert.equal(s.recentTotal, 4);
  assert.equal(s.recent, undefined, 'the list itself comes from the paged endpoint');
});
