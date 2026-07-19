/**
 * pln#560 step 2 slice 2 — pure board adapters.
 * projection → BoardData arrays + summary counts, per
 * docs/concepts/observer-protocol.md §6 / §6.1.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyRecord, type Projection, type JournalRecord } from './journal-consumer.js';
import { projectBoard, projectCounts, attentionRequired, selectInProgress, filterPending } from './board-projection.js';

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

  it('candidate source resolution mirrors board_summary exactly', () => {
    const proj: Projection = new Map();
    put(proj, 'candidate', 'c1', { id: 'c1', status: 'pending', origin: 'session-end:harvest' });
    put(proj, 'candidate', 'c2', { id: 'c2', status: 'pending', origin: 'session-end-harvest' });
    put(proj, 'candidate', 'c3', { id: 'c3', status: 'pending', origin: 'runtime-note:agent:note' });
    const att = attentionRequired(projectBoard(proj));
    assert.equal(att.pending_human_candidates, 2, 'only session-end: resolves to auto in board_summary');
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

  it('failedRuns mirrors summary-mode stale_runs', () => {
    const proj: Projection = new Map();
    put(proj, 'agent_run', 'r1', { id: 'r1', status: 'failed' });
    put(proj, 'agent_run', 'r2', { id: 'r2', status: 'waiting_input' });
    put(proj, 'agent_run', 'r3', { id: 'r3', status: 'blocked' });
    put(proj, 'agent_run', 'r4', { id: 'r4', status: 'running' });
    assert.equal(projectCounts(proj).failedRuns, 3);
  });

  it('skips malformed non-object payloads without throwing', () => {
    const proj = new Map<string, any>();
    proj.set('plan:p1', { item_type: 'plan', item_id: 'p1', payload: null });
    proj.set('state:a1', { item_type: 'state', item_id: 'a1', payload: 'bad' });
    proj.set('sequence:s1', { item_type: 'sequence', item_id: 's1', payload: 42 });
    assert.doesNotThrow(() => projectBoard(proj as Projection));
    assert.doesNotThrow(() => projectCounts(proj as Projection));
    assert.equal(projectBoard(proj as Projection).active_plans.length, 0);
  });
});

describe('selectInProgress — Live-activity split shared by MCP + journal paths (pln#560 completion)', () => {
  const NOW = Date.parse('2026-07-19T12:00:00Z');
  const WINDOW = 6 * 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('claims: only status active survive; absent status defaults to active', () => {
    const sel = selectInProgress(
      [{ id: 'c1', status: 'active' }, { id: 'c2', status: 'released' }, { id: 'c3' }],
      [], [], NOW, WINDOW,
    );
    assert.deepEqual(sel.active_claims.map((c) => c['id']), ['c1', 'c3']);
  });

  it('assignments: terminal statuses (incl. failed/timed_out) leave live; blocked stays live for the renderer to route', () => {
    const sel = selectInProgress(
      [],
      [
        { id: 'a1', status: 'active' },
        { id: 'a2', status: 'blocked' },
        { id: 'a3', status: 'failed', failed_at: iso(60_000) },
        { id: 'a4', status: 'timed_out', timed_out_at: iso(60_000) },
        { id: 'a5', status: 'completed', completed_at: iso(60_000) },
      ],
      [], NOW, WINDOW,
    );
    assert.deepEqual(sel.live_assignments.map((a) => a['id']), ['a1', 'a2']);
    assert.deepEqual(sel.recently_terminal_assignments.map((a) => a['id']).sort(), ['a3', 'a4', 'a5']);
  });

  it('runs: pre-v1 terminal-ish states (interrupted/timed_out) are excluded from live', () => {
    const sel = selectInProgress(
      [], [],
      [
        { id: 'r1', status: 'running' },
        { id: 'r2', status: 'interrupted' },
        { id: 'r3', status: 'timed_out' },
        { id: 'r4', status: 'waiting_input' },
      ],
      NOW, WINDOW,
    );
    assert.deepEqual(sel.live_runs.map((r) => r['id']), ['r1']);
  });

  it('recently-terminal: outside the window drops out; inside sorts newest first by updated_at', () => {
    const sel = selectInProgress(
      [],
      [
        { id: 'old', status: 'completed', completed_at: iso(WINDOW + 60_000) },
        { id: 'older-update', status: 'failed', failed_at: iso(3 * 60_000), updated_at: iso(3 * 60_000) },
        { id: 'newer-update', status: 'expired', expired_at: iso(30 * 60_000), updated_at: iso(60_000) },
      ],
      [], NOW, WINDOW,
    );
    assert.deepEqual(sel.recently_terminal_assignments.map((a) => a['id']), ['newer-update', 'older-update']);
  });

  it('recently-terminal: timestamp cascade falls back to updated_at/created_at; unparseable drops the row', () => {
    const sel = selectInProgress(
      [],
      [
        { id: 'fallback', status: 'cancelled', created_at: iso(60_000) },
        { id: 'undated', status: 'cancelled' },
        { id: 'garbage', status: 'cancelled', updated_at: 'not-a-date' },
      ],
      [], NOW, WINDOW,
    );
    assert.deepEqual(sel.recently_terminal_assignments.map((a) => a['id']), ['fallback']);
  });
});

describe('filterPending — fetch-equivalent status filter for journal-served sections', () => {
  it('keeps pending (explicit or defaulted), drops everything else', () => {
    const out = filterPending([
      { id: 'k1', status: 'pending' },
      { id: 'k2' },
      { id: 'd1', status: 'accepted' },
      { id: 'd2', status: 'rejected' },
    ]);
    assert.deepEqual(out.map((c) => c['id']), ['k1', 'k2']);
  });

  it('drops in_progress actions — the MCP path fetches status:pending server-side, and the renderer admits in_progress (PR #97 review regression)', () => {
    const out = filterPending([
      { id: 'a1', status: 'pending' },
      { id: 'a2', status: 'in_progress' },
      { id: 'a3', status: 'resolved' },
    ]);
    assert.deepEqual(out.map((a) => a['id']), ['a1'],
      'unfiltered projection actions would leak in_progress rows into ATTENTION/ACTIONS in journal mode only');
  });
});
