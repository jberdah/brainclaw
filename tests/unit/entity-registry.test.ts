import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_NAMES,
  ENTITY_REGISTRY,
  getEntitySpec,
  isValidTransition,
  transitionKey,
  type EntityName,
  type EntitySpec,
} from '../../src/core/entity-registry.js';

/**
 * Expected short-label prefix per entity. Mirrors src/core/ids.ts
 * PREFIXES plus the hardcoded generators in claims.ts, candidates.ts,
 * runtime.ts, identity.ts. The registry must agree with all of them.
 */
const EXPECTED_PREFIX: Record<EntityName, string> = {
  plan: 'pln',
  step: 'stp',
  claim: 'clm',
  session: 'sess',
  handoff: 'hnd',
  decision: 'dec',
  constraint: 'cst',
  trap: 'trp',
  candidate: 'cnd',
  runtime_note: 'rtn',
  sequence: 'seq',
  inbox_message: 'msg',
  instruction: 'ins',
  assignment: 'asgn',
  agent_run: 'run',
  action: 'act',
};

describe('core/entity-registry — grammar consistency', () => {
  it('every declared entity name appears in ENTITY_NAMES exactly once', () => {
    const seen = new Set<string>();
    for (const name of ENTITY_NAMES) {
      assert.equal(seen.has(name), false, `duplicate entity: ${name}`);
      seen.add(name);
    }
    assert.equal(ENTITY_NAMES.length, Object.keys(ENTITY_REGISTRY).length);
  });

  it('every entity key matches its own spec.name (no crossed wires)', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      assert.equal(spec.name, name, `key/spec mismatch on ${name}`);
    }
  });

  it('every shortLabelPrefix matches the authoritative id generator', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      const expected = EXPECTED_PREFIX[name];
      assert.equal(
        spec.shortLabelPrefix,
        expected,
        `${name}: registry says '${spec.shortLabelPrefix}', id generator uses '${expected}'`,
      );
    }
  });

  it('every prefix is unique across entities', () => {
    const seen = new Map<string, EntityName>();
    for (const name of ENTITY_NAMES) {
      const prefix = ENTITY_REGISTRY[name].shortLabelPrefix;
      const prior = seen.get(prefix);
      assert.equal(
        prior,
        undefined,
        `prefix collision: ${name} and ${prior ?? '?'} both use '${prefix}'`,
      );
      seen.set(prefix, name);
    }
  });

  it('stateless entities have empty transitions AND empty terminal AND no statusField', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (spec.statusField !== undefined) continue;
      assert.deepEqual(spec.transitions, {}, `${name}: statusField is undefined but has transitions`);
      assert.deepEqual(spec.terminal, [], `${name}: statusField is undefined but has terminal states`);
      assert.deepEqual(spec.sideEffects, {}, `${name}: statusField is undefined but declares side effects`);
    }
  });

  it('every `to` target in transitions is either another `from` key or a terminal state', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const fromKeys = new Set(Object.keys(spec.transitions));
      const terminalSet = new Set(spec.terminal);
      for (const [from, targets] of Object.entries(spec.transitions)) {
        for (const to of targets) {
          const known = fromKeys.has(to) || terminalSet.has(to);
          assert.ok(known, `${name}: transition ${from}->${to} points at unknown state '${to}'`);
        }
      }
    }
  });

  it('no from-state is also a terminal state (terminal = dead-end by definition)', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const terminalSet = new Set(spec.terminal);
      for (const from of Object.keys(spec.transitions)) {
        assert.equal(
          terminalSet.has(from),
          false,
          `${name}: '${from}' is both a transition source and a terminal state`,
        );
      }
    }
  });

  it('every terminal state is reachable from at least one transition', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const reached = new Set<string>();
      for (const targets of Object.values(spec.transitions)) {
        for (const to of targets) reached.add(to);
      }
      for (const t of spec.terminal) {
        assert.ok(
          reached.has(t),
          `${name}: terminal state '${t}' is unreachable from any transition`,
        );
      }
    }
  });

  it('every sideEffects key corresponds to a valid (from, to) transition', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      for (const key of Object.keys(spec.sideEffects)) {
        const [from, to] = key.split('->');
        assert.ok(from && to, `${name}: malformed sideEffects key '${key}'`);
        assert.ok(
          isValidTransition(name, from, to),
          `${name}: sideEffects key '${key}' is not a valid transition`,
        );
      }
    }
  });

  it('isValidTransition rejects transitions from terminal states', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      for (const t of spec.terminal) {
        // Try a fake `to` — must reject because source is terminal.
        assert.equal(isValidTransition(name, t, '__anywhere__'), false);
      }
    }
  });

  it('isValidTransition rejects unknown from/to and stateless entities', () => {
    assert.equal(isValidTransition('runtime_note', 'a', 'b'), false, 'stateless entity accepts a transition');
    assert.equal(isValidTransition('plan', 'unknown', 'done'), false, 'unknown source accepted');
    assert.equal(isValidTransition('plan', 'todo', 'unknown'), false, 'unknown target accepted');
  });

  it('transitionKey formats as from->to', () => {
    assert.equal(transitionKey('a', 'b'), 'a->b');
  });

  it('getEntitySpec throws on unknown entity name', () => {
    assert.throws(() => getEntitySpec('not_an_entity' as EntityName), /Unknown entity/);
  });

  it('every entity spec carries a Zod schema reference', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      assert.ok(spec.schema, `${name}: schema is missing`);
      assert.equal(typeof (spec.schema as { parse: unknown }).parse, 'function', `${name}: schema has no .parse method`);
    }
  });
});

describe('core/entity-registry — known-good transitions', () => {
  const cases: Array<{ entity: EntityName; from: string; to: string; valid: boolean }> = [
    { entity: 'plan', from: 'todo', to: 'in_progress', valid: true },
    { entity: 'plan', from: 'todo', to: 'done', valid: true },
    { entity: 'plan', from: 'done', to: 'in_progress', valid: false }, // terminal
    { entity: 'step', from: 'in_progress', to: 'testing', valid: true },
    { entity: 'step', from: 'testing', to: 'done', valid: true },
    { entity: 'claim', from: 'active', to: 'released', valid: true },
    { entity: 'claim', from: 'released', to: 'active', valid: false }, // terminal
    { entity: 'handoff', from: 'open', to: 'accepted', valid: true },
    { entity: 'handoff', from: 'accepted', to: 'open', valid: false },
    { entity: 'candidate', from: 'pending', to: 'accepted', valid: true },
    { entity: 'candidate', from: 'accepted', to: 'rejected', valid: false }, // terminal
    { entity: 'sequence', from: 'draft', to: 'active', valid: true },
    { entity: 'sequence', from: 'archived', to: 'active', valid: false },
    { entity: 'assignment', from: 'created', to: 'offered', valid: true },
    { entity: 'assignment', from: 'started', to: 'completed', valid: true },
    { entity: 'agent_run', from: 'running', to: 'completed', valid: true },
  ];
  for (const { entity, from, to, valid } of cases) {
    it(`${entity}: ${from} -> ${to} = ${valid ? 'ok' : 'rejected'}`, () => {
      assert.equal(isValidTransition(entity, from, to), valid);
    });
  }
});
