/**
 * pln#560 step 2 slice 2 — pure board adapters.
 * projection → BoardData arrays + summary counts, per
 * docs/concepts/observer-protocol.md §6 / §6.1.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyRecord, type Projection, type JournalRecord } from './journal-consumer.js';
import { projectBoard, projectCounts, attentionRequired } from './board-projection.js';

let seq = 0;
function put(proj: Projection, item_type: string, item_id: string, payload: Record<string, unknown>): void {
  const r: JournalRecord = { v: 2, seq: ++seq, action: 'create', item_type, item_id, payload };
  applyRecord(proj, r);
}

describe('board adapters (pln#560 s2 slice2)', () => {
  it('routes each item_type to its BoardData slot; state→actions, full payload kept', () => {
    const proj: Projection = new Map();
    put(proj, 'plan', 'pln_1', { id: 'pln_1', status: 'in_progress', text: 'p' });
    put(proj, 'claim', 'clm_1', { id: 'clm_1', status: 'active' });
    put(proj, 'state', 'act_1', { id: 'act_1', status: 'pending' });
    put(proj, 'handoff', 'hnd_1', { id: 'hnd_1' });
    put(proj, 'runtime_note', 'rtn_1', { id: 'rtn_1' });
    put(proj, 'trap', 'trp_1', { id: 'trp_1', severity: 'high' });
    put(proj, 'candidate', 'cnd_1', { id: 'cnd_1', status: 'pending', source: 'manual' });
    const board = projectBoard(proj);
    assert.equal(board.active_plans.length, 1);
    assert.equal(board.active_claims.length, 1);
    assert.equal(board.active_actions.length, 1, 'item_type "state" feeds active_actions');
    assert.equal((board.active_actions[0] as any).id, 'act_1');
    assert.equal(board.open_handoffs.length, 1);
    assert.equal(board.runtime_notes.length, 1);
    assert.equal(board.known_traps.length, 1);
    assert.equal(board.pending_candidates.length, 1);
    assert.equal((board.active_plans[0] as any).text, 'p', 'full post-image preserved');
  });

  it('does not pre-filter by status — leaves the active* filter to the renderer', () => {
    const proj: Projection = new Map();
    put(proj, 'plan', 'pln_done', { id: 'pln_done', status: 'done' });
    put(proj, 'plan', 'pln_todo', { id: 'pln_todo', status: 'todo' });
    const board = projectBoard(proj);
    assert.equal(board.active_plans.length, 2, 'both kept; renderer applies activePlans()');
  });

  it('sequence collapses to the active one (else first seen)', () => {
    const proj: Projection = new Map();
    put(proj, 'sequence', 'seq_old', { id: 'seq_old', status: 'closed' });
    put(proj, 'sequence', 'seq_live', { id: 'seq_live', status: 'active' });
    const board = projectBoard(proj);
    assert.equal((board.active_sequence as any).id, 'seq_live');
  });

  it('ignores item_types with no board array (decision/constraint/session)', () => {
    const proj: Projection = new Map();
    put(proj, 'decision', 'dec_1', { id: 'dec_1' });
    put(proj, 'constraint', 'con_1', { id: 'con_1' });
    const board = projectBoard(proj);
    // none of the array slots gained a row
    const total = board.active_plans.length + board.active_claims.length + board.active_actions.length
      + board.open_handoffs.length + board.runtime_notes.length + board.known_traps.length
      + board.pending_candidates.length;
    assert.equal(total, 0);
  });

  it('attention composite = actions + non-auto pending candidates + blocked assignments + stale runs', () => {
    const proj: Projection = new Map();
    put(proj, 'state', 'a1', { id: 'a1', status: 'pending' });
    put(proj, 'state', 'a2', { id: 'a2', status: 'resolved' });           // not pending → excluded
    put(proj, 'candidate', 'c1', { id: 'c1', status: 'pending', source: 'manual' });
    put(proj, 'candidate', 'c2', { id: 'c2', status: 'pending', source: 'auto' }); // auto → excluded
    put(proj, 'candidate', 'c3', { id: 'c3', status: 'accepted', source: 'manual' }); // not pending → excluded
    put(proj, 'assignment', 'as1', { id: 'as1', status: 'blocked' });
    put(proj, 'assignment', 'as2', { id: 'as2', status: 'active' });      // not blocked → excluded
    put(proj, 'agent_run', 'r1', { id: 'r1', status: 'failed' });
    put(proj, 'agent_run', 'r2', { id: 'r2', status: 'waiting_input' });
    put(proj, 'agent_run', 'r3', { id: 'r3', status: 'running' });        // healthy → excluded
    const att = attentionRequired(projectBoard(proj));
    assert.equal(att.pending_actions, 1);
    assert.equal(att.pending_human_candidates, 1);
    assert.equal(att.blocked_assignments, 1);
    assert.equal(att.stale_runs, 2);
    assert.equal(att.total, 5);
  });

  it('isAutoCandidate also excludes session-end origin candidates', () => {
    const proj: Projection = new Map();
    put(proj, 'candidate', 'c1', { id: 'c1', status: 'pending', origin: 'session-end-harvest' });
    assert.equal(attentionRequired(projectBoard(proj)).pending_human_candidates, 0);
  });

  it('counts: plans=in_progress+todo, claims=active, actions=attention, agents/sessions=0', () => {
    const proj: Projection = new Map();
    put(proj, 'plan', 'p1', { id: 'p1', status: 'in_progress' });
    put(proj, 'plan', 'p2', { id: 'p2', status: 'todo' });
    put(proj, 'plan', 'p3', { id: 'p3', status: 'done' });   // excluded from count
    put(proj, 'claim', 'cl1', { id: 'cl1', status: 'active' });
    put(proj, 'claim', 'cl2', { id: 'cl2', status: 'released' }); // excluded
    put(proj, 'state', 'a1', { id: 'a1', status: 'pending' });
    const counts = projectCounts(proj);
    assert.equal(counts.plans, 2);
    assert.equal(counts.claims, 1);
    assert.equal(counts.actions, 1);
    assert.equal(counts.agents, 0, 'not a journal entity — caller seeds via MCP');
    assert.equal(counts.sessions, 0);
  });

  it('dual-mode (§6.1): empty projection yields all-zero counts and empty arrays, never throws', () => {
    const proj: Projection = new Map();
    const board = projectBoard(proj);
    assert.deepEqual(board.active_assignments, []);
    assert.deepEqual(board.active_runs, []);
    const counts = projectCounts(proj);
    assert.equal(counts.assignments, 0);
    assert.equal(counts.runs, 0);
    assert.equal(counts.actions, 0);
    assert.equal(counts.failedRuns, 0);
  });

  it('failedRuns counts only failed runs', () => {
    const proj: Projection = new Map();
    put(proj, 'agent_run', 'r1', { id: 'r1', status: 'failed' });
    put(proj, 'agent_run', 'r2', { id: 'r2', status: 'running' });
    assert.equal(projectCounts(proj).failedRuns, 1);
  });
});
