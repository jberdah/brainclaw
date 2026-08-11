/** pln#601 — one explicit, agent-facing freshness field. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coarseFreshness, withFreshness, applyGitHeadDrift } from '../../../src/core/code-map/freshness.js';
import type { FreshnessStatus } from '../../../src/core/code-map/types.js';

describe('pln#601 unified freshness badge', () => {
  it('maps every detailed index status to the four-value agent signal', () => {
    const expected: Array<[FreshnessStatus, string]> = [
      ['fresh', 'fresh'], ['stale_changed_files', 'stale'], ['stale_extractor', 'stale'],
      ['stale_grammar', 'stale'], ['stale_git_head', 'stale'], ['partial', 'partial'],
      ['missing_index', 'missing'],
    ];
    for (const [status, freshness] of expected) assert.equal(coarseFreshness(status), freshness);
  });

  it('always emits the same structured index and spot-check detail sections', () => {
    const badge = withFreshness({ status: 'stale_extractor', details: {} });
    assert.equal(badge.freshness, 'stale');
    assert.deepEqual(badge.details.index, {
      status: 'stale_extractor', stale_file_count: 0, partial_reason: null, git_head_changed: null,
    });
    assert.deepEqual(badge.details.spot_check, {
      status: 'not_run', checked_files: 0, stale_changed_files: [], deleted_files: [],
      unchecked_files: [], budget_exhausted: false, partial_reason: null,
    });
  });

  it('records HEAD drift in index details while keeping the synthetic field in lockstep', () => {
    const drifted = applyGitHeadDrift(withFreshness({ status: 'fresh', details: {} }), 'aaa111', 'bbb222');
    assert.equal(drifted.status, 'stale_git_head');
    assert.equal(drifted.freshness, 'stale');
    assert.deepEqual((drifted.details.index as Record<string, unknown>).git_head_changed, {
      index_head: 'aaa111', current_head: 'bbb222',
    });
  });
});