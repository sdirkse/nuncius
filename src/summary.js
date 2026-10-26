import { localDay } from './log.js';
import { num, tokens } from './num.js';
import { readClaudeLimits } from './claude-limits.js';
import { findRollout, readRateLimits, mergeLimits, readLiveCodexLimits } from './codex-limits.js';

const emptyTotals = () => ({
  runs: 0,
  failures: 0,
  notRun: 0,
  durationMs: 0,
  // Per tool: runs, tokens (total), input (incl. cached), cached input, output.
  // AgentMs: how long its tasks ran (the tool's own reported duration, nuncius's wall clock as the floor).
  ...Object.fromEntries(['codex', 'claude', 'cursor'].flatMap((t) => [`${t}Runs`, `${t}Tokens`, `${t}InputTokens`, `${t}CachedTokens`, `${t}OutputTokens`, `${t}AgentMs`].map((k) => [k, 0]))),
});


// Refused runs and runs that never reached the target (binary missing) did not use anything: they
// are counted apart and do not count towards run caps.
function add(t, r) {
  if (r.refused || r.started === false) {
    t.notRun++;
    return;
  }
  t.runs++;
  if (!r.ok) t.failures++;
  const wallMs = num(r.wallMs);
  t.durationMs += wallMs;
  if (r.tool !== 'codex' && r.tool !== 'claude' && r.tool !== 'cursor') return;
  t[`${r.tool}Runs`]++;
  t[`${r.tool}Tokens`] += tokens(r.usage?.totalTokens);
  t[`${r.tool}InputTokens`] += tokens(r.usage?.inputTokens);
  t[`${r.tool}CachedTokens`] += tokens(r.usage?.cachedInputTokens);
  t[`${r.tool}OutputTokens`] += tokens(r.usage?.outputTokens);
  // Nuncius's own measured run time. A target reports its own duration in its (untrusted) output;
  // trusting a larger value would let a target use up the minute budget with one forged number.
  // (Only a record without nuncius's own wallMs, from an older release, falls back to the reported one.)
  t[`${r.tool}AgentMs`] += r.wallMs == null ? num(r.usage?.durationMs) : wallMs;
}

export function totalsFor(records, filter = () => true) {
  const t = emptyTotals();
  for (const r of records) if (filter(r)) add(t, r);
  return t;
}

// Effective Codex limits, from trusted sources only: what Codex's own app-server reported to nuncius
// (refreshCodexLimits, run outside any sandbox) and the user's own Codex sessions. Never from a task:
// a sandboxed target can write whatever it likes into its own Codex home.
export function latestCodexLimits() {
  let sessions = null;
  try {
    sessions = readRateLimits(findRollout(null));
  } catch {
    // no Codex sessions yet
  }
  return mergeLimits(readLiveCodexLimits(), sessions && { ...sessions, source: 'codex sessions' });
}

// The first moment of a period of `days` local days, today included.
export function periodStart(days, now = new Date()) {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  return since;
}

export function summarise(records, { days = 30, now = new Date() } = {}) {
  const since = periodStart(days, now);
  const inRange = records.filter((r) => new Date(r.startedAt) >= since);
  const today = localDay(now.toISOString());

  // Maps, not objects: project and agent names come from callers ("__proto__" must stay a name).
  const byProject = new Map();
  const byDay = new Map();
  const byAgent = new Map();
  const bucket = (m, k) => {
    const key = String(k);
    if (!m.has(key)) m.set(key, emptyTotals());
    return m.get(key);
  };
  for (const r of inRange) {
    add(bucket(byProject, r.project), r);
    add(bucket(byAgent, r.agent), r);
    add(bucket(byDay, localDay(r.startedAt)), r);
  }

  const dayList = [];
  for (let d = new Date(since); d <= now; d.setDate(d.getDate() + 1)) {
    const key = localDay(d.toISOString());
    dayList.push({ day: key, ...(byDay.get(key) ?? emptyTotals()) });
  }

  return {
    generatedAt: now.toISOString(),
    days,
    totals: totalsFor(inRange),
    today: totalsFor(records, (r) => localDay(r.startedAt) === today),
    codexLimits: latestCodexLimits(records),
    claudeLimits: readClaudeLimits(),
    projects: [...byProject]
      .map(([name, t]) => ({ name, ...t, lastRunAt: lastRun(inRange, (r) => String(r.project) === name) }))
      // Most recently active first: the projects being worked on now, not the busiest of the period.
      .sort((a, b) => String(b.lastRunAt ?? '').localeCompare(String(a.lastRunAt ?? '')) || b.runs - a.runs),
    agents: [...byAgent]
      .map(([name, t]) => ({ name, ...t }))
      .sort((a, b) => b.runs - a.runs),
    daily: dayList,
    // How many runs the period has; the list itself is paged by taskPage.
    recentTotal: inRange.length,
  };
}

// A record's outcome as the dashboard shows it.
export const outcomeOf = (r) => (r.ok ? 'ok' : r.refused || String(r.error ?? '').startsWith('refused') ? 'refused' : 'failed');
export const PAGE_SIZES = [10, 25, 50, 100];

// One page of the period's runs, newest start first, after the filters: tool, outcome and a
// case-insensitive search over the prompt preview, agent, model and task id. The page number is
// clamped to the pages there are, so a filter that shrinks the list never leaves an empty page.
export function taskPage(records, { days = 30, tool = '', outcome = '', q = '', page = 1, size = 25, now = new Date() } = {}) {
  const since = periodStart(days, now);
  const needle = String(q ?? '').trim().toLowerCase();
  const rows = records
    .filter((r) => new Date(r.startedAt) >= since)
    .filter((r) => !tool || r.tool === tool)
    .filter((r) => !outcome || outcomeOf(r) === outcome)
    .filter((r) => !needle || [r.promptPreview, r.agent, r.model, ...(r.modelsReported ?? []), r.id].some((v) => String(v ?? '').toLowerCase().includes(needle)))
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) || String(b.id ?? '').localeCompare(String(a.id ?? '')));
  const per = PAGE_SIZES.includes(Number(size)) ? Number(size) : 25;
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return {
    total: rows.length, page: p, pages, size: per,
    items: rows.slice((p - 1) * per, p * per).map(({ id, tool, model, modelsReported, project, agent, startedAt, wallMs, ok, refused, error, usage, promptPreview, contentRemoved }) => ({
      id, tool, model, modelsReported, project, agent, startedAt, wallMs, ok, refused, error, usage, promptPreview, contentRemoved: !!contentRemoved, outcome: outcomeOf({ ok, refused, error }),
    })),
  };
}

function lastRun(records, pred) {
  for (let i = records.length - 1; i >= 0; i--) if (pred(records[i])) return records[i].startedAt;
  return null;
}
