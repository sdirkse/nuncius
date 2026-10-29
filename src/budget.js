import { localDay } from './log.js';
import { totalsFor, latestCodexLimits } from './summary.js';
import { readClaudeLimits } from './claude-limits.js';
import { TOOL_NAMES as NAMES } from './targets.js';

// A cap is a number; null, a missing key or anything that is not a number means "no cap".
const capOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const usedBy = (t, tool) => ({ tokens: t[`${tool}Tokens`], runs: t[`${tool}Runs`], minutes: t[`${tool}AgentMs`] / 60000 });

// Tasks that are queued or running have no usage record yet, but they will use the budget: each one
// counts as a run, and a running one adds the minutes it has run so far. Without this, tasks
// submitted at the same moment (from several MCP servers) would all pass a cap meant for one.
function addInFlight(used, tasks, now) {
  for (const t of tasks) {
    used.runs += 1;
    if (t.state === 'running' && t.startedAt) used.minutes += Math.max(0, now - Date.parse(t.startedAt)) / 60000 || 0;
  }
  return used;
}

function dailyCaps(reasons, scope, name, used, caps, capWord) {
  const tokens = capOf(caps.tokens), runs = capOf(caps.runs), minutes = capOf(caps.minutes);
  if (tokens !== null && used.tokens >= tokens) reasons.push(`${scope}${name} tokens today ${used.tokens} >= ${capWord} ${tokens}`);
  if (runs !== null && used.runs >= runs) reasons.push(`${scope}${name} runs today ${used.runs} >= ${capWord} ${runs}`);
  if (minutes !== null && used.minutes >= minutes) reasons.push(`${scope}${name} agent time today ${used.minutes.toFixed(0)} min >= ${capWord} ${minutes} min`);
}

// Returns a list of reasons the run should be refused; empty means go.
// codexLimits: pass latestCodexLimits() when the caller already has it (it reads rollout files).
// inFlight: the other tasks that are queued or running (not this one); they count as runs already.
export function checkBudget({ tool, project, config, records, now = new Date(), codexLimits, inFlight = [] }) {
  const reasons = [];
  const b = config.budgets;
  const today = localDay(now.toISOString());
  const isToday = (r) => localDay(r.startedAt) === today;
  const all = totalsFor(records, isToday);
  const proj = totalsFor(records, (r) => isToday(r) && r.project === project);
  // Own keys only: a project named "__proto__" or "constructor" is just a name.
  const projCaps = b.projects && Object.hasOwn(b.projects, String(project)) ? b.projects[project] ?? {} : {};

  const name = NAMES[tool];
  if (!name) return reasons;
  const g = b[tool] ?? {};

  // Subscription windows (Codex, Claude): refuse at or above the configured percentage.
  if (tool === 'codex' || tool === 'claude') {
    const limits = tool === 'codex' ? (codexLimits !== undefined ? codexLimits : latestCodexLimits()) : readClaudeLimits();
    for (const [key, label, max] of [
      ['primary', '5-hour window', g.max5HourPercent],
      ['secondary', 'weekly window', g.maxWeeklyPercent],
    ]) {
      const w = limits?.[key];
      if (!w || max == null) continue;
      // A window that has already reset no longer blocks.
      if (w.resetsAt && new Date(w.resetsAt) <= now) continue;
      if (w.usedPercent >= max)
        reasons.push(`${name} ${label} at ${w.usedPercent}% (limit ${max}%)${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`);
    }
  }

  // The same three daily caps for every tool, across all projects and per project.
  const mine = inFlight.filter((t) => t.target === tool);
  dailyCaps(reasons, '', name, addInFlight(usedBy(all, tool), mine, now.getTime()), { tokens: g.maxTokensPerDay, runs: g.maxRunsPerDay, minutes: g.maxAgentMinutesPerDay }, 'daily cap');
  dailyCaps(reasons, `Project ${project}: `, name, addInFlight(usedBy(proj, tool), mine.filter((t) => t.project === project), now.getTime()), {
    tokens: projCaps[tool]?.maxTokensPerDay, runs: projCaps[tool]?.maxRunsPerDay, minutes: projCaps[tool]?.maxAgentMinutesPerDay,
  }, 'cap');

  return reasons;
}
