/**
 * pln#601 — the COARSE, surface-uniform freshness rollup (Fable-audit step 3).
 *
 * find/brief/status/work each expose their own precise 7-value status; `coarse`
 * collapses that to one consistent top-line (`fresh|stale|partial|missing`) so an
 * agent decides "trust or refresh" without memorizing which `stale_*` applies.
 * `coarseFreshness` is the single definition; `withCoarse` stamps a badge from its
 * (possibly just-adjusted) status. These assert the mapping + that the drift
 * transform recomputes coarse in lockstep with status.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coarseFreshness, withCoarse, applyGitHeadDrift } from '../../../src/core/code-map/freshness.js';
import type { FreshnessStatus } from '../../../src/core/code-map/types.js';

describe('pln#601 coarseFreshness — detailed → coarse rollup', () => {
  it('every stale_* variant collapses to "stale"', () => {
    const staleVariants: FreshnessStatus[] = [
      'stale_changed_files',
      'stale_extractor',
      'stale_grammar',
      'stale_git_head',
    ];
    for (const s of staleVariants) {
      assert.equal(coarseFreshness(s), 'stale', `${s} → stale`);
    }
  });

  it('fresh / partial pass through; missing_index → missing', () => {
    assert.equal(coarseFreshness('fresh'), 'fresh');
    assert.equal(coarseFreshness('partial'), 'partial');
    assert.equal(coarseFreshness('missing_index'), 'missing');
  });

  it('the mapping is total — every FreshnessStatus yields a coarse value', () => {
    const all: FreshnessStatus[] = [
      'fresh',
      'stale_changed_files',
      'stale_extractor',
      'stale_grammar',
      'stale_git_head',
      'partial',
      'missing_index',
    ];
    for (const s of all) {
      assert.ok(['fresh', 'stale', 'partial', 'missing'].includes(coarseFreshness(s)), `${s} maps to a coarse value`);
    }
  });

  it('withCoarse stamps the rollup onto a badge', () => {
    assert.deepEqual(withCoarse({ status: 'stale_extractor', details: {} }), {
      status: 'stale_extractor',
      coarse: 'stale',
      details: {},
    });
  });

  it('applyGitHeadDrift recomputes coarse when a fresh index drifts to stale_git_head', () => {
    const fresh = { status: 'fresh' as FreshnessStatus, coarse: 'fresh' as const, details: {} };
    const drifted = applyGitHeadDrift(fresh, 'aaa111', 'bbb222');
    assert.equal(drifted.status, 'stale_git_head');
    assert.equal(drifted.coarse, 'stale', 'coarse rolls up to stale in lockstep with the drifted status');
  });

  it('applyGitHeadDrift stamps coarse even on the no-drift pass-through', () => {
    const same = applyGitHeadDrift({ status: 'fresh', details: {} }, 'aaa111', 'aaa111');
    assert.equal(same.coarse, 'fresh', 'coarse present even when HEAD is unchanged');
  });
});
