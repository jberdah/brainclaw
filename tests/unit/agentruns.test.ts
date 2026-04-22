import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentRun,
  findLatestAgentRunForAssignment,
  listAgentRuns,
  loadAgentRun,
  recordAgentRunProgress,
  syncAgentRunFromAssignmentTransition,
  transitionAgentRun,
} from '../../src/core/agentruns.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

beforeEach(() => {
  ws = createTestWorkspace({ currentAgent: 'dispatcher' });
});

afterEach(() => {
  ws.cleanup();
});

function makeRun(overrides?: Partial<Parameters<typeof createAgentRun>[0]>) {
  return createAgentRun({
    assignment_id: 'asgn_test1234',
    claim_id: 'clm_test1234',
    agent: 'codex',
    transport: 'manual_command',
    scope: 'src/runtime/test',
    description: 'Test run',
    ...overrides,
  }, ws.dir);
}

describe('AgentRun CRUD', () => {
  it('creates a run linked to an assignment', () => {
    const run = makeRun();
    assert.ok(run.id.startsWith('run_'));
    assert.equal(run.assignment_id, 'asgn_test1234');
    assert.equal(run.status, 'created');
    assert.equal(run.attempt_index, 1);
  });

  it('increments attempt index for multiple runs of one assignment', () => {
    const first = makeRun();
    const second = makeRun({ retry_of_run_id: first.id });
    assert.equal(first.attempt_index, 1);
    assert.equal(second.attempt_index, 2);
    assert.equal(findLatestAgentRunForAssignment('asgn_test1234', ws.dir)?.id, second.id);
  });

  it('lists runs with filters', () => {
    makeRun({ agent: 'codex', transport: 'manual_command' });
    makeRun({ assignment_id: 'asgn_other', agent: 'claude-code', transport: 'cli_spawn' });
    assert.equal(listAgentRuns(ws.dir).length, 2);
    assert.equal(listAgentRuns(ws.dir, { agent: 'codex' }).length, 1);
    assert.equal(listAgentRuns(ws.dir, { transport: 'cli_spawn' }).length, 1);
  });
});

describe('AgentRun transitions', () => {
  it('supports manual/inbox waiting -> running -> completed', () => {
    const run = makeRun();
    transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    transitionAgentRun(run.id, 'running', { actor: 'codex', session_id: 'sess_run' }, ws.dir);
    const completed = transitionAgentRun(run.id, 'completed', { actor: 'codex', session_id: 'sess_run' }, ws.dir);
    assert.equal(completed.run.status, 'completed');
    assert.ok(completed.run.completed_at);
    assert.equal(completed.run.session_id, 'sess_run');
  });

  it('supports launching -> running -> failed for spawned runs', () => {
    const run = makeRun({ transport: 'cli_spawn', command: 'codex exec "task"' });
    transitionAgentRun(run.id, 'launching', { actor: 'dispatcher', pid: 1234 }, ws.dir);
    transitionAgentRun(run.id, 'running', { actor: 'dispatcher', pid: 1234 }, ws.dir);
    const failed = transitionAgentRun(run.id, 'failed', { actor: 'codex', error_message: 'crashed' }, ws.dir);
    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.run.error_message, 'crashed');
    assert.ok(failed.run.failed_at);
  });

  it('same-status transitions are idempotent', () => {
    const run = makeRun();
    transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    const again = transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    assert.equal(again.idempotent, true);
    assert.equal(again.run.status, 'waiting_input');
  });

  it('progress can promote waiting_input to running and update artifacts', () => {
    const run = makeRun();
    transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    const updated = recordAgentRunProgress(run.id, {
      actor: 'codex',
      session_id: 'sess_progress',
      message: 'picked up manually',
      artifacts: [{ type: 'file', ref: 'src/runtime/test.ts' }],
    }, ws.dir);

    assert.equal(updated.status, 'running');
    assert.equal(updated.session_id, 'sess_progress');
    assert.equal(updated.artifacts.length, 1);
    assert.ok(updated.started_at);
  });

  it('one assignment can safely produce multiple runs across retries', () => {
    const first = makeRun({ transport: 'cli_spawn' });
    transitionAgentRun(first.id, 'launching', { actor: 'dispatcher' }, ws.dir);
    transitionAgentRun(first.id, 'running', { actor: 'dispatcher' }, ws.dir);
    transitionAgentRun(first.id, 'failed', { actor: 'codex', error_message: 'first attempt failed' }, ws.dir);

    const retry = makeRun({
      transport: 'manual_command',
      retry_of_run_id: first.id,
      status_reason: 'retry after spawn failure',
    });
    transitionAgentRun(retry.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);

    const runs = listAgentRuns(ws.dir, { assignment_id: 'asgn_test1234' });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].attempt_index, 1);
    assert.equal(runs[1].attempt_index, 2);
    assert.equal(loadAgentRun(retry.id, ws.dir)?.retry_of_run_id, first.id);
    assert.equal(findLatestAgentRunForAssignment('asgn_test1234', ws.dir)?.id, retry.id);
  });
});

