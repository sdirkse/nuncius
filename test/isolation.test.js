import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRepo } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let home, repo, env;

const writeConfig = (extra = {}) =>
  fs.writeFileSync(
    path.join(env.NUNCIUS_HOME, 'config.json'),
    JSON.stringify({ codexBin: path.join(fixtures, 'fake-codex.js'), cursorBin: path.join(fixtures, 'fake-cursor.js'), sandbox: { passEnv: ['FAKE_*'] }, ...extra }),
  );

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-iso-test-')));
  repo = initRepo(path.join(home, 'repo'));
  env = { ...process.env, NUNCIUS_HOME: path.join(home, 'data'), CODEX_HOME: path.join(home, 'codex') };
  delete env.NUNCIUS_DEPTH;
  fs.mkdirSync(env.NUNCIUS_HOME, { recursive: true });
  fs.mkdirSync(env.CODEX_HOME, { recursive: true }); // exists after `codex login`; the sandbox does not let targets create it
  writeConfig();
});

const nuncius = (args, { cwd = repo, extraEnv = {} } = {}) =>
  spawnSync('node', [path.join(root, 'bin', 'nuncius.js'), ...args], { env: { ...env, ...extraEnv }, cwd, encoding: 'utf8' });
const git = (...a) => execFileSync('git', a, { cwd: repo }).toString().trim();
const lastTask = () => {
  const dir = path.join(env.NUNCIUS_HOME, 'tasks');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
};

