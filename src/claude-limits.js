import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { toIso, validPercent } from './codex-limits.js';

// Claude's subscription windows reach nuncius two ways: the statusline input of interactive sessions
// (`rate_limits.five_hour` / `rate_limits.seven_day`: used_percentage, resets_at in epoch seconds),
// which `nuncius statusline` writes here, and the rate_limit_event lines of every Claude task's own
// output. Budgets read the newest of them back.

export const claudeLimitsPath = () => path.join(dataDir(), 'claude-limits.json');

function window(w, windowMinutes) {
  if (!w || typeof w !== 'object') return null;
  const pct = validPercent(w.used_percentage ?? w.used_percent ?? w.usedPercent);
  if (pct === null) return null;
  return { usedPercent: pct, windowMinutes, resetsAt: w.resets_at === undefined ? null : toIso(w.resets_at) };
}

// From a statusline input object to our limits shape; null when it carries no rate limits.
export function limitsFromStatusline(input, now = new Date()) {
  const rl = input?.rate_limits;
  if (!rl) return null;
  const primary = window(rl.five_hour, 300);
  const secondary = window(rl.seven_day, 10080);
  if (!primary && !secondary) return null;
  return { observedAt: now.toISOString(), source: 'statusline', primary, secondary };
}

// From the `rate_limit_event` lines Claude Code prints in stream-json (`claude -p`, as nuncius runs
// it): rate_limit_info.unifiedWindows.{five_hour,seven_day} = { utilization: 0..1, resetsAt: epoch s }.
// The last event wins. Only top-level events count: those come from the claude CLI itself, while
// whatever the model or its commands produce is nested inside message objects.
// `now` is when the reading was taken; the runner passes the time the last event arrived.
export function rateLimitWindows(line) {
  if (!line.startsWith('{') || !line.includes('"rate_limit_event"')) return null; // cheap filter first
  try {
    const o = JSON.parse(line);
    const w = o?.type === 'rate_limit_event' ? o.rate_limit_info?.unifiedWindows : null;
    return w && typeof w === 'object' ? w : null;
  } catch {
    return null; // not JSON
  }
}

export function limitsFromStreamJson(stdout, now = new Date()) {
  let windows = null;
  for (const line of String(stdout ?? '').split('\n')) windows = rateLimitWindows(line) ?? windows;
  if (!windows) return null;
  const fromFraction = (w, minutes) => {
    if (!w || typeof w !== 'object' || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
    return window({ used_percentage: Math.round(w.utilization * 1000) / 10, resets_at: w.resetsAt }, minutes);
  };
  const primary = fromFraction(windows.five_hour, 300);
  const secondary = fromFraction(windows.seven_day, 10080);
  if (!primary && !secondary) return null;
  return { observedAt: now.toISOString(), source: 'claude task', primary, secondary };
}

// Store a reading unless a newer one is already there (the statusline bridge writes too).
export function recordClaudeLimits(limits) {
  if (!limits) return readClaudeLimits();
  const current = readClaudeLimits();
  if (current?.observedAt && Date.parse(current.observedAt) > Date.parse(limits.observedAt)) return current;
  writeClaudeLimits(limits);
  return limits;
}

export function writeClaudeLimits(limits) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${claudeLimitsPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(limits, null, 2));
  fs.renameSync(tmp, claudeLimitsPath());
}

// When the bridge last ran and whether that input carried rate limits.
const bridgeSeenPath = () => path.join(dataDir(), 'statusline-seen.json');

export function writeBridgeSeen(seen) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${bridgeSeenPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seen));
  fs.renameSync(tmp, bridgeSeenPath());
}

export function readBridgeSeen() {
  try {
    return JSON.parse(fs.readFileSync(bridgeSeenPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Why Claude limits are missing, in one sentence for `nuncius status` and the dashboard.
export function claudeLimitsHint({ installed, seen }) {
  if (!installed) return 'They are recorded with the next Claude task, or run `nuncius install-statusline` so nuncius also sees them from your terminal sessions. Until then the daily caps apply.';
  if (!seen) return 'The bridge is installed but has not run yet. Claude Code runs it in an interactive terminal session (`claude`); the desktop app and IDE extensions may not. Open `claude` in a terminal and send one message.';
  if (!seen.rateLimits) return `The bridge last ran ${seen.at}, but Claude Code sent no limits. It only does so for Pro and Max subscriptions (not API keys), after the first reply in a session.`;
  return 'Limits were seen but could not be stored; check that ~/.nuncius is writable.';
}

export function readClaudeLimits() {
  try {
    return JSON.parse(fs.readFileSync(claudeLimitsPath(), 'utf8'));
  } catch {
    return null;
  }
}
