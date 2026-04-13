/**
 * Unit tests for MCP ergonomics: implicit heartbeat + auto-session.
 *
 * Covers GAP 2 (workers skip heartbeats) and GAP 3 (session_id="unknown")
 * from E2E test n°1.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import {
  createAssignment,
  loadAssignment,
  transitionAssignment,
} from '../../src/core/assignments.js';
import { saveClaim, generateClaimId, loadClaim } from '../../src/core/claims.js';
import { nowISO } from '../../src/core/ids.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Assignment } from '../../src/core/schema.js';

/** Return the best available liveness timestamp from an assignment (always a string). */
function hb(a: Assignment): string {
  return a.last_heartbeat_at ?? a.updated_at ?? a.created_at;
}

let ws: TestWorkspace;
let savedClaimId: string | undefined;

beforeEach(() => {
  ws = createTestWorkspace({ currentAgent: 'dispatcher' });
  savedClaimId = process.env.BRAINCLAW_CLAIM_ID;
  delete process.env.BRAINCLAW_CLAIM_ID;
});

afterEach(() => {
  if (savedClaimId === undefined) {
    delete process.env.BRAINCLAW_CLAIM_ID;
  } else {
    process.env.BRAINCLAW_CLAIM_ID = savedClaimId;
  }
  ws.cleanup();
});

/** Create an active claim and return its ID. */
function makeActiveClaim(agentName: string): string {
  const claimId = generateClaimId();
  saveClaim({
    id: claimId,
    agent: agentName,
    project_id: 'prj_test_workspace',
    scope: 'src/',
    description: 'Test claim',
    created_at: nowISO(),
    status: 'active',
  }, ws.dir);
  return claimId;
}

/** Create an assignment fully transitioned to "started". */
function makeStartedAssignment(claimId: string, agentName: string, agentId: string) {
  const asgn = createAssignment({
    claim_id: claimId,
    agent: agentName,
    agent_id: agentId,
    dispatcher_agent: 'dispatcher',
    scope: 'src/',
    description: 'Test assignment',
  }, ws.dir);
  transitionAssignment(asgn.id, 'offered', { actor: 'dispatcher' }, ws.dir);
  transitionAssignment(asgn.id, 'accepted', { actor: agentName }, ws.dir);
  transitionAssignment(asgn.id, 'started', { actor: agentName }, ws.dir);
  return loadAssignment(asgn.id, ws.dir)!;
}

// ── Implicit heartbeat ────────────────────────────────────────────────────────

describe('MCP ergonomics — implicit heartbeat (GAP 2)', () => {
  it('bumps last_heartbeat_at on any tool call when BRAINCLAW_CLAIM_ID is set', async () => {
    const worker = ws.registerAgent('worker-hb');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    const beforeHb = hb(asgn);

    // Small delay so the ISO timestamp will differ
    await new Promise((r) => setTimeout(r, 20));

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
    });

    const afterHb = hb(loadAssignment(asgn.id, ws.dir)!);
    assert.ok(afterHb > beforeHb, `heartbeat should advance: before=${beforeHb} after=${afterHb}`);
  });

  it('does NOT bump last_heartbeat_at when BRAINCLAW_CLAIM_ID is absent', async () => {
    const worker = ws.registerAgent('worker-nohb');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    const beforeHb = hb(asgn);

    await new Promise((r) => setTimeout(r, 20));

    // Deliberately NOT setting BRAINCLAW_CLAIM_ID
    await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
    });

    const afterHb = hb(loadAssignment(asgn.id, ws.dir)!);
    assert.equal(afterHb, beforeHb, 'heartbeat should not change without BRAINCLAW_CLAIM_ID');
  });

  it('bumps heartbeat even for read-only tools (any tool call proves liveness)', async () => {
    const worker = ws.registerAgent('worker-readhb');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    const beforeHb = hb(asgn);
    await new Promise((r) => setTimeout(r, 20));

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    // bclaw_get_agent_board_summary is a read tool — should still trigger heartbeat
    await executeMcpToolCall({
      name: 'bclaw_get_agent_board_summary',
      args: {},
      cwd: ws.dir,
    });

    const afterHb = hb(loadAssignment(asgn.id, ws.dir)!);
    assert.ok(afterHb > beforeHb, 'heartbeat should advance for read tools too');
  });
});

