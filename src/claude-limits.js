import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { toIso, validPercent } from './codex-limits.js';

// Claude's subscription windows are only exposed to interactive sessions, in the statusline input
// (`rate_limits.five_hour` / `rate_limits.seven_day`: used_percentage, resets_at in epoch seconds).
// `nuncius statusline` sits in the user's statusline and writes them here; budgets read them back.

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
  if (!installed) return 'Run `nuncius install-statusline` so nuncius sees your 5-hour and weekly limits. Until then the daily caps apply.';
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
