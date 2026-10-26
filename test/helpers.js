import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A git repo with one commit, so tasks can get a worktree.
export function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}
