/**
 * pln#634 — next_actions coverage + contract.
 *
 * The contract test is the point of this file. trp_dfb58908: a `next_actions`
 * entry shipped with the WRONG argument shape and a fresh agent that obediently
 * followed it failed on its very first write. A suggestion that does not
 * validate against the target tool's own inputSchema is worse than no
 * suggestion, so every builder's output is validated here against the real
 * catalog schema with a STRICT validator (trp_720f88c6: Claude Code's permissive
 * validation lets non-conformant shapes ship; Copilot/Cursor reject them).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ALL_TOOLS } from '../../src/commands/mcp.js';
import type { NextAction } from '../../src/core/facade-schema.js';
import {
  coordinateNextActions,
  createEntityNextActions,
  dispatchNextActions,
  releaseClaimNextActions,
  transitionNextActions,
  verifyDispatchAction,
} from '../../src/core/next-actions.js';

// ajv 8 is CJS; `createRequire` sidesteps the nodenext default-interop gap
// without typing gymnastics. It is the same strict validator class the
// stricter agent hosts use (trp_720f88c6).
type AjvValidator = (data: unknown) => boolean;
interface AjvInstance { compile: (schema: unknown) => AjvValidator & { errors?: unknown } }
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;
const requireCjs = createRequire(import.meta.url);
const AjvExport = requireCjs('ajv') as AjvCtor & { default?: AjvCtor };
const Ajv: AjvCtor = AjvExport.default ?? AjvExport;

interface ToolDescriptor {
  name: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS = ALL_TOOLS as readonly ToolDescriptor[];

function schemaFor(tool: string): Record<string, unknown> {
  const found = TOOLS.find((t) => t.name === tool);
  assert.ok(found, `next_actions names a tool that is not in the catalog: ${tool}`);
  return found.inputSchema;
}

/**
 * Validate an emitted action against its target tool's published inputSchema.
 * `required` is intentionally enforced: an action missing a required argument is
 * exactly the trp_dfb58908 failure. Placeholder VALUES (`<scope you are about
 * to edit>`) are fine — they are well-typed strings the caller substitutes.
 */
function assertActionIsCallable(action: NextAction): void {
  const schema = schemaFor(action.tool);
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(action.args ?? {});
  assert.ok(
    ok,
    `next_action for ${action.tool} does not satisfy its own inputSchema: `
    + `${JSON.stringify(validate.errors)} — args were ${JSON.stringify(action.args)}`,
  );
}

/** Every builder invoked over the outcomes that actually produce actions. */
function allEmittedActions(): NextAction[] {
  return [
    verifyDispatchAction('asgn_deadbeef'),
    ...releaseClaimNextActions({ claimId: 'clm_1', planId: 'pln_1', planTransitioned: true }),
    ...releaseClaimNextActions({
      claimId: 'clm_1', planId: 'pln_1', planTransitioned: false,
      planWarning: 'other claims still active', requestedPlanStatus: 'done',
    }),
    ...transitionNextActions({ entity: 'plan', id: 'pln_1', to: 'in_progress' }),
    ...transitionNextActions({ entity: 'plan', id: 'pln_1', to: 'blocked' }),
    ...coordinateNextActions({
      intent: 'review', assignmentIds: ['asgn_1'], loopId: 'lop_1',
      executionStatus: 'delivered_and_started',
    }),
    ...coordinateNextActions({
      intent: 'assign', assignmentIds: ['asgn_1'], executionStatus: 'command_ready_manual',
    }),
    ...coordinateNextActions({
      intent: 'assign', assignmentIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
      executionStatus: 'delivered_and_started',
    }),
    ...dispatchNextActions({ spawnedTargets: ['asgn_1'], blockedCount: 2, dryRun: false }),
    ...dispatchNextActions({ spawnedTargets: [], blockedCount: 0, dryRun: true }),
    ...createEntityNextActions({ entity: 'plan', id: 'pln_1' }),
    ...createEntityNextActions({ entity: 'sequence', id: 'seq_1' }),
  ];
}

describe('next_actions — contract against the real tool catalog', () => {
  it('every emitted action names a tool that exists in the catalog', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const action of allEmittedActions()) {
      assert.ok(names.has(action.tool), `unknown tool in next_actions: ${action.tool}`);
    }
  });

  it('every emitted action satisfies its target tool inputSchema (strict validator)', () => {
    const actions = allEmittedActions();
    assert.ok(actions.length >= 10, 'the builder matrix must actually produce actions');
    for (const action of actions) assertActionIsCallable(action);
  });

  it('every emitted action carries a `when` explaining the condition', () => {
    for (const action of allEmittedActions()) {
      assert.ok(action.when && action.when.length > 10, `next_action for ${action.tool} needs a real \`when\``);
    }
  });

  it('liveness verification always routes to dispatch_status, never a pid check', () => {
    const action = verifyDispatchAction('asgn_x');
    assert.equal(action.tool, 'bclaw_dispatch_status');
    assert.match(action.when!, /do NOT judge/i);
    // The whole point of the fix: no suggestion may send a caller to the pid.
    for (const emitted of allEmittedActions()) {
      const blob = JSON.stringify(emitted);
      assert.doesNotMatch(blob, /pid_alive|"pid"/, `next_action must not steer to a pid check: ${blob}`);
    }
  });
});

