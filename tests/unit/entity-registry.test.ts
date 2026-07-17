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
  cross_project_link: 'xpl',
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

  // pln#625 Phase 2 — a system-managed entity's unwired-write error names the
  // authorized path from writePolicyNote; without one the error is vague.
  it('every writePolicy:system entity names its authorized path (writePolicyNote)', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (spec.writePolicy !== 'system') continue;
      assert.ok(
        typeof spec.writePolicyNote === 'string' && spec.writePolicyNote.length > 0,
        `${name}: writePolicy 'system' must set writePolicyNote (the authorized write path named in the error)`,
      );
    }
  });
});

/**
 * pln#625 Phase 0 — the internal-consistency checks above validate that a
 * spec's transition graph is self-referential, but they never compare the
 * declared statuses to the PERSISTED status enum. That gap let `action` ship
 * an FSM of open/in_progress/completed/dismissed while the on-disk schema only
 * accepts pending/resolved/rejected/cancelled/expired — a transition tool built
 * on it would InvalidTransitionError or write a schema-invalid record. This
 * block pins every stateful EntitySpec's statuses to its Zod status enum so the
 * two can never drift again. Aucune transition canonique n'est fiable tant que
 * ce bloc n'est pas vert.
 */
describe('core/entity-registry — FSM ↔ Zod status enum (pln#625 Phase 0)', () => {
  /** Unwrap ZodDefault / ZodOptional / ZodNullable / ZodEffects to the enum values. */
  function enumValues(zodType: unknown): string[] | null {
    let t = zodType as { options?: unknown; _def?: Record<string, unknown> } | undefined;
    for (let i = 0; i < 12 && t; i++) {
      if (Array.isArray(t.options)) return t.options as string[];
      const def = t._def;
      if (!def) break;
      if (Array.isArray(def.values)) return def.values as string[]; // ZodEnum
      if (def.innerType) { t = def.innerType as typeof t; continue; } // Default/Optional/Nullable
      if (def.schema) { t = def.schema as typeof t; continue; }       // ZodEffects
      if (typeof def.type === 'object' && def.type) { t = def.type as typeof t; continue; }
      break;
    }
    return null;
  }

  /** Unwrap ZodEffects (preprocess/refine) / ZodDefault / ZodOptional to the inner ZodObject shape. */
  function objectShape(zodType: unknown): Record<string, unknown> | null {
    let t = zodType as { shape?: unknown; _def?: Record<string, unknown> } | undefined;
    for (let i = 0; i < 12 && t; i++) {
      if (t.shape && typeof t.shape === 'object') return t.shape as Record<string, unknown>;
      const def = t._def;
      if (!def) break;
      if (def.out) { t = def.out as typeof t; continue; }             // Zod 4 ZodPipe (z.preprocess) → output schema
      if (def.schema) { t = def.schema as typeof t; continue; }       // ZodEffects (preprocess/refine)
      if (def.innerType) { t = def.innerType as typeof t; continue; } // Default/Optional/Nullable
      break;
    }
    return null;
  }

  function statusEnumFor(spec: EntitySpec): string[] | null {
    const shape = objectShape(spec.schema);
    if (!shape || !spec.statusField) return null;
    return enumValues(shape[spec.statusField]);
  }

  it('every stateful entity resolves its status field to a concrete Zod enum', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const values = statusEnumFor(spec);
      assert.ok(
        values && values.length > 0,
        `${name}: could not resolve a Zod enum for status field '${spec.statusField}' — the pin below cannot run`,
      );
    }
  });

  it('every status named in transitions + terminal is a member of the persisted Zod enum', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const values = statusEnumFor(spec);
      if (!values) continue; // covered by the guard test above
      const enumSet = new Set(values);
      const declared = new Set<string>(spec.terminal);
      for (const [from, targets] of Object.entries(spec.transitions)) {
        declared.add(from);
        for (const to of targets) declared.add(to);
      }
      for (const status of declared) {
        assert.ok(
          enumSet.has(status),
          `${name}: FSM references status '${status}' which is NOT in ${spec.statusField} enum [${values.join(', ')}]`,
        );
      }
    }
  });

  it('every terminal status is a member of the persisted Zod enum (no phantom dead-ends)', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const values = statusEnumFor(spec);
      if (!values) continue;
      const enumSet = new Set(values);
      for (const t of spec.terminal) {
        assert.ok(enumSet.has(t), `${name}: terminal status '${t}' is not a valid ${spec.statusField} value`);
      }
    }
  });

  // Set-EQUALITY, not just subset (review follow-up): the check above proves the
  // FSM invents no status outside the enum; this proves the enum has no value
  // the FSM can never reach or leave. An orphan enum value is a silent dead-end
  // — isValidTransition treats an undeclared `from` as implicitly terminal — so
  // it would ship undetected. Green today for all 13 stateful entities.
  it('every persisted enum value is reachable in the FSM — no orphan statuses (pln#625 Phase 0)', () => {
    for (const name of ENTITY_NAMES) {
      const spec = ENTITY_REGISTRY[name];
      if (!spec.statusField) continue;
      const values = statusEnumFor(spec);
      if (!values) continue; // covered by the guard test above
      const declared = new Set<string>(spec.terminal);
      for (const [from, targets] of Object.entries(spec.transitions)) {
        declared.add(from);
        for (const to of targets) declared.add(to);
      }
      for (const value of values) {
        assert.ok(
          declared.has(value),
          `${name}: status enum value '${value}' is an ORPHAN — not a transition source, target, or terminal in the FSM. Add it to the matrix or remove it from ${spec.statusField}'s enum.`,
        );
      }
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
    { entity: 'assignment', from: 'started', to: 'cancelled', valid: true },
    { entity: 'assignment', from: 'cancelled', to: 'started', valid: false },
    { entity: 'agent_run', from: 'running', to: 'completed', valid: true },
    { entity: 'action', from: 'pending', to: 'resolved', valid: true },
    { entity: 'action', from: 'pending', to: 'expired', valid: true },
    { entity: 'action', from: 'resolved', to: 'pending', valid: false }, // terminal
    { entity: 'action', from: 'pending', to: 'completed', valid: false }, // 'completed' is not an action status
  ];
  for (const { entity, from, to, valid } of cases) {
    it(`${entity}: ${from} -> ${to} = ${valid ? 'ok' : 'rejected'}`, () => {
      assert.equal(isValidTransition(entity, from, to), valid);
    });
  }
});
