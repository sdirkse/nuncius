import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's user settings, which install-statusline and install-hook edit.
export const claudeSettingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8')); // throws on invalid JSON: never overwrite what we can't read
}

// Atomic, but in place of the real file: a settings.json that is a symlink (dotfiles repo) stays a
// link and its target is updated, and the file keeps its permissions.
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let dest = p;
  let mode = 0o600;
  try {
    dest = fs.realpathSync(p);
    mode = fs.statSync(dest).mode & 0o7777;
  } catch {
    // new file
  }
  const tmp = `${dest}.nuncius.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode); // writeFileSync's mode is filtered by the umask
  fs.renameSync(tmp, dest);
}

// Commands Claude Code runs go through a shell, so paths in them are single-quoted.
export { shQuote } from './worktree.js';

// The node binary for commands written into settings.json. process.execPath is the resolved,
// versioned path (e.g. /opt/homebrew/Cellar/node/26.0.0/bin/node), which disappears on the next Node
// upgrade; a `node` on PATH that resolves to the same binary (e.g. /opt/homebrew/bin/node) survives it.
export function stableNode(execPath = process.execPath, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (candidate !== execPath && fs.realpathSync(candidate) === fs.realpathSync(execPath)) return candidate;
    } catch {
      // not there
    }
  }
  return execPath;
}
