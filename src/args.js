// Extra arguments a caller may pass through to a target after `--`.
// Allowlist, not denylist: anything that could change the sandbox, approvals or config
// (e.g. --dangerously-*, --sandbox, -c sandbox_mode=..., --profile, --force) is refused.
const ALLOWED = {
  codex: {
    valueFlags: new Set(['-m', '--model']),
    // `-c key=value` is Codex's generic config override; only these keys are safe.
    configKeys: new Set(['model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity']),
  },
  cursor: {
    valueFlags: new Set(['-m', '--model']),
    configKeys: new Set(),
  },
  claude: {
    valueFlags: new Set(['--model', '--max-turns']),
    configKeys: new Set(),
  },
};

const isSafeValue = (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('-') && /^[\w.:\-\/\[\]=]+$/.test(v);

// Returns { args } with the validated arguments, or { error } describing the first refused one.
export function checkExtraArgs(tool, extra) {
  const rules = ALLOWED[tool];
  const out = [];
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (rules.valueFlags.has(flag)) {
      const value = flag === a ? extra[++i] : a.slice(eq + 1);
      if (!isSafeValue(value)) return { error: `invalid value for ${flag}: ${JSON.stringify(value ?? '')}` };
      out.push(flag, value);
    } else if (a === '-c' && rules.configKeys.size) {
      const kv = extra[++i] ?? '';
      const key = kv.split('=')[0];
      if (!rules.configKeys.has(key) || !isSafeValue(kv.slice(key.length + 1))) return { error: `config override not allowed: -c ${kv}` };
      out.push('-c', kv);
    } else {
      return { error: `argument not allowed for ${tool}: ${a} (allowed: ${[...rules.valueFlags].join(', ')}${rules.configKeys.size ? `, -c ${[...rules.configKeys].join('|')}=<value>` : ''})` };
    }
  }
  return { args: out };
}
