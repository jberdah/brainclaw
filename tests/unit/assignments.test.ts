/**
 * Unit tests for Assignment FSM, timestamps, idempotence, and CRUD.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssignment,
  loadAssignment,
  listAssignments,
  transitionAssignment,
  recordProgress,
  validateTransition,
  getActiveAssignmentForAgent,
  bumpActiveAssignmentHeartbeat,
} from '../../src/core/assignments.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { AssignmentStatus } from '../../src/core/schema.js';

let ws: TestWorkspace;

beforeEach(() => {
  ws = createTestWorkspace({ currentAgent: 'test-dispatcher' });
});

afterEach(() => {
  ws.cleanup();
});

function makeAssignment(overrides?: { agent?: string; scope?: string }) {
  return createAssignment({
    claim_id: 'clm_test1234',
    agent: overrides?.agent ?? 'test-worker',
    dispatcher_agent: 'test-dispatcher',
    scope: overrides?.scope ?? 'src/test',
    description: 'Test assignment',
  }, ws.dir);
}

describe('Assignment CRUD', () => {
  it('creates an assignment with status=created', () => {
    const a = makeAssignment();
    assert.ok(a.id.startsWith('asgn_'));
    assert.equal(a.status, 'created');
    assert.equal(a.claim_id, 'clm_test1234');
    assert.equal(a.agent, 'test-worker');
    assert.ok(a.created_at);
  });

  it('loads an assignment by id', () => {
    const a = makeAssignment();
    const loaded = loadAssignment(a.id, ws.dir);
    assert.ok(loaded);
    assert.equal(loaded.id, a.id);
    assert.equal(loaded.status, 'created');
  });

  it('lists assignments with filters', () => {
    makeAssignment({ agent: 'agent-a', scope: 'src/a' });
    makeAssignment({ agent: 'agent-b', scope: 'src/b' });
    const all = listAssignments(ws.dir);
    assert.equal(all.length, 2);
    const filtered = listAssignments(ws.dir, { agent: 'agent-a' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent, 'agent-a');
  });
});

describe('Assignment FSM — validateTransition', () => {
  const validPaths: Array<[AssignmentStatus, AssignmentStatus]> = [
    ['created', 'offered'],
    ['created', 'cancelled'],
    ['offered', 'accepted'],
    ['offered', 'expired'],
    ['accepted', 'started'],
    ['accepted', 'cancelled'],
    ['accepted', 'timed_out'],
    ['started', 'completed'],
    ['started', 'cancelled'],
    ['started', 'failed'],
    ['started', 'blocked'],
    ['started', 'timed_out'],
    ['failed', 'retrying'],
    ['timed_out', 'retrying'],
    ['retrying', 'offered'],
    ['blocked', 'rerouted'],
    ['blocked', 'cancelled'],
  ];

  for (const [from, to] of validPaths) {
    it(`allows ${from} → ${to}`, () => {
      const result = validateTransition(from, to);
      assert.ok(result.valid, `Expected ${from} → ${to} to be valid`);
    });
  }

  const invalidPaths: Array<[AssignmentStatus, AssignmentStatus]> = [
    ['created', 'started'],
    ['offered', 'completed'],
    ['accepted', 'failed'],
    ['completed', 'started'],
    ['cancelled', 'offered'],
    ['expired', 'offered'],
    ['rerouted', 'offered'],
  ];

  for (const [from, to] of invalidPaths) {
    it(`rejects ${from} → ${to}`, () => {
      const result = validateTransition(from, to);
      assert.ok(!result.valid, `Expected ${from} → ${to} to be invalid`);
    });
  }
});

describe('Assignment FSM — transitionAssignment', () => {
  it('transitions created → offered', () => {
    const a = makeAssignment();
    const result = transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    assert.equal(result.assignment.status, 'offered');
    assert.equal(result.previous_status, 'created');
    assert.ok(result.assignment.offered_at);
    assert.ok(result.assignment.updated_at);
  });

  it('transitions offered → accepted → started → completed', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker', session_id: 'sess_1' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);
    const result = transitionAssignment(a.id, 'completed', {
      actor: 'worker',
      artifacts: [{ type: 'commit', ref: 'abc123' }],
    }, ws.dir);

    assert.equal(result.assignment.status, 'completed');
    assert.ok(result.assignment.accepted_at);
    assert.ok(result.assignment.started_at);
    assert.ok(result.assignment.completed_at);
    assert.equal(result.assignment.artifacts.length, 1);
    assert.equal(result.assignment.session_id, 'sess_1');
  });

  it('transitions started → cancelled with timestamp', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);
    const result = transitionAssignment(a.id, 'cancelled', {
      actor: 'dispatcher',
      status_reason: 'Supervisor aborted the lane',
    }, ws.dir);

    assert.equal(result.assignment.status, 'cancelled');
    assert.equal(result.assignment.status_reason, 'Supervisor aborted the lane');
    assert.ok(result.assignment.cancelled_at);
  });

  it('transitions started → failed with error_message', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);
    const result = transitionAssignment(a.id, 'failed', {
      actor: 'worker',
      error_message: 'TypeScript build failed',
    }, ws.dir);

    assert.equal(result.assignment.status, 'failed');
    assert.ok(result.assignment.failed_at);
    assert.equal(result.assignment.error_message, 'TypeScript build failed');
  });

  it('transitions started → blocked → rerouted', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'blocked', { actor: 'worker', status_reason: 'Waiting on API key' }, ws.dir);
    const result = transitionAssignment(a.id, 'rerouted', { actor: 'dispatcher' }, ws.dir);

    assert.equal(result.assignment.status, 'rerouted');
    assert.ok(result.assignment.blocked_at);
    assert.ok(result.assignment.rerouted_at);
  });

  it('rejects invalid transition with clear error', () => {
    const a = makeAssignment();
    assert.throws(
      () => transitionAssignment(a.id, 'completed', { actor: 'worker' }, ws.dir),
      /Invalid transition: created → completed/,
    );
  });

  it('throws for non-existent assignment', () => {
    assert.throws(
      () => transitionAssignment('asgn_nonexistent', 'offered', { actor: 'x' }, ws.dir),
      /Assignment not found/,
    );
  });
});

describe('Assignment FSM — idempotent transitions', () => {
  it('same-status transition is a no-op', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);

    // Retry accepted (network timeout scenario)
    const result = transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    assert.equal(result.assignment.status, 'accepted');
    assert.equal(result.idempotent, true);
    assert.ok(result.assignment.last_heartbeat_at);
  });

  it('same-status offered is idempotent', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);

    const result = transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    assert.equal(result.idempotent, true);
    assert.equal(result.assignment.status, 'offered');
  });
});

describe('Assignment — recordProgress', () => {
  it('updates heartbeat on started assignment', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);

    const before = loadAssignment(a.id, ws.dir)!;
    const updated = recordProgress(a.id, { message: 'halfway done' }, ws.dir);

    assert.equal(updated.status, 'started');
    assert.equal(updated.status_reason, 'halfway done');
    assert.ok(updated.last_heartbeat_at);
    assert.ok(updated.updated_at);
    // Heartbeat should be >= before
    assert.ok(new Date(updated.last_heartbeat_at!).getTime() >= new Date(before.last_heartbeat_at!).getTime());
  });

  it('adds artifacts on progress', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'worker' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'worker' }, ws.dir);

    recordProgress(a.id, { artifacts: [{ type: 'file', ref: 'src/new.ts' }] }, ws.dir);
    const updated = loadAssignment(a.id, ws.dir)!;
    assert.equal(updated.artifacts.length, 1);
    assert.equal(updated.artifacts[0].ref, 'src/new.ts');
  });

  it('rejects progress on non-started assignment', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    assert.throws(
      () => recordProgress(a.id, { message: 'nope' }, ws.dir),
      /expected started/,
    );
  });
});

describe('Assignment — getActiveAssignmentForAgent', () => {
  it('returns undefined when no assignments exist', () => {
    const result = getActiveAssignmentForAgent('agent_nonexistent', ws.dir);
    assert.equal(result, undefined);
  });

  it('returns the active assignment by agent_id', () => {
    const worker = ws.registerAgent('worker-lookup');
    const a = createAssignment({
      claim_id: 'clm_lookup_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'test-dispatcher',
      scope: 'src/lookup',
      description: 'Lookup test',
    }, ws.dir);
    transitionAssignment(a.id, 'offered', { actor: 'test-dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: worker.agent_name }, ws.dir);

    const found = getActiveAssignmentForAgent(worker.agent_id!, ws.dir);
    assert.ok(found);
    assert.equal(found.id, a.id);
  });

  it('ignores terminal assignments', () => {
    const worker = ws.registerAgent('worker-terminal');
    const a = createAssignment({
      claim_id: 'clm_terminal_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'test-dispatcher',
      scope: 'src/terminal',
      description: 'Terminal test',
    }, ws.dir);
    transitionAssignment(a.id, 'offered', { actor: 'test-dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: worker.agent_name }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: worker.agent_name }, ws.dir);
    transitionAssignment(a.id, 'completed', { actor: worker.agent_name }, ws.dir);

    const found = getActiveAssignmentForAgent(worker.agent_id!, ws.dir);
    assert.equal(found, undefined);
  });

  it('uses claimId fast-path when provided', () => {
    const worker = ws.registerAgent('worker-claim-lookup');
    const a = createAssignment({
      claim_id: 'clm_claim_path_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'test-dispatcher',
      scope: 'src/claim-path',
      description: 'Claim path test',
    }, ws.dir);
    transitionAssignment(a.id, 'offered', { actor: 'test-dispatcher' }, ws.dir);

    const found = getActiveAssignmentForAgent(worker.agent_id!, ws.dir, 'clm_claim_path_1');
    assert.ok(found);
    assert.equal(found.id, a.id);

    // Wrong claim_id — fast-path misses, falls back to agent scan, still finds the same assignment
    const foundByFallback = getActiveAssignmentForAgent(worker.agent_id!, ws.dir, 'clm_wrong_claim');
    assert.ok(foundByFallback, 'falls back to agent scan on claim miss');
    assert.equal(foundByFallback.id, a.id, 'same assignment found via fallback');
  });
});

describe('Assignment — bumpActiveAssignmentHeartbeat', () => {
  it('bumps last_heartbeat_at without status change', () => {
    const worker = ws.registerAgent('worker-heartbeat');
    const a = createAssignment({
      claim_id: 'clm_hb_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'test-dispatcher',
      scope: 'src/hb',
      description: 'Heartbeat test',
    }, ws.dir);
    transitionAssignment(a.id, 'offered', { actor: 'test-dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: worker.agent_name }, ws.dir);

    const before = loadAssignment(a.id, ws.dir)!;
    const bumped = bumpActiveAssignmentHeartbeat('clm_hb_1', worker.agent_id, ws.dir);
    assert.ok(bumped, 'returns true when assignment found');

    const after = loadAssignment(a.id, ws.dir)!;
    assert.equal(after.status, 'accepted');
    assert.ok(after.last_heartbeat_at);
    assert.ok(
      new Date(after.last_heartbeat_at!).getTime() >= new Date(before.last_heartbeat_at!).getTime(),
      'last_heartbeat_at advanced',
    );
  });

  it('returns false when no active assignment found', () => {
    const result = bumpActiveAssignmentHeartbeat('clm_missing', 'agent_missing', ws.dir);
    assert.equal(result, false);
  });

  it('does not bump terminal assignments', () => {
    const worker = ws.registerAgent('worker-hb-terminal');
    const a = createAssignment({
      claim_id: 'clm_hb_terminal_1',
      agent: worker.agent_name,
      agent_id: worker.agent_id,
      dispatcher_agent: 'test-dispatcher',
      scope: 'src/hb-terminal',
      description: 'HB terminal test',
    }, ws.dir);
    transitionAssignment(a.id, 'offered', { actor: 'test-dispatcher' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: worker.agent_name }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: worker.agent_name }, ws.dir);
    transitionAssignment(a.id, 'completed', { actor: worker.agent_name }, ws.dir);

    const result = bumpActiveAssignmentHeartbeat('clm_hb_terminal_1', worker.agent_id, ws.dir);
    assert.equal(result, false, 'does not bump completed assignment');
  });
});

describe('Assignment — timestamps', () => {
  it('sets all transition-specific timestamps', () => {
    const a = makeAssignment();
    transitionAssignment(a.id, 'offered', { actor: 'd' }, ws.dir);
    transitionAssignment(a.id, 'accepted', { actor: 'w' }, ws.dir);
    transitionAssignment(a.id, 'started', { actor: 'w' }, ws.dir);
    transitionAssignment(a.id, 'timed_out', { actor: 'sweeper' }, ws.dir);

    const final = loadAssignment(a.id, ws.dir)!;
    assert.ok(final.offered_at);
    assert.ok(final.accepted_at);
    assert.ok(final.started_at);
    assert.ok(final.timed_out_at);
    assert.ok(final.updated_at);
  });
});
