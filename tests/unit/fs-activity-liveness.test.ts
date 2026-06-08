import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { latestWorktreeFileMtimeMs, latestActivityMs, getRuntimeLogPath, ensureRuntimeDirs } from '../../src/core/runtime-signals.js';
import { recognizeStderrSignature } from '../../src/core/dispatch-status.js';

// pln#527 — fs-activity is the liveness signal when the heartbeat is frozen
// (codex streaming to stderr, claude -p buffering stdout while editing files).

const setMtime = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms));

describe('latestWorktreeFileMtimeMs (pln#527)', () => {
  it('returns the newest regular-file mtime, skipping junctions and dep/VCS dirs', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fsact-wt-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fsact-ext-'));
    try {
      fs.writeFileSync(path.join(wt, 'old.ts'), 'a');
      fs.writeFileSync(path.join(wt, 'new.ts'), 'b');
      setMtime(path.join(wt, 'old.ts'), 1_000_000);
      setMtime(path.join(wt, 'new.ts'), 5_000_000);

      // node_modules with a VERY new file — must be skipped.
      fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
      const nm = path.join(wt, 'node_modules', 'pkg', 'index.js');
      fs.writeFileSync(nm, 'x');
      setMtime(nm, 9_000_000);

      // external file + symlink into the worktree — must NOT be followed.
      const extFile = path.join(ext, 'huge.bin');
      fs.writeFileSync(extFile, 'y');
      setMtime(extFile, 9_500_000);
      try {
        fs.symlinkSync(ext, path.join(wt, 'linked'), 'junction');
      } catch { /* symlink may be unavailable; test still valid without it */ }

      const latest = latestWorktreeFileMtimeMs(wt);
      assert.equal(latest, 5_000_000, 'newest tracked file wins; node_modules + symlink skipped');
    } finally {
      try { fs.unlinkSync(path.join(wt, 'linked')); } catch { /* */ }
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  it('returns undefined for a missing path', () => {
    assert.equal(latestWorktreeFileMtimeMs(path.join(os.tmpdir(), 'bclaw-nope-' + Date.now())), undefined);
  });
});

describe('latestActivityMs (pln#527)', () => {
  it('takes the max of log mtime and worktree mtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fsact-root-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fsact-wt2-'));
    try {
      ensureRuntimeDirs(root);
      const log = getRuntimeLogPath(root, 'asgn_x', 'stderr');
      fs.writeFileSync(log, 'streaming...');
      setMtime(log, 7_000_000);
      fs.writeFileSync(path.join(wt, 'f.ts'), 'z');
      setMtime(path.join(wt, 'f.ts'), 3_000_000);

      assert.equal(latestActivityMs(root, 'asgn_x', wt), 7_000_000, 'log mtime wins');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('returns undefined when nothing is observable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fsact-empty-'));
    try {
      assert.equal(latestActivityMs(root, 'asgn_none'), undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('recognizeStderrSignature (pln#527 #5)', () => {
  it('flags codex service_tier=flex mismatch', () => {
    const sig = recognizeStderrSignature(['Error: 400 Unsupported service_tier: flex']);
    assert.ok(sig);
    assert.match(sig!.summary, /service_tier/);
    assert.match(sig!.recommended_next_action, /config\.toml/);
  });

  it('flags unknown config variant', () => {
    const sig = recognizeStderrSignature(['unknown variant `default`, expected one of ...']);
    assert.ok(sig);
    assert.match(sig!.summary, /unknown config variant/i);
  });

  it('flags a model 400', () => {
    const sig = recognizeStderrSignature(['openai: 400 model gpt-5.5 requires a newer version']);
    assert.ok(sig);
    assert.match(sig!.summary, /400/);
  });

  it('returns undefined for benign output', () => {
    assert.equal(recognizeStderrSignature(['Reading prompt from stdin...', 'done']), undefined);
    assert.equal(recognizeStderrSignature(undefined), undefined);
    assert.equal(recognizeStderrSignature([]), undefined);
  });
});
