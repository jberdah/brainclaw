/**
 * trp_6a49f976 F1 (codex review of PR #163) — `brainclaw refresh` must reach
 * EVERY registered live companion.
 *
 * The pre-fix implementation deduplicated refresh targets by STABLE EXPORT
 * FORMAT. mistral-vibe shares `agents-md` with codex/hermes/opencode, so it
 * was dropped before the write loop — and its REGISTERED live companion,
 * .vibe/live.md, was never rewritten, while the stale-surface advisory named
 * `brainclaw refresh` as the recovery for exactly that file. This suite is the
 * load-bearing regression: coverage is asserted against the registry itself,
 * never against a hand-kept list (review finding F1 of pln#638).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refreshLiveCompanions } from '../../src/commands/export.js';
import { LIVE_COMPANION_EXPORT_REGISTRY } from '../../src/core/agent-files.js';
import { parseSurfaceProvenance } from '../../src/core/surface-freshness.js';
import { getInstalledBrainclawVersion } from '../../src/core/brainclaw-version.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('brainclaw refresh — registered live-companion coverage (trp_6a49f976 F1)', { concurrency: false }, () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace({ prefix: 'bclaw-live-refresh-' });
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('writes EVERY live companion named by LIVE_COMPANION_EXPORT_REGISTRY', () => {
    const result = refreshLiveCompanions(ws.dir);
    assert.deepEqual(result.errors, [], 'refresh must not swallow a per-agent failure silently');

    const missing = LIVE_COMPANION_EXPORT_REGISTRY
      .map((t) => t.relativePath)
      .filter((rel) => !fs.existsSync(path.join(ws.dir, rel)));
    assert.deepEqual(
      missing, [],
      'registered live companions the refresh loop never reached — a stale one of these '
      + 'would be told to run `brainclaw refresh` and stay stale forever',
    );
  });

  it('stamps each companion with the running version — the stamp the freshness reconcile reads', () => {
    refreshLiveCompanions(ws.dir);
    const version = getInstalledBrainclawVersion();
    for (const target of LIVE_COMPANION_EXPORT_REGISTRY) {
      const content = fs.readFileSync(path.join(ws.dir, target.relativePath), 'utf-8');
      assert.equal(
        parseSurfaceProvenance(content).version, version,
        `${target.relativePath} must carry a parseable current-version stamp, or the reconcile `
        + 'reports it stale (or unknown) right after the refresh that was supposed to fix it',
      );
    }
  });
});