describe('syncAgentRunFromAssignmentTransition — guard against invalid transitions', () => {

  it('skips transition when run is already in terminal state (no crash)', () => {
    const assignment = createAssignment({
      claim_id: 'clm_sync_guard',
      agent: 'test-agent',
      dispatcher_agent: 'dispatcher',
      scope: 'src/sync-guard',
      description: 'Guard test',
    }, ws.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: 'test-agent',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Guard test run',
    }, ws.dir);

    // Move run to a terminal state
    transitionAgentRun(run.id, 'running', { actor: 'test-agent' }, ws.dir);
    transitionAgentRun(run.id, 'completed', { actor: 'test-agent' }, ws.dir);

    // Now try to sync from an assignment transition to 'started' (which would
    // try run → 'running') — should NOT crash despite completed → running being invalid
    assert.doesNotThrow(() => {
      syncAgentRunFromAssignmentTransition(
        assignment,
        'started',
        { actor: 'dispatcher' },
        ws.dir,
      );
    });

    // Run should still be completed (transition was skipped)
    const reloaded = loadAgentRun(run.id, ws.dir);
    assert.equal(reloaded?.status, 'completed');
  });

  it('skips transition when run is in launching and assignment completes', () => {
    const assignment = createAssignment({
      claim_id: 'clm_sync_launch',
      agent: 'test-agent-2',
      dispatcher_agent: 'dispatcher',
      scope: 'src/sync-launch',
      description: 'Launch guard test',
    }, ws.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: 'test-agent-2',
      transport: 'cli_spawn',
      scope: assignment.scope,
      description: 'Launch guard run',
      status: 'launching',
    }, ws.dir);

    // Try to sync 'completed' — launching → completed is NOT valid
    assert.doesNotThrow(() => {
      syncAgentRunFromAssignmentTransition(
        assignment,
        'completed',
        { actor: 'test-agent-2' },
        ws.dir,
      );
    });

    // Run should still be launching (transition was skipped)
    const reloaded = loadAgentRun(run.id, ws.dir);
    assert.equal(reloaded?.status, 'launching');
  });

  it('can skip AgentRun sync when a caller manages the launch attempt explicitly', () => {
    const assignment = createAssignment({
      claim_id: 'clm_sync_skip',
      agent: 'test-agent-3',
      dispatcher_agent: 'dispatcher',
      scope: 'src/sync-skip',
      description: 'Skip sync test',
    }, ws.dir);

    const priorRun = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      agent: 'test-agent-3',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Prior attempt',
    }, ws.dir);
    transitionAgentRun(priorRun.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(assignment.id, 'offered', {
      actor: 'dispatcher',
      status_reason: 'assignment offered before launch attempt',
    }, ws.dir);

    const result = transitionAssignment(assignment.id, 'failed', {
      actor: 'dispatcher',
      status_reason: 'new spawn attempt failed before handshake',
      error_message: 'new spawn attempt failed before handshake',
      syncAgentRun: false,
    }, ws.dir);

    assert.equal(result.assignment.status, 'failed');
    assert.equal(loadAgentRun(priorRun.id, ws.dir)?.status, 'waiting_input');
  });
});
