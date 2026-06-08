import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectUnverifiedMemory } from '../../src/core/staleness.js';
import { TrapSchema, DecisionSchema } from '../../src/core/schema.js';
import { ENTITY_REGISTRY } from '../../src/core/entity-registry.js';
import type { Trap } from '../../src/core/schema.js';

// pln#530 — anti-staleness: perishable memories carry verified_at / verify_cmd,
// and recall surfaces them aggressively when verification is stale/absent.

const NOW = Date.parse('2026-06-09T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function trap(overrides: Partial<Trap>): Trap {
  return {
    id: overrides.id ?? 'trp_x',
    text: overrides.text ?? 'codex service_tier = fast',
    created_at: daysAgo(120),
    author: 'claude-code',
    status: 'active',
    severity: 'medium',
    tags: [],
    visibility: 'shared',
    ...overrides,
  } as Trap;
}

describe('schema accepts verified_at / verify_cmd (pln#530)', () => {
  it('TrapSchema + DecisionSchema parse the new fields', () => {
    assert.doesNotThrow(() => TrapSchema.parse(trap({ verified_at: daysAgo(1), verify_cmd: 'codex --version' })));
    assert.doesNotThrow(() => DecisionSchema.parse({
      id: 'dec_x', text: 'x', created_at: daysAgo(1), author: 'a', tags: [],
      verified_at: daysAgo(1), verify_cmd: 'echo ok',
    }));
  });
  it('registry marks verified_at/verify_cmd updatable on trap + decision', () => {
    assert.ok(ENTITY_REGISTRY.trap.updatable.includes('verified_at'));
    assert.ok(ENTITY_REGISTRY.trap.updatable.includes('verify_cmd'));
    assert.ok(ENTITY_REGISTRY.decision.updatable.includes('verified_at'));
    assert.ok(ENTITY_REGISTRY.decision.updatable.includes('verify_cmd'));
  });
});

describe('detectUnverifiedMemory (pln#530)', () => {
  it('warns on a perishable fact verified long ago', () => {
    const w = detectUnverifiedMemory([trap({ id: 'trp_old', verified_at: daysAgo(60), verify_cmd: 'codex --version' })], NOW);
    assert.equal(w.length, 1);
    assert.match(w[0].reason, /last verified 60 days ago/);
    assert.match(w[0].suggested_action, /codex --version/);
  });

  it('does NOT warn on a freshly verified fact', () => {
    const w = detectUnverifiedMemory([trap({ id: 'trp_fresh', verified_at: daysAgo(3), verify_cmd: 'x' })], NOW);
    assert.equal(w.length, 0);
  });

  it('warns on a perishable fact never verified (verify_cmd, no verified_at)', () => {
    const w = detectUnverifiedMemory([trap({ id: 'trp_never', verify_cmd: 'check it' })], NOW);
    assert.equal(w.length, 1);
    assert.match(w[0].reason, /never empirically verified/);
  });

  it('ignores durable traps (no verify_cmd / verified_at)', () => {
    assert.equal(detectUnverifiedMemory([trap({ id: 'trp_durable' })], NOW).length, 0);
  });

  it('ignores inactive traps', () => {
    assert.equal(detectUnverifiedMemory([trap({ id: 'trp_resolved', status: 'resolved', verified_at: daysAgo(99) })], NOW).length, 0);
  });
});
