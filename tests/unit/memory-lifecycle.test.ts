/**
 * pln#544 — memory-lifecycle: confirmation, decay, reinforcement.
 *
 * The four steps land together: schema fields + recordMemoryEvent +
 * getLifecycleStats + buildMemoryLifecycleMetrics. These tests exercise the
 * pure read paths (no I/O) plus a single end-to-end recordMemoryEvent
 * against a temp workspace to prove the schema persists / counters update.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryLifecycleMetrics,
  buildMemoryLifecycleMetricsForState,
  DECAY_HALF_LIFE_DAYS,
  getLifecycleStats,
  MAX_INLINE_CONFIRMATIONS,
  recordMemoryEvent,
  type MetricsInputItem,
} from '../../src/core/memory-lifecycle.js';
import { createDecision, createConstraint, createTrap } from '../../src/core/operations/memory-write.js';
import { loadState } from '../../src/core/state.js';
import { ENTITY_REGISTRY } from '../../src/core/entity-registry.js';
import { ConstraintSchema, DecisionSchema, TrapSchema } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

const NOW_MS = Date.parse('2026-06-12T00:00:00.000Z');
const daysAgoIso = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();

describe('schema accepts pln#544 lifecycle fields', () => {
  it('Decision/Constraint/Trap parse the new fields', () => {
    const common = {
      id: 'x', text: 't', created_at: daysAgoIso(1), author: 'a', tags: [],
      last_confirmed_at: daysAgoIso(0),
      last_infirmed_at: daysAgoIso(2),
      confirmation_count: 3, infirmation_count: 1,
      saved_me_count: 2, misled_me_count: 0,
      confirmations: [{ at: daysAgoIso(0), by: 'a', kind: 'saved_me' as const }],
    };
    assert.doesNotThrow(() => DecisionSchema.parse(common));
    assert.doesNotThrow(() => ConstraintSchema.parse({ ...common, status: 'active' }));
    assert.doesNotThrow(() => TrapSchema.parse({ ...common, status: 'active', severity: 'medium', visibility: 'shared' }));
  });

  it('entity-registry marks lifecycle fields updatable', () => {
    for (const entity of ['decision', 'constraint', 'trap'] as const) {
      const spec = ENTITY_REGISTRY[entity];
      assert.ok(spec.updatable.includes('last_confirmed_at'), `${entity} should mark last_confirmed_at updatable`);
      assert.ok(spec.updatable.includes('confirmations'), `${entity} should mark confirmations updatable`);
      assert.ok(spec.updatable.includes('saved_me_count'), `${entity} should mark saved_me_count updatable`);
    }
  });
});

describe('getLifecycleStats — decay + classification', () => {
  it('fresh confirmed-recent item gets positive ranking delta + classification fresh', () => {
    const stats = getLifecycleStats({
      entity: 'trap',
      created_at: daysAgoIso(120),
      last_confirmed_at: daysAgoIso(2),
      confirmation_count: 1,
      nowMs: NOW_MS,
    });
    assert.equal(stats.classification, 'fresh');
    assert.ok(stats.ranking_delta > 0, `fresh item should boost score, got ${stats.ranking_delta}`);
  });

  it('saved_me reinforcement stacks up to a cap of 3', () => {
    const base = {
      entity: 'decision' as const,
      created_at: daysAgoIso(10),
      last_confirmed_at: daysAgoIso(2),
      confirmation_count: 5,
      nowMs: NOW_MS,
    };
    const one = getLifecycleStats({ ...base, saved_me_count: 1 });
    const five = getLifecycleStats({ ...base, saved_me_count: 5 });
    assert.ok(five.ranking_delta > one.ranking_delta, 'more saved_me means more boost');
    assert.ok(five.ranking_delta - one.ranking_delta <= 3 + 0.001, 'reinforcement cap should be 3');
  });

  it('infirmed-after-confirm item gets large negative delta + classification infirmed', () => {
    const stats = getLifecycleStats({
      entity: 'decision',
      created_at: daysAgoIso(20),
      last_confirmed_at: daysAgoIso(10),
      last_infirmed_at: daysAgoIso(1),
      confirmation_count: 1,
      infirmation_count: 1,
      nowMs: NOW_MS,
    });
    assert.equal(stats.classification, 'infirmed');
    assert.ok(stats.ranking_delta <= -3, `infirmed should sink, got ${stats.ranking_delta}`);
  });

  it('never-confirmed item past half-life classifies as never_confirmed', () => {
    const stats = getLifecycleStats({
      entity: 'decision',
      created_at: daysAgoIso(DECAY_HALF_LIFE_DAYS.decision + 30),
      nowMs: NOW_MS,
    });
    assert.equal(stats.classification, 'never_confirmed');
    assert.ok(stats.ranking_delta < 0);
  });

  it('decay curve respects per-entity half-life', () => {
    const trap90 = getLifecycleStats({
      entity: 'trap', created_at: daysAgoIso(90), nowMs: NOW_MS,
    });
    const decision90 = getLifecycleStats({
      entity: 'decision', created_at: daysAgoIso(90), nowMs: NOW_MS,
    });
    // At 90d both have a decay_factor — trap halflife=90 → ~0.5, decision halflife=60 → ~0.35.
    assert.ok(trap90.decay_factor > decision90.decay_factor,
      `traps should decay slower than decisions, got trap=${trap90.decay_factor} decision=${decision90.decay_factor}`);
  });

  it('a confirm event after the last_infirmed flips the classification away from infirmed', () => {
    const stats = getLifecycleStats({
      entity: 'trap',
      created_at: daysAgoIso(40),
      last_infirmed_at: daysAgoIso(10),
      last_confirmed_at: daysAgoIso(2), // came AFTER the infirm
      confirmation_count: 1,
      infirmation_count: 1,
      nowMs: NOW_MS,
    });
    assert.notEqual(stats.classification, 'infirmed');
    assert.equal(stats.infirmed, false);
  });
});

describe('buildMemoryLifecycleMetrics — aggregate health', () => {
  const sample: MetricsInputItem[] = [
    // Confirmed, fresh
    {
      entity: 'trap', id: 'trp_a', created_at: daysAgoIso(30), status: 'active',
      last_confirmed_at: daysAgoIso(3), confirmation_count: 2, saved_me_count: 2,
    },
    // Never confirmed, old
    {
      entity: 'decision', id: 'dec_b', created_at: daysAgoIso(120),
    },
    // Infirmed
    {
      entity: 'constraint', id: 'cst_c', created_at: daysAgoIso(60), status: 'active',
      last_infirmed_at: daysAgoIso(5), infirmation_count: 1, misled_me_count: 1,
    },
  ];

  it('computes confirmed_ratio + average_age_days + oldest_unconfirmed', () => {
    const m = buildMemoryLifecycleMetrics(sample, NOW_MS);
    assert.equal(m.total_items, 3);
    assert.equal(m.confirmed_items, 1);
    assert.equal(m.confirmed_ratio, Number((1 / 3).toFixed(3)));
    assert.equal(m.oldest_unconfirmed_id, 'dec_b');
    assert.equal(m.oldest_unconfirmed_entity, 'decision');
    assert.equal(m.oldest_unconfirmed_age_days, 120);
    assert.equal(m.total_saved_me, 2);
    assert.equal(m.total_misled_me, 1);
    assert.equal(m.total_infirmed_active, 1);
    assert.equal(m.recall_precision_proxy, 1); // 2 - 1
  });

  it('empty input returns a zeroed metrics block', () => {
    const m = buildMemoryLifecycleMetrics([]);
    assert.equal(m.total_items, 0);
    assert.equal(m.confirmed_ratio, 0);
    assert.equal(m.oldest_unconfirmed_id, undefined);
  });

  it('skips resolved constraints / traps from the active aggregate', () => {
    const m = buildMemoryLifecycleMetrics([
      ...sample,
      { entity: 'trap', id: 'trp_resolved', created_at: daysAgoIso(200), status: 'resolved' },
    ], NOW_MS);
    // The resolved trap should be excluded — total stays 3, not 4.
    assert.equal(m.total_items, 3);
  });
});

describe('recordMemoryEvent — persistence + counter updates', () => {
  let workspace: TestWorkspace;
  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-memory-lifecycle-',
      projectId: 'prj_memlife_test',
      currentAgent: 'alice',
    });
  });
  afterEach(() => workspace.cleanup());

  it('confirms a decision, updates last_confirmed_at + count, appends to log', () => {
    const created = createDecision({ text: 'Use named exports', author: 'alice' }, workspace.dir);
    const r1 = recordMemoryEvent({
      entity: 'decision',
      id: created.id,
      kind: 'confirm',
      by: 'bob',
      evidence: 'src/x.ts:42',
      cwd: workspace.dir,
    });
    assert.equal(r1.confirmation_count, 1);
    assert.ok(r1.last_confirmed_at);
    assert.equal(r1.infirmation_count, 0);

    const state = loadState(workspace.dir);
    const item = state.recent_decisions.find((d) => d.id === created.id);
    assert.ok(item);
    assert.equal(item!.confirmation_count, 1);
    assert.equal(item!.last_confirmed_at, r1.last_confirmed_at);
    assert.equal(item!.confirmations?.length, 1);
    assert.equal(item!.confirmations?.[0]?.evidence, 'src/x.ts:42');
    assert.equal(item!.confirmations?.[0]?.by, 'bob');
  });

  it('saved_me bumps both confirmation_count and saved_me_count', () => {
    const created = createTrap({ text: 'pwsh hangs on Read-Host', author: 'alice', severity: 'medium' }, workspace.dir);
    const r = recordMemoryEvent({
      entity: 'trap', id: created.id, kind: 'saved_me', by: 'bob', cwd: workspace.dir,
    });
    assert.equal(r.confirmation_count, 1);
    assert.equal(r.saved_me_count, 1);
    assert.equal(r.infirmation_count, 0);
  });

  it('infirm flips classification when read back via getLifecycleStats', () => {
    const created = createConstraint({ text: 'X must always Y', author: 'alice' }, workspace.dir);
    recordMemoryEvent({ entity: 'constraint', id: created.id, kind: 'confirm', by: 'alice', cwd: workspace.dir });
    const after = recordMemoryEvent({ entity: 'constraint', id: created.id, kind: 'infirm', by: 'bob', cwd: workspace.dir });
    assert.equal(after.infirmation_count, 1);

    const state = loadState(workspace.dir);
    const item = state.active_constraints.find((c) => c.id === created.id)!;
    const stats = getLifecycleStats({
      entity: 'constraint',
      created_at: item.created_at,
      last_confirmed_at: item.last_confirmed_at,
      last_infirmed_at: item.last_infirmed_at,
      confirmation_count: item.confirmation_count,
      infirmation_count: item.infirmation_count,
    });
    assert.equal(stats.infirmed, true, 'infirm-after-confirm should be classified as infirmed');
  });

  it('bounded log keeps only the most recent MAX_INLINE_CONFIRMATIONS', () => {
    const created = createDecision({ text: 'Heavily-attested decision', author: 'alice' }, workspace.dir);
    for (let i = 0; i < MAX_INLINE_CONFIRMATIONS + 4; i++) {
      recordMemoryEvent({ entity: 'decision', id: created.id, kind: 'confirm', by: `attester${i}`, cwd: workspace.dir });
    }
    const state = loadState(workspace.dir);
    const item = state.recent_decisions.find((d) => d.id === created.id)!;
    assert.equal(item.confirmations?.length, MAX_INLINE_CONFIRMATIONS);
    // Counters keep the full history.
    assert.equal(item.confirmation_count, MAX_INLINE_CONFIRMATIONS + 4);
    // Most recent attester is in the log; the first ones got dropped.
    const attesters = (item.confirmations ?? []).map((e) => e.by);
    assert.ok(attesters.includes(`attester${MAX_INLINE_CONFIRMATIONS + 3}`));
    assert.ok(!attesters.includes('attester0'));
  });

  it('throws when targeting an unknown id', () => {
    assert.throws(
      () => recordMemoryEvent({ entity: 'trap', id: 'trp_does_not_exist', kind: 'confirm', by: 'bob', cwd: workspace.dir }),
      /not found/,
    );
  });

  it('buildMemoryLifecycleMetricsForState picks up the new counters from disk', () => {
    const t = createTrap({ text: 'X', author: 'alice', severity: 'medium' }, workspace.dir);
    recordMemoryEvent({ entity: 'trap', id: t.id, kind: 'saved_me', by: 'bob', cwd: workspace.dir });
    const state = loadState(workspace.dir);
    const m = buildMemoryLifecycleMetricsForState(state);
    assert.equal(m.total_items, 1);
    assert.equal(m.confirmed_items, 1);
    assert.equal(m.total_saved_me, 1);
    assert.equal(m.recall_precision_proxy, 1);
  });
});
