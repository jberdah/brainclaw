import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { createAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import {
  createRuntimeEvent,
  isReflectableRuntimeEvent,
  isTaskLifecycleRuntimeEvent,
  listRuntimeEventsBySession,
  queryRuntimeEvents,
} from '../../src/core/events.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

beforeEach(() => {
  ws = createTestWorkspace({ currentAgent: 'dispatcher' });
});

afterEach(() => {
  ws.cleanup();
});

describe('core/events runtime protocol', () => {
  it('persists correlated assignment and run runtime events', () => {
    const assignment = createAssignment({
      claim_id: 'clm_evt_1',
      plan_id: 'pln_evt_1',
      sequence_id: 'seq_evt_1',
      agent: 'codex',
      dispatcher_agent: 'dispatcher',
      scope: 'src/runtime/events',
      description: 'Assignment runtime event test',
    }, ws.dir);

    transitionAssignment(assignment.id, 'offered', { actor: 'dispatcher' }, ws.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'codex', session_id: 'sess_evt_1' }, ws.dir);

    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: assignment.claim_id,
      plan_id: assignment.plan_id,
      sequence_id: assignment.sequence_id,
      agent: 'codex',
      transport: 'manual_command',
      scope: assignment.scope,
      description: 'Manual pickup',
    }, ws.dir);
    transitionAgentRun(run.id, 'waiting_input', { actor: 'dispatcher' }, ws.dir);
    transitionAgentRun(run.id, 'running', { actor: 'codex', session_id: 'sess_evt_1' }, ws.dir);

    const assignmentEvents = queryRuntimeEvents({ assignment_id: assignment.id }, ws.dir);
    const runEvents = queryRuntimeEvents({ run_id: run.id }, ws.dir);

    assert.ok(assignmentEvents.some((event) => event.event_type === 'assignment_created'));
    assert.ok(assignmentEvents.some((event) => event.event_type === 'assignment_accepted'));
    assert.ok(runEvents.some((event) => event.event_type === 'run_created'));
    assert.ok(runEvents.some((event) => event.event_type === 'run_running'));
    assert.ok(runEvents.every((event) => event.assignment_id === assignment.id));
    assert.ok(runEvents.every((event) => event.run_id === run.id));
  });

  it('filters session queries while keeping agent-runtime events non-reflectable', () => {
    createRuntimeEvent({
      agent: 'openclaw',
      session_id: 'sess_reflectable',
      event_type: 'observation',
      text: 'Human-meaningful observation',
      tags: ['auth'],
    }, ws.dir);
    createRuntimeEvent({
      agent: 'codex',
      session_id: 'sess_reflectable',
      event_type: 'assignment_started',
      text: 'SDK machine event',
      tags: ['agent-runtime', 'assignment'],
      assignment_id: 'asgn_machine',
      claim_id: 'clm_machine',
      status: 'started',
    }, ws.dir);

    const sessionEvents = listRuntimeEventsBySession('sess_reflectable', ws.dir);
    assert.equal(sessionEvents.length, 2);

    const reflectable = sessionEvents.filter(isReflectableRuntimeEvent);
    const taskLifecycle = sessionEvents.filter(isTaskLifecycleRuntimeEvent);

    assert.equal(reflectable.length, 1);
    assert.equal(reflectable[0]?.event_type, 'observation');
    assert.equal(taskLifecycle.length, 0);
  });
});
