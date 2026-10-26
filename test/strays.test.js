import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { etimeSeconds, findStrays } from '../src/strays.js';

test('ps elapsed times parse in every form ps prints', () => {
  assert.equal(etimeSeconds('00:05'), 5);
  assert.equal(etimeSeconds('12:34'), 754);
  assert.equal(etimeSeconds('01:00:00'), 3600);
  assert.equal(etimeSeconds('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(etimeSeconds('nonsense'), null);
});

test('only processes started since the task, in its folders, count; never a sibling folder', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nuncius-strays-test-')));
  const dir = path.join(base, 'task');
  const sibling = path.join(base, 'task-other'); // shares the prefix "task"
  fs.mkdirSync(dir);
  fs.mkdirSync(sibling);
  const old = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore', cwd: dir });
  await new Promise((r) => setTimeout(r, 2500));
  const since = Date.now();
  const fresh = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore', cwd: dir });
  const next = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore', cwd: sibling });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const pids = findStrays([dir], { since }).map((s) => s.pid);
    assert.ok(pids.includes(fresh.pid), 'a process started in the folder since the task');
    assert.ok(!pids.includes(old.pid), 'a process from before the task');
    assert.ok(!pids.includes(next.pid), 'a process in a folder that only shares the name prefix');
    assert.ok(!pids.includes(process.pid));
  } finally {
    for (const c of [old, fresh, next]) c.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
});
