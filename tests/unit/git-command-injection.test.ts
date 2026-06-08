import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isValidGitSha, safeStartRef } from '../../src/commands/session-end.js';
import { generateAgentReleaseNotes } from '../../src/commands/release-notes.js';

// Security regression (Socket alert 2026-06-08, medium): git refs / snapshot
// git_sha were interpolated into execSync shell-strings → command injection.
// Fix: execFileSync (no shell) everywhere + git_sha validated as a hex SHA.

describe('git_sha validation (Socket 2026-06-08)', () => {
  it('accepts plain hex SHAs', () => {
    assert.equal(isValidGitSha('a1b2c3d'), true);
    assert.equal(isValidGitSha('0123456789abcdef0123456789abcdef01234567'), true);
  });

  it('rejects anything with shell metacharacters or non-hex content', () => {
    for (const evil of [
      '; touch PWNED',
      '$(touch PWNED)',
      '`touch PWNED`',
      'HEAD&&calc',
      'abc | rm -rf /',
      'main',            // a branch name, not a SHA
      '',
      undefined,
    ]) {
      assert.equal(isValidGitSha(evil as string | undefined), false, `must reject: ${String(evil)}`);
    }
  });

  it('safeStartRef falls back to a safe literal for untrusted input', () => {
    assert.equal(safeStartRef('$(touch PWNED)'), 'HEAD~10');
    assert.equal(safeStartRef(undefined), 'HEAD~10');
    assert.equal(safeStartRef('deadbeef'), 'deadbeef'); // valid SHA passes through
  });
});

describe('git calls do not execute injected shell (execFileSync, no shell)', () => {
  it('a malicious `since` ref in generateAgentReleaseNotes runs no injected command', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-inject-'));
    const sentinel = path.join(repo, 'PWNED');
    const git = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    try {
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);

      // If the ref were interpolated into a shell string, this would create PWNED.
      const evil = `HEAD$(touch ${path.join(repo, 'PWNED')})`;
      // Must not throw to the caller (release-notes swallows git errors) and must not inject.
      assert.doesNotThrow(() => generateAgentReleaseNotes(repo, evil));
      assert.equal(fs.existsSync(sentinel), false, 'injected `touch` must NOT have run');

      const evil2 = '; touch ' + path.join(repo, 'PWNED');
      generateAgentReleaseNotes(repo, evil2);
      assert.equal(fs.existsSync(sentinel), false, 'injected `;touch` must NOT have run');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