// ── Auto-session ─────────────────────────────────────────────────────────────

describe('MCP ergonomics — auto-session (GAP 3)', () => {
  it('starts a session implicitly when BRAINCLAW_CLAIM_ID is set and no connectionSessionId', async () => {
    const worker = ws.registerAgent('worker-autosess');
    const claimId = makeActiveClaim(worker.agent_name);
    makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    const outcome = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
      connectionSessionId: undefined,
    });

    assert.ok(
      outcome.nextConnectionSessionId,
      'nextConnectionSessionId should be returned when auto-session fires',
    );
    assert.ok(
      outcome.nextConnectionSessionId!.length > 0,
      'auto session ID should be non-empty',
    );
  });

  it('adopts the claim with the new session_id so subsequent calls use a real session', async () => {
    const worker = ws.registerAgent('worker-claimadopt');
    const claimId = makeActiveClaim(worker.agent_name);
    makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    const outcome = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
      connectionSessionId: undefined,
    });

    const sessionId = outcome.nextConnectionSessionId;
    assert.ok(sessionId);

    // The claim should now carry the session_id
    const claim = loadClaim(claimId, ws.dir);
    assert.equal(claim.session_id, sessionId, 'claim.session_id should match the auto-session id');
  });

  it('links session_id to active assignments so they no longer show "unknown"', async () => {
    const worker = ws.registerAgent('worker-sesslink');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    // Confirm assignment has no session before the call
    assert.ok(!asgn.session_id, 'assignment should start with no session_id');

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    const outcome = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
      connectionSessionId: undefined,
    });

    const sessionId = outcome.nextConnectionSessionId;
    assert.ok(sessionId);

    const updated = loadAssignment(asgn.id, ws.dir)!;
    assert.equal(updated.session_id, sessionId, 'assignment.session_id should be linked to auto-session');
    assert.notEqual(updated.session_id, 'unknown', 'assignment.session_id must not be "unknown"');
  });

  it('does NOT create an auto-session when connectionSessionId is already provided', async () => {
    const worker = ws.registerAgent('worker-existsess');
    const claimId = makeActiveClaim(worker.agent_name);
    makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    process.env.BRAINCLAW_CLAIM_ID = claimId;

    const outcome = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
      connectionSessionId: 'existing-sess-id',
    });

    assert.ok(
      !outcome.nextConnectionSessionId,
      'nextConnectionSessionId should not be set when session already exists',
    );
  });

  it('does NOT create an auto-session when BRAINCLAW_CLAIM_ID is absent', async () => {
    const worker = ws.registerAgent('worker-noclaimenv');
    const claimId = makeActiveClaim(worker.agent_name);
    makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    // No BRAINCLAW_CLAIM_ID set
    const outcome = await executeMcpToolCall({
      name: 'bclaw_get_context',
      args: {},
      cwd: ws.dir,
      connectionSessionId: undefined,
    });

    assert.ok(
      !outcome.nextConnectionSessionId,
      'nextConnectionSessionId should not be set without BRAINCLAW_CLAIM_ID',
    );
  });
});

// ── getActiveAssignmentForAgent ───────────────────────────────────────────────

describe('getActiveAssignmentForAgent', () => {
  it('returns the most recent non-terminal assignment by claim_id', async () => {
    const { getActiveAssignmentForAgent } = await import('../../src/core/assignments.js');
    const worker = ws.registerAgent('worker-getactive');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    const found = getActiveAssignmentForAgent(worker.agent_id, ws.dir, claimId);
    assert.ok(found, 'should find the active assignment');
    assert.equal(found!.id, asgn.id);
  });

  it('returns undefined for terminal assignments', async () => {
    const { getActiveAssignmentForAgent, transitionAssignment: trans } = await import('../../src/core/assignments.js');
    const worker = ws.registerAgent('worker-terminal');
    const claimId = makeActiveClaim(worker.agent_name);
    const asgn = makeStartedAssignment(claimId, worker.agent_name, worker.agent_id);

    trans(asgn.id, 'completed', { actor: worker.agent_name }, ws.dir);

    const found = getActiveAssignmentForAgent(worker.agent_id, ws.dir, claimId);
    assert.equal(found, undefined, 'should not return completed assignments');
  });
});
