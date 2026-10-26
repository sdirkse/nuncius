import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, versionCheck, VERIFIED } from '../src/versions.js';

test('parseVersion reads each CLI\'s --version output', () => {
  assert.equal(parseVersion('codex-cli 0.163.0'), '0.163.0');
  assert.equal(parseVersion('2026.10.16-e3cb207'), '2026.10.16');
  assert.equal(parseVersion('2.1.299 (Claude Code)'), '2.1.299');
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions compares numerically, not as text', () => {
  assert.equal(compareVersions('0.163.0', '0.163.0'), 0);
  assert.equal(compareVersions('0.170.0', '0.163.0'), 1);
  assert.equal(compareVersions('0.99.0', '0.163.0'), -1);
  assert.equal(compareVersions('2026.10.16', '2026.9.30'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
});

test('versionCheck: verified range is quiet, anything else gets a note', () => {
  for (const [target, { min, max }] of Object.entries(VERIFIED)) {
    assert.deepEqual(versionCheck(target, min), { version: min, verified: true, note: null });
    assert.equal(versionCheck(target, max).verified, true);
  }
  assert.match(versionCheck('codex', '0.170.0').note, /Codex 0\.170\.0 is newer than the versions nuncius was verified with \(0\.163\.0\)/);
  assert.match(versionCheck('claude', '2.0.1').note, /older than the versions nuncius was verified with/);
  assert.match(versionCheck('cursor', null).note, /could not read the Cursor version/);
});