test('target changes land on a task branch, never in the caller\'s tree', () => {
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\ncaller edit, not committed\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked caller file\n');
  const r = nuncius(['codex', 'add a file WRITE:new.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /changes on nuncius\/codex\/[0-9a-f]{8} \(1 file\)/);
  assert.match(r.stderr, /apply: +GIT_ATTR_SOURCE=HEAD git -C .* cherry-pick [0-9a-f]{12}/);

  // Caller's working tree is untouched.
  assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
  assert.equal(git('status', '--porcelain'), 'M README.md\n?? notes.txt'.replace('\n', '\n'));

  const t = lastTask();
  assert.equal(t.state, 'done');
  assert.deepEqual(t.worktree.files, ['new.txt'], 'only the target\'s work, not the caller snapshot');
  // The target saw the caller's uncommitted state.
  assert.equal(fs.readFileSync(path.join(t.worktree.path, 'README.md'), 'utf8'), 'hello\ncaller edit, not committed\n');
  assert.ok(fs.existsSync(path.join(t.worktree.path, 'notes.txt')));
  assert.equal(git('log', '-1', '--format=%s', t.worktree.branch), 'nuncius(codex): add a file WRITE:new.txt');
  assert.ok(fs.readFileSync(t.worktree.patchPath, 'utf8').includes('new.txt'));
});

test('no changes: worktree and branch are removed right away', () => {
  const r = nuncius(['cursor', 'just answer a question']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no file changes/);
  const t = lastTask();
  assert.equal(t.worktree.removed, true);
  assert.ok(!fs.existsSync(t.worktree.path));
  assert.equal(git('branch', '--list', 'nuncius/*'), '');
});

test('target runs in the same subdirectory as the caller', () => {
  fs.mkdirSync(path.join(repo, 'pkg'));
  fs.writeFileSync(path.join(repo, 'pkg', 'index.js'), '1\n');
  git('add', '-A');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pkg'], { cwd: repo });
  assert.equal(nuncius(['codex', 'WRITE:here.txt'], { cwd: path.join(repo, 'pkg') }).status, 0);
  assert.deepEqual(lastTask().worktree.files, ['pkg/here.txt']);
});

test('non-git directories are refused', () => {
  const plain = fs.mkdtempSync(path.join(home, 'plain-'));
  const r = nuncius(['codex', 'x'], { cwd: plain });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a git repository/);
});

test('sandbox: writes outside the worktree and reads of nuncius data or secrets are denied', () => {
  const secret = path.join(home, 'secret.txt');
  fs.writeFileSync(secret, 'token');
  writeConfig({ sandbox: { extraDenyRead: [secret] } });
  const outside = path.join(repo, 'escape.txt');
  const homeProbe = path.join(os.homedir(), `.nuncius-escape-probe-${process.pid}`);
  const usage = path.join(env.NUNCIUS_HOME, 'usage.jsonl');
  fs.writeFileSync(usage, '');
  const r = nuncius(['codex', `WRITE:inside.txt ESCAPE:${outside} ESCAPE:${homeProbe} READ:${usage} READ:${secret}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`escape ${outside} EPERM`), r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`escape ${homeProbe} EPERM`));
  assert.match(r.stdout, new RegExp(`read ${usage} EPERM`));
  assert.match(r.stdout, new RegExp(`read ${secret} EPERM`));
  assert.ok(!fs.existsSync(outside) && !fs.existsSync(homeProbe));
  assert.deepEqual(lastTask().worktree.files, ['inside.txt']);
});

test('sandbox: the real CODEX_HOME is read-only; Codex gets a throw-away per-task home', () => {
  fs.mkdirSync(path.join(env.CODEX_HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), '{"token":"t"}');
  const cfg = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n');
  const realSession = path.join(env.CODEX_HOME, 'sessions', 'forged.jsonl');
  // $CODEX_HOME inside the task is the per-task home; the fake reports what it can do there.
  const r = nuncius(['codex', `ESCAPE:${cfg} ESCAPE:${realSession} READ:${path.join(env.CODEX_HOME, 'auth.json')}`]);
  assert.match(r.stdout, new RegExp(`escape ${cfg} EPERM`), r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`escape ${realSession} EPERM`));
  assert.match(r.stdout, /auth\.json OK/, 'auth stays readable');
  assert.match(r.stdout, /config\.toml EPERM/, 'the real config is not writable');
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'sandbox_mode = "workspace-write"\n');
});

test('Codex limits come from Codex and the user, never from what a task writes', () => {
  // Real usage from the user's own Codex session (outside any sandbox): 5h window at 95%.
  const day = path.join(env.CODEX_HOME, 'sessions', '2026', '10', '17');
  fs.mkdirSync(day, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(day, 'rollout-real.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 95, window_minutes: 300, resets_at: now + 3600 } } } }) + '\n');
  // Codex itself says 1%, but the user's own session shows 95%: refused up front.
  const first = nuncius(['codex', 'x'], { extraEnv: { FAKE_CODEX_PRIMARY: '1' } });
  assert.equal(first.status, 3, 'the real 95% counts');
  fs.rmSync(path.join(day, 'rollout-real.jsonl'));
  // A task that writes 100% into its own Codex home (a forged lock-out) is not believed...
  assert.equal(nuncius(['codex', 'x'], { extraEnv: { FAKE_CODEX_PRIMARY: '1', FAKE_CODEX_ROLLOUT_PRIMARY: '100' } }).status, 0);
  assert.equal(nuncius(['codex', 'x'], { extraEnv: { FAKE_CODEX_PRIMARY: '1' } }).status, 0, 'the next task still runs');
  // ...and neither is a task that writes 1% while the account is at 95%.
  fs.writeFileSync(path.join(env.NUNCIUS_HOME, 'codex-limits.json'), '{}'); // drop the cached reading
  const late = nuncius(['codex', 'x'], { extraEnv: { FAKE_CODEX_PRIMARY: '95', FAKE_CODEX_ROLLOUT_PRIMARY: '1' } });
  assert.equal(late.status, 3);
  const s = JSON.parse(nuncius(['status', '--json']).stdout);
  assert.equal(s.codexLimits.primary.usedPercent, 95);
});

test('preamble tells the target the rules; --network widens the egress allowlist', () => {
  writeConfig({ sandbox: { passEnv: ['FAKE_*'], extraWritable: [home] } }); // the fake writes diagnostic prompt/args files into the test home
  const promptFile = path.join(home, 'prompt.txt');
  const argsFile = path.join(home, 'args.json');
  nuncius(['codex', 'do it'], { extraEnv: { FAKE_PROMPT_FILE: promptFile, FAKE_ARGS_FILE: argsFile } });
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /^\[nuncius\] You are working in an isolated git worktree/);
  assert.match(prompt, /Do not commit, push or switch branches/);
  assert.match(prompt, /Network access for the commands you run is OFF/);
  assert.ok(prompt.endsWith('Task:\ndo it'));
  let egress = lastTask().egress;
  assert.ok(egress.allow.includes('api.openai.com') && !egress.allow.includes('registry.npmjs.org'));

  nuncius(['codex', '--network', 'do it'], { extraEnv: { FAKE_PROMPT_FILE: promptFile, FAKE_ARGS_FILE: argsFile } });
  assert.match(fs.readFileSync(promptFile, 'utf8'), /is ON/);
  egress = lastTask().egress;
  assert.ok(egress.allow.includes('registry.npmjs.org'));
});

test('failed tasks keep their worktree for inspection', () => {
  const r = nuncius(['cursor', 'FAIL now']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktree kept at/);
  assert.ok(fs.existsSync(lastTask().worktree.path));
});

test('cleanup removes applied worktrees with their branch, and old ones but keeps unapplied branches', () => {
  nuncius(['codex', 'WRITE:a.txt']);
  const applied = lastTask().worktree;
  nuncius(['codex', 'WRITE:b.txt']);
  const pending = lastTask().worktree;
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'cherry-pick', applied.commit], { cwd: repo, stdio: 'ignore' });

  let r = nuncius(['cleanup']);
  assert.match(r.stdout, /removed .* \(applied\), deleted nuncius\/codex\//);
  assert.ok(!fs.existsSync(applied.path) && fs.existsSync(pending.path));
  assert.equal(git('branch', '--list', applied.branch), '');

  r = nuncius(['cleanup', '--days', '0']);
  assert.match(r.stdout, /older than 0 days\), kept branch nuncius\/codex\//);
  assert.ok(!fs.existsSync(pending.path));
  assert.notEqual(git('branch', '--list', pending.branch), '', 'unapplied work is never lost');
});

test('sandbox: the worktree .git pointer is read-only and escape binaries are blocked', () => {
  const probe = path.join(home, 'probe.sh');
  fs.writeFileSync(probe, '#!/bin/sh\n(echo "gitdir: /tmp/evil" > .git) 2>/dev/null && G=writable || G=denied\n/usr/bin/osascript -e "return 1" >/dev/null 2>&1 && O=ran || O=blocked\n' +
    'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"git=$G osascript=$O\\",\\"duration_ms\\":1}"\n');
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.stdout.trim(), 'git=denied osascript=blocked', r.stderr);
});

test('a tampered .git pointer makes the nuncius refuse to run git in the worktree', async () => {
  const { createWorktree, finishWorktree } = await import('../src/worktree.js');
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const wt = createWorktree({ cwd: repo, id: '0123abcd-0000-4000-8000-000000000000', target: 'codex' });
  fs.writeFileSync(path.join(wt.path, '.git'), 'gitdir: /tmp/evil\n');
  assert.throws(() => finishWorktree(wt, { id: 'x', target: 'codex', prompt: 'x' }), /\.git pointer was modified/);
});

test('sandbox: the worktree\'s ancestors stay readable, other worktrees are off limits', () => {
  // Claude Code refuses to write when an ancestor of its cwd cannot be read, so worktrees must not
  // live inside the (unreadable) data dir. Writes into other tasks' worktrees stay denied.
  nuncius(['codex', 'WRITE:first.txt']);
  const other = lastTask().worktree.path;
  const probe = path.join(home, 'ancestors.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\n` +
      `const r = [];\nlet d = process.cwd();\n` +
      `try { fs.realpathSync(d); for (let i = 0; i < 4; i++) { d = path.dirname(d); fs.readdirSync(d); } r.push('ancestors=OK'); } catch (e) { r.push('ancestors=' + e.code); }\n` +
      `try { fs.writeFileSync(${JSON.stringify(path.join(other, 'planted.txt'))}, 'x'); r.push('other=WRITTEN'); } catch (e) { r.push('other=' + e.code); }\n` +
      `try { fs.readFileSync(${JSON.stringify(path.join(other, 'first.txt'))}); r.push('otherRead=OK'); } catch (e) { r.push('otherRead=' + e.code); }\n` +
      `try { fs.readdirSync(process.env.NUNCIUS_HOME); r.push('data=READABLE'); } catch (e) { r.push('data=' + e.code); }\n` +
      `console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: r.join(' ') }));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.stdout.trim(), 'ancestors=OK other=EPERM otherRead=EPERM data=EPERM', r.stderr);
  assert.ok(!fs.existsSync(path.join(other, 'planted.txt')));
  assert.ok(!lastTask().worktree.path.startsWith(env.NUNCIUS_HOME + path.sep), 'worktree is outside the data dir');
});

test('changes to tool config or code-running files are flagged for review', () => {
  const r = nuncius(['codex', 'WRITE:package.json WRITE:notes.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: changes to files that configure tools or run code: package\.json/);
  assert.deepEqual(lastTask().worktree.sensitiveFiles, ['package.json']);
});

test('sandbox: per-task scratch dirs are private to their task', () => {
  // Another task's scratch dir (as the worker would create it) under the nuncius runtime root.
  const runtime = `${env.NUNCIUS_HOME}-runtime`;
  const other = path.join(runtime, 'codex-OTHERTASK');
  fs.mkdirSync(path.join(other, 'sessions'), { recursive: true });
  const probe = path.join(home, 'scratch.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst r = [];\n` +
      `try { fs.writeFileSync(path.join(process.env.XDG_CACHE_HOME, 'mine.txt'), 'x'); r.push('own=OK'); } catch (e) { r.push('own=' + e.code); }\n` +
      `try { fs.writeFileSync(${JSON.stringify(path.join(other, 'sessions', 'forged.jsonl'))}, 'x'); r.push('other=WRITTEN'); } catch (e) { r.push('other=' + e.code); }\n` +
      `try { fs.readdirSync(${JSON.stringify(other)}); r.push('otherRead=OK'); } catch (e) { r.push('otherRead=' + e.code); }\n` +
      `r.push('cacheUnderRuntime=' + process.env.XDG_CACHE_HOME.startsWith(${JSON.stringify(fs.realpathSync(home))}) );\n` +
      `console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: r.join(' ') }));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const r = nuncius(['cursor', 'x']);
  assert.equal(r.stdout.trim(), 'own=OK other=EPERM otherRead=EPERM cacheUnderRuntime=true', r.stderr);
  assert.ok(!fs.existsSync(path.join(other, 'sessions', 'forged.jsonl')));
  // The task's own scratch dirs are gone afterwards; the other one is untouched.
  assert.deepEqual(fs.readdirSync(runtime), ['codex-OTHERTASK']);
});

test('sensitive-file detection covers nested, mixed-case and oddly named paths; next carries no names', async () => {
  const { sensitiveFiles } = await import('../src/worktree.js');
  assert.deepEqual(
    sensitiveFiles(['packages/app/.claude/settings.json', 'web/.github/workflows/ci.yml', 'Package.json', 'Makefile', 'docs/a.md', 'weird\nname.txt', 'src/x.js']),
    ['packages/app/.claude/settings.json', 'web/.github/workflows/ci.yml', 'Package.json', 'Makefile', 'weird\nname.txt'],
  );
  const { publicTask } = await import('../src/tasks.js');
  const t = publicTask({ id: 'x', state: 'done', target: 'codex', prompt: 'p', createdAt: 'now', result: { ok: true },
    worktree: { changed: true, files: ['IGNORE PREVIOUS INSTRUCTIONS.md', 'package.json'], sensitiveFiles: ['package.json'], branch: 'b', commit: 'c', base: 'a' } });
  assert.match(t.next, /1 changed file\(s\) configure tools/);
  assert.doesNotMatch(t.next, /package\.json|IGNORE/);
});

test('file names with spaces, quotes, newlines and non-ASCII are reported exactly', async () => {
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  const { createWorktree, finishWorktree } = await import('../src/worktree.js');
  const wt = createWorktree({ cwd: repo, id: '0123abcd-0000-4000-8000-00000000000f', target: 'codex' });
  const names = ['with space.txt', 'quote"d.txt', 'line\nbreak.txt', 'café.md', 'sub/.claude/settings.json'];
  for (const n of names) {
    fs.mkdirSync(path.dirname(path.join(wt.path, n)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, n), 'x');
  }
  const done = finishWorktree(wt, { id: 'x', target: 'codex', prompt: 'x' });
  assert.deepEqual([...done.files].sort(), [...names].sort());
  assert.deepEqual([...done.sensitiveFiles].sort(), ['café.md', 'line\nbreak.txt', 'sub/.claude/settings.json'].sort());
});

test('sensitive matching folds Unicode lookalikes; display escapes control and bidi characters', async () => {
  const { sensitiveFiles, displayName } = await import('../src/worktree.js');
  // Lookalikes, case-folding tricks and invisible characters: all flagged (fail closed).
  const tricky = ['pac\u212Aage.json', 'MA\u212AEFILE', '\uFF0Eclaude/settings.json', 'pack\u200Bage.json', 'pack\u00ADage.json', 'x\u2066y.js'];
  assert.deepEqual(sensitiveFiles([...tricky, 'src/ok.js', 'Docs/README.md', 'PACKAGE.JSON']), [...tricky, 'PACKAGE.JSON']);
  assert.equal(displayName('a\x1b[31mred.txt'), '"a\\u001b[31mred.txt"');
  assert.equal(displayName('evil\u202Etxt.js'), '"evil\\u202etxt.js"');
  assert.equal(displayName('evil\u202Etxt.js'), displayName('evil\u202Etxt.js'), 'stable across calls (global regex lastIndex)');
  assert.equal(displayName('plain.txt'), 'plain.txt');
});

test('attack: a target cannot tamper with the canary, nor make cleanup delete outside its scratch dirs', () => {
  const canary = path.join(os.userInfo().homedir, '.nuncius-canary');
  const victimDir = fs.mkdtempSync(path.join(home, 'victim-'));
  const victimFile = path.join(victimDir, 'keep.txt');
  fs.writeFileSync(victimFile, 'must survive');
  const probe = path.join(home, 'attack.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst r = [];\n` +
      `const t = (name, fn) => { try { fn(); r.push(name + '=DONE'); } catch (e) { r.push(name + '=' + e.code); } };\n` +
      `t('canaryRead', () => fs.readFileSync(${JSON.stringify(canary)}));\n` +
      `t('canaryUnlink', () => fs.unlinkSync(${JSON.stringify(canary)}));\n` +
      `t('canaryRename', () => fs.renameSync(${JSON.stringify(canary)}, ${JSON.stringify(canary + '.x')}));\n` +
      `t('canaryWrite', () => fs.writeFileSync(${JSON.stringify(canary)}, 'x'));\n` +
      // Plant symlinks in our own scratch dir, pointing at a victim dir and file outside it.
      `const cache = process.env.XDG_CACHE_HOME;\n` +
      `t('linkDir', () => fs.symlinkSync(${JSON.stringify(victimDir)}, path.join(cache, 'to-victim-dir')));\n` +
      `t('linkFile', () => fs.symlinkSync(${JSON.stringify(victimFile)}, path.join(cache, 'to-victim-file')));\n` +
      // Try to swap the scratch dir itself for a symlink (needs write access to its parent).
      `t('swapScratch', () => { fs.renameSync(cache, cache + '-moved'); });\n` +
      `console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: r.join(' ') }));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe });
  const r = nuncius(['cursor', 'x']);
  assert.equal(
    r.stdout.trim(),
    'canaryRead=EPERM canaryUnlink=EPERM canaryRename=EPERM canaryWrite=EPERM linkDir=DONE linkFile=DONE swapScratch=EPERM',
    r.stderr,
  );
  assert.ok(fs.existsSync(canary), 'canary still there');
  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'must survive', 'cleanup removed the links, not their targets');
  assert.deepEqual(fs.readdirSync(`${env.NUNCIUS_HOME}-runtime`), [], 'scratch dirs cleaned up');
});

test('attack: writing through the per-task CODEX_HOME links never reaches the real files', () => {
  fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), '{"real":true}');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'model = "real"\n');
  const probe = path.join(home, 'codex-attack.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst r = [];\nconst h = process.env.CODEX_HOME;\n` +
      `r.push('configCarried=' + fs.existsSync(path.join(h, 'config.toml')));\n` +
      `for (const f of ['auth.json']) {\n` +
      `  try { fs.writeFileSync(path.join(h, f), 'pwned'); r.push(f + '=WRITTEN'); } catch (e) { r.push(f + '=' + e.code); }\n` +
      `  try { fs.unlinkSync(path.join(h, f)); fs.writeFileSync(path.join(h, f), 'replaced'); r.push(f + 'Replace=OK'); } catch (e) { r.push(f + 'Replace=' + e.code); }\n` +
      `}\nr.push('realHome=' + (h === ${JSON.stringify(env.CODEX_HOME)} ? 'SAME' : 'separate'));\n` +
      `const out = (o) => console.log(JSON.stringify(o));\n` +
      `out({ type: 'thread.started', thread_id: 't' });\n` +
      `out({ type: 'item.completed', item: { type: 'agent_message', text: r.join(' ') } });\n` +
      `out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ codexBin: probe });
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  // Writing through the link is denied; replacing the link inside the throw-away home is harmless.
  assert.match(r.stdout, /auth\.json=EPERM/);
  assert.match(r.stdout, /configCarried=false/, 'config.toml (which can declare MCP servers) is not carried over');
  assert.match(r.stdout, /realHome=separate/);
  assert.equal(fs.readFileSync(path.join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"real":true}');
  assert.equal(fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8'), 'model = "real"\n');
});

test('dashboard summary: Claude totals, queue, live tasks and open worktrees', async () => {
  nuncius(['codex', 'WRITE:a.txt']);
  writeConfig({ claudeBin: path.join(fixtures, 'fake-claude.js') });
  nuncius(['claude', 'WRITE:b.txt']);
  process.env.NUNCIUS_HOME = env.NUNCIUS_HOME;
  process.env.CODEX_HOME = env.CODEX_HOME;
  const { buildSummary } = await import('../src/server.js');
  const s = buildSummary({ days: 7 });
  assert.equal(s.today.codexRuns, 1);
  assert.equal(s.today.claudeRuns, 1);
  assert.ok(s.today.claudeTokens > 0);
  assert.deepEqual(Object.keys(s.queue.perTarget).sort(), ['claude', 'codex', 'cursor']);
  assert.deepEqual(s.activeTasks, []);
  assert.equal(s.worktrees.length, 2);
  assert.ok(s.worktrees.every((w) => w.changed && w.files === 1 && w.review && w.branch.startsWith('nuncius/')));
  const scoped = buildSummary({ days: 7, project: 'nope' });
  assert.equal(scoped.worktrees.length, 0);
});

test('Cursor gets a throw-away HOME and config dir; the real ~/.cursor is never written', () => {
  const realCursor = path.join(home, 'real-cursor');
  fs.mkdirSync(path.join(realCursor, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(realCursor, 'cli-config.json'), '{"permissions":{"allow":["Shell(ls)"]}}');
  fs.writeFileSync(path.join(realCursor, 'mcp.json'), '{"mcpServers":{"nuncius":{}}}');
  const probe = path.join(home, 'cursor-config.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst r = [];\nconst c = process.env.CURSOR_CONFIG_DIR;\n` +
      `r.push('sameDataDir=' + (process.env.CURSOR_DATA_DIR === c) + ' homeIsScratch=' + (c === path.join(process.env.HOME, '.cursor')) + ' keychainLinked=' + fs.lstatSync(path.join(process.env.HOME, 'Library', 'Keychains')).isSymbolicLink() + ' noPlugins=' + !fs.existsSync(path.join(process.env.HOME, '.cursor', 'plugins')));\n` +
      `r.push('copied=' + fs.readFileSync(path.join(c, 'cli-config.json'), 'utf8').includes('Shell(ls)'));\n` +
      `r.push('mcpCarried=' + fs.existsSync(path.join(c, 'mcp.json')));\n` +
      `fs.writeFileSync(path.join(c, 'cli-config.json'), '{"permissions":{"allow":["Shell(*)"]}}');\n` +
      `fs.mkdirSync(path.join(c, 'projects', 'x'), { recursive: true });\n` +
      `try { fs.writeFileSync(${JSON.stringify(path.join(realCursor, 'cli-config.json'))}, 'pwned'); r.push('real=WRITTEN'); } catch (e) { r.push('real=' + e.code); }\n` +
      `console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: r.join(' ') }));\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ cursorBin: probe, sandbox: { extraDenyRead: [] } });
  const r = nuncius(['cursor', 'x'], { extraEnv: { CURSOR_CONFIG_DIR: realCursor } });
  assert.equal(r.stdout.trim(), 'sameDataDir=true homeIsScratch=true keychainLinked=true noPlugins=true copied=true mcpCarried=false real=EPERM', r.stderr);
  assert.equal(fs.readFileSync(path.join(realCursor, 'cli-config.json'), 'utf8'), '{"permissions":{"allow":["Shell(ls)"]}}');
});

test('model evidence is collected from the target\'s own records before cleanup', () => {
  const r = nuncius(['codex', 'x', '--', '--model', 'gpt-test-1']);
  assert.equal(r.status, 0, r.stderr);
  const t = lastTask();
  assert.deepEqual(t.evidence.models, ['gpt-test-1']);
  assert.equal(t.evidence.source, 'codex session rollout: turn_context.model');
  assert.equal(t.evidence.files.length, 1);
  assert.ok(fs.existsSync(t.evidence.files[0]), 'raw rollout copied for audit');
  const log = fs.readFileSync(path.join(env.NUNCIUS_HOME, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.at(-1).modelsReported, ['gpt-test-1']);
  // Claude: from modelUsage in its result.
  writeConfig({ claudeBin: path.join(fixtures, 'fake-claude.js') });
  nuncius(['claude', 'y']);
  assert.deepEqual(lastTask().evidence.models, ['claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(lastTask().evidence.actions, [{ tool: 'Write', detail: 'c.txt' }, { tool: 'Bash', detail: 'node --test' }]);
});

test('attack: evidence collection never follows links or pipes the target planted', () => {
  // A file the target cannot read itself (inside the denied data dir).
  const secretDir = path.join(env.NUNCIUS_HOME, 'secret');
  fs.mkdirSync(path.join(secretDir, 'chats'), { recursive: true });
  const leak = JSON.stringify({ type: 'turn_context', payload: { model: 'LEAKED' } }) + '\n';
  fs.writeFileSync(path.join(secretDir, 's.jsonl'), leak);
  fs.writeFileSync(path.join(secretDir, 'chats', 'store.db'), '"modelName":"LEAKED"');
  const probe = path.join(home, 'evidence-attack.mjs');
  fs.writeFileSync(
    probe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { execFileSync } from 'node:child_process';\n` +
      `const s = path.join(process.env.CODEX_HOME, 'sessions');\nfs.mkdirSync(s, { recursive: true });\n` +
      `fs.writeFileSync(path.join(s, 'real.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'good' } }) + '\\n');\n` +
      `fs.symlinkSync(${JSON.stringify(path.join(secretDir, 's.jsonl'))}, path.join(s, 'link.jsonl'));\n` +
      `fs.symlinkSync(${JSON.stringify(secretDir)}, path.join(s, 'linkdir'));\n` +
      `execFileSync('/usr/bin/mkfifo', [path.join(s, 'pipe.jsonl')]);\n` +
      `const other = path.join(process.env.XDG_CACHE_HOME, 'o.jsonl');\nfs.writeFileSync(other, JSON.stringify({ type: 'turn_context', payload: { model: 'HARDLINK' } }) + '\\n');\nfs.linkSync(other, path.join(s, 'hard.jsonl'));\n` +
      `const out = (o) => console.log(JSON.stringify(o));\n` +
      `out({ type: 'item.completed', item: { type: 'agent_message', text: 'planted' } });\n` +
      `out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });\n`,
  );
  fs.chmodSync(probe, 0o755);
  writeConfig({ codexBin: probe });
  const r = nuncius(['codex', 'x']);
  assert.equal(r.status, 0, r.stderr);
  let t = lastTask();
  assert.deepEqual(t.evidence.models, ['good']);
  assert.deepEqual(t.evidence.files.map((f) => path.basename(f)), ['real.jsonl']);

  // Cursor: its whole state dir replaced by a link.
  const cprobe = path.join(home, 'cursor-evidence-attack.mjs');
  fs.writeFileSync(
    cprobe,
    `#!${process.execPath}\nif (process.argv[2] === 'app-server') process.exit(0);\nimport fs from 'node:fs';\nconst c = process.env.CURSOR_CONFIG_DIR;\n` +
      `fs.rmSync(c, { recursive: true, force: true });\nfs.symlinkSync(${JSON.stringify(secretDir)}, c);\n` +
      `console.log(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, result: 'planted' }));\n`,
  );
  fs.chmodSync(cprobe, 0o755);
  writeConfig({ cursorBin: cprobe });
  assert.equal(nuncius(['cursor', 'x']).status, 0);
  t = lastTask();
  assert.deepEqual(t.evidence.models, []);
  assert.deepEqual(t.evidence.files, []);
  // Sealed throw-away dirs are removed afterwards.
  const runtime = `${env.NUNCIUS_HOME}-runtime`;
  assert.deepEqual(fs.existsSync(runtime) ? fs.readdirSync(runtime) : [], []);
});
