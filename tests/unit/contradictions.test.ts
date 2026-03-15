import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictions, detectNewItemContradictions } from '../../src/core/contradictions.js';
import type { State } from '../../src/core/schema.js';

function createState(): State {
  return {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
  };
}

describe('core/contradictions', () => {
  it('detects contradictory active constraints on the same scope', () => {
    const state = createState();
    state.active_constraints.push(
      {
        id: 'cst_a',
        text: 'Auth middleware must allow refresh tokens',
        created_at: '2026-03-15T10:00:00Z',
        author: 'alice',
        status: 'active',
        tags: ['auth'],
        related_paths: ['src/auth'],
      },
      {
        id: 'cst_b',
        text: 'Auth middleware must not allow refresh tokens',
        created_at: '2026-03-15T10:05:00Z',
        author: 'bob',
        status: 'active',
        tags: ['auth'],
        related_paths: ['src/auth'],
      },
    );

    const reports = detectContradictions(state);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].section, 'constraints');
    assert.equal(reports[0].item_id, 'cst_a');
    assert.equal(reports[0].conflicts_with, 'cst_b');
    assert.equal(reports[0].kind, 'negation_pair');
    assert.equal(reports[0].severity, 'high');
    assert.ok(reports[0].score >= 10);
  });

  it('ignores contradictory wording when tags and paths do not overlap', () => {
    const state = createState();
    state.recent_decisions.push(
      {
        id: 'dec_a',
        text: 'Payments should use provider A',
        created_at: '2026-03-15T10:00:00Z',
        author: 'alice',
        tags: ['payments'],
        related_paths: ['src/payments'],
      },
      {
        id: 'dec_b',
        text: 'Search should not use provider A',
        created_at: '2026-03-15T10:05:00Z',
        author: 'bob',
        tags: ['search'],
        related_paths: ['src/search'],
      },
    );

    const reports = detectContradictions(state);
    assert.equal(reports.length, 0);
  });

  it('detects contradictions for a new item against existing state', () => {
    const state = createState();
    state.recent_decisions.push({
      id: 'dec_auth',
      text: 'Gateway should always enable OAuth fallback',
      created_at: '2026-03-15T10:00:00Z',
      author: 'alice',
      tags: ['auth'],
      related_paths: ['src/auth/gateway.ts'],
    });

    const reports = detectNewItemContradictions(
      'Gateway should never enable OAuth fallback',
      ['auth'],
      ['src/auth'],
      state,
    );

    assert.equal(reports.length, 1);
    assert.equal(reports[0].conflicts_with, 'dec_auth');
    assert.equal(reports[0].section, 'decisions');
    assert.ok(['medium', 'high'].includes(reports[0].severity));
  });

  it('keeps lexical overlap bounded to avoid broad false positives', () => {
    const state = createState();
    state.active_constraints.push({
      id: 'cst_cache',
      text: 'Cache layer must allow warmup jobs',
      created_at: '2026-03-15T10:00:00Z',
      author: 'alice',
      status: 'active',
      tags: ['cache'],
      related_paths: ['src/cache'],
    });

    const reports = detectNewItemContradictions(
      'Cache metrics should not alert on warmup noise',
      ['cache'],
      ['src/cache/metrics.ts'],
      state,
      'prj_ctx',
    );

    assert.equal(reports.length, 0);
  });
});
