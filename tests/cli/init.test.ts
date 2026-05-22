/**
 * Tests for `brainclaw init --cwd <path>` CLI parity (pln#515 step 1).
 *
 * The runInit function already threads `options.cwd` through every internal
 * scaffold writer; this test guards that behaviour at the entry point so the
 * future addition of any new helper that forgets to honor `cwd` is caught.
 *
 * We invoke runInit directly (no subprocess) but keep the test process's
 * cwd pointed at an *unrelated* temp directory to prove that `--cwd` wins.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInit } from '../../src/commands/init.js';

interface Fixture {
  targetDir: string;
  unrelatedCwd: string;
  fakeHome: string;
  previousCwd: string;
  envBackup: Record<string, string | undefined>;
}

function makeFixture(): Fixture {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-cwd-target-'));
  const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-cwd-process-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-cwd-home-'));
  const previousCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    BRAINCLAW_STORE_BOUNDARY: process.env.BRAINCLAW_STORE_BOUNDARY,
    BRAINCLAW_TEST_MODE: process.env.BRAINCLAW_TEST_MODE,
    BRAINCLAW_SKIP_REPO_ANALYSIS: process.env.BRAINCLAW_SKIP_REPO_ANALYSIS,
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP,
  };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  process.env.BRAINCLAW_STORE_BOUNDARY = targetDir;
  process.env.BRAINCLAW_TEST_MODE = '1';
  process.env.BRAINCLAW_SKIP_REPO_ANALYSIS = '1';
  process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP = '1';
  process.chdir(unrelatedCwd);
  return { targetDir, unrelatedCwd, fakeHome, previousCwd, envBackup };
}

function cleanup(fx: Fixture): void {
  process.chdir(fx.previousCwd);
  for (const [key, value] of Object.entries(fx.envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fx.targetDir, { recursive: true, force: true });
  fs.rmSync(fx.unrelatedCwd, { recursive: true, force: true });
  fs.rmSync(fx.fakeHome, { recursive: true, force: true });
}

describe('runInit --cwd parity (pln#515 step 1)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    cleanup(fx);
  });

  it('writes .brainclaw/ into options.cwd even when process.cwd() is elsewhere', async () => {
    await runInit({ yes: true, cwd: fx.targetDir });
    assert.ok(
      fs.existsSync(path.join(fx.targetDir, '.brainclaw', 'config.yaml')),
      'target .brainclaw/config.yaml should exist',
    );
    assert.ok(
      !fs.existsSync(path.join(fx.unrelatedCwd, '.brainclaw')),
      'no .brainclaw should be created in the process cwd',
    );
  });

  it('falls back to process.cwd() when --cwd is omitted (regression guard)', async () => {
    // Switch process.cwd to a fresh target so we can verify default behavior.
    const defaultTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-cwd-default-'));
    const stashedBoundary = process.env.BRAINCLAW_STORE_BOUNDARY;
    process.env.BRAINCLAW_STORE_BOUNDARY = defaultTarget;
    process.chdir(defaultTarget);
    try {
      await runInit({ yes: true });
      assert.ok(
        fs.existsSync(path.join(defaultTarget, '.brainclaw', 'config.yaml')),
        'default cwd init should still create .brainclaw at process.cwd()',
      );
    } finally {
      process.chdir(fx.unrelatedCwd);
      process.env.BRAINCLAW_STORE_BOUNDARY = stashedBoundary;
      fs.rmSync(defaultTarget, { recursive: true, force: true });
    }
  });
});
