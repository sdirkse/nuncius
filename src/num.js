// Numbers from target output (usage, durations) are untrusted: only finite, non-negative numbers
// count, anything else is 0. A negative or NaN count must never lower a total and reopen a budget.
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
// A token count above this per run is not plausible (a long agent run uses millions, not billions):
// clamped, so one forged number cannot poison a day's totals and lock a tool out.
export const MAX_RUN_TOKENS = 1e9;
export const tokens = (v) => Math.min(num(v), MAX_RUN_TOKENS);

// A run cannot plausibly use more tokens than its own run time allows. Heavy real runs use well under
// a million tokens a minute (cached input included); this allows five times that, with a floor for
// short runs. Applied with nuncius's own clock, so a forged count adds at most what the run could have.
export const MAX_TOKENS_PER_MINUTE = 5e6;
export const MIN_TOKEN_ALLOWANCE = 1e6;
export function clampRunUsage(usage, wallMs) {
  if (!usage || typeof usage !== 'object') return usage;
  const cap = Math.min(MAX_RUN_TOKENS, Math.max(MIN_TOKEN_ALLOWANCE, (num(wallMs) / 60000) * MAX_TOKENS_PER_MINUTE));
  const total = num(usage.inputTokens) + num(usage.outputTokens);
  if (total <= cap) return usage;
  const f = cap / total;
  const out = { ...usage, clamped: true };
  for (const k of ['inputTokens', 'cachedInputTokens', 'outputTokens']) if (k in usage) out[k] = Math.floor(num(usage[k]) * f);
  out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}