describe('next_actions — outcome-derived, never a static per-tool table', () => {
  it('a plain release with no plan link emits nothing', () => {
    assert.deepEqual(releaseClaimNextActions({ claimId: 'clm_1', planTransitioned: false }), []);
  });

  it('a released claim whose plan moved points at review; a refused cascade points at the blockers', () => {
    const done = releaseClaimNextActions({ claimId: 'c', planId: 'pln_9', planTransitioned: true });
    assert.equal(done.length, 1);
    assert.equal(done[0].tool, 'bclaw_coordinate');
    assert.equal((done[0].args as Record<string, unknown>).intent, 'review');

    const refused = releaseClaimNextActions({
      claimId: 'c', planId: 'pln_9', planTransitioned: false, planWarning: 'others active',
    });
    assert.deepEqual(refused.map((a) => a.tool), ['bclaw_find', 'bclaw_transition']);
    // The find must be scoped to the actual plan, not a generic listing.
    assert.deepEqual((refused[0].args as { filter: unknown }).filter, { plan_id: 'pln_9', status: 'active' });
  });

  it('terminal transitions emit nothing (no invented busywork)', () => {
    assert.deepEqual(transitionNextActions({ entity: 'plan', id: 'p', to: 'done' }), []);
    assert.deepEqual(transitionNextActions({ entity: 'candidate', id: 'c', to: 'accepted' }), []);
    assert.deepEqual(transitionNextActions({ entity: 'trap', id: 't', to: 'stale' }), []);
  });

  it('coordinate emits verification only when something actually spawned', () => {
    const spawned = coordinateNextActions({
      intent: 'assign', assignmentIds: ['asgn_7'], executionStatus: 'delivered_and_started',
    });
    assert.equal(spawned.length, 1);
    assert.equal((spawned[0].args as Record<string, unknown>).target_id, 'asgn_7');

    const inboxOnly = coordinateNextActions({
      intent: 'consult', assignmentIds: [], executionStatus: 'inbox_only',
    });
    assert.deepEqual(inboxOnly, [], 'consult is inbox-only — nothing to verify, nothing to suggest');
  });

  it('coordinate never suggests an MCP call for a manual launch command it cannot make', () => {
    const manual = coordinateNextActions({
      intent: 'assign', assignmentIds: ['asgn_7'], executionStatus: 'command_ready_manual',
    });
    // Exactly one action, and it is the AFTER-you-ran-it verification — never a
    // fake "run this command" MCP action.
    assert.equal(manual.length, 1);
    assert.equal(manual[0].tool, 'bclaw_dispatch_status');
    assert.match(manual[0].when!, /once you have run/i);
  });

  it('a wide fan-out is capped and says what it dropped instead of truncating silently', () => {
    const wide = coordinateNextActions({
      intent: 'assign', assignmentIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
      executionStatus: 'delivered_and_started',
    });
    assert.equal(wide.length, 4, '3 concrete targets + 1 explicit remainder note');
    assert.match(wide[3].when!, /2 further target/);
  });

  it('a dry-run dispatch points at the real run; a blocked cycle points at analysis', () => {
    const dry = dispatchNextActions({ spawnedTargets: ['x'], blockedCount: 3, dryRun: true });
    assert.equal(dry.length, 1, 'a dry run has one honest follow-up: actually dispatch');
    assert.equal((dry[0].args as Record<string, unknown>).intent, 'execute');

    const live = dispatchNextActions({ spawnedTargets: [], blockedCount: 3, dryRun: false });
    assert.deepEqual(live.map((a) => (a.args as Record<string, unknown>).intent), ['analysis']);
  });

  it('create emits steps for a plan and nothing for entities that are complete on creation', () => {
    assert.equal(createEntityNextActions({ entity: 'plan', id: 'pln_2' })[0].tool, 'bclaw_add_step');
    assert.deepEqual(createEntityNextActions({ entity: 'decision', id: 'dec_1' }), []);
    assert.deepEqual(createEntityNextActions({ entity: 'trap', id: 'trp_1' }), []);
  });
});
