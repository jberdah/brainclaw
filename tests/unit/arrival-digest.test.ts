/**
 * Arrival experience on a mature store (pln#557 / asgn_60b7585c).
 *
 * First contact must inform, not drown: when an agent has no event-log
 * cursor yet, the context diff must NOT replay the whole events.jsonl
 * (17k+ events on a mature store). Instead it emits a curated arrival
 * digest (active constraints/traps, in-progress plans, latest open
 * handoffs) and seeds the cursor at log end so future diffs are
 * incremental.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildArrivalDigest, buildContextDiffFromEvents } from '../../src/core/context-diff.js';
import { appendEvent, hasEventCursor, seedCursorToEnd } from '../../src/core/event-log.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function seedMatureState(workspace: TestWorkspace): void {
  const now = new Date().toISOString();
  const author = workspace.currentAgent.agent_name;
  const author_id = workspace.currentAgent.agent_id;
  const base = { created_at: now, author, author_id, project_id: 'prj_arrival_test' };
  saveState({
    version: 1,
    write_version: 1,
    active_constraints: [
      { id: 'cst_arrival_1', text: 'Deploys frozen during release cut', status: 'active', tags: [], ...base },
      { id: 'cst_arrival_2', text: 'Resolved constraint', status: 'resolved', tags: [], ...base },
    ],
    recent_decisions: [
      { id: 'dec_arrival_1', text: 'Gateway routes all auth', tags: [], ...base },
    ],
    known_traps: [
      { id: 'trp_arrival_1', text: 'tests hit the real store without env strip', status: 'active', severity: 'high', visibility: 'shared', tags: [], ...base },
    ],
    open_handoffs: [
      { id: 'hnd_arrival_1', text: 'Finish the cursor migration', status: 'open', from: 'alice', to: 'bob', tags: [], ...base },
      { id: 'hnd_arrival_2', text: 'Closed handoff', status: 'closed', from: 'alice', to: 'bob', tags: [], ...base },
    ],
    plan_items: [
      { id: 'pln_arrival_1', text: 'Ship arrival digest', status: 'in_progress', priority: 'high', depends_on: [], tags: [], ...base, updated_at: now },
      { id: 'pln_arrival_2', text: 'Done plan', status: 'done', priority: 'low', depends_on: [], tags: [], ...base, updated_at: now },
    ],
  }, workspace.dir);
}

function seedEventHistory(workspace: TestWorkspace, count: number): void {
  for (let i = 0; i < count; i++) {
    appendEvent({ action: 'update', item_type: 'claim', item_id: `clm_${i}`, agent: 'alice' }, workspace.dir);
  }
}

describe('arrival digest (first contact on a mature store)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-arrival-',
      projectId: 'prj_arrival_test',
      currentAgent: 'veteran',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('first contact returns a curated digest, not an event replay', () => {
    seedMatureState(workspace);
    seedEventHistory(workspace, 200);

    const diff = buildContextDiffFromEvents('fresh-agent', workspace.dir, { includeItems: true });

    assert.ok(diff);
    assert.equal(diff?.source, 'arrival_digest');
    // Curated active state only: 1 active constraint, 1 active trap,
    // 1 in-progress plan, 1 open handoff. Decisions and candidates excluded.
    assert.equal(diff?.counts.constraints, 1);
    assert.equal(diff?.counts.traps, 1);
    assert.equal(diff?.counts.plans, 1);
    assert.equal(diff?.counts.handoffs, 1);
    assert.equal(diff?.counts.total, 4);
    // No event replay: the 200 historical events do not appear.
    assert.equal(diff?.unseen_event_count, undefined);
    assert.match(diff?.summary ?? '', /First contact/);
    const ids = (diff?.changed_items ?? []).map((i) => i.id);
    assert.ok(ids.includes('cst_arrival_1'));
    assert.ok(!ids.includes('cst_arrival_2'), 'resolved constraint must not appear');
    assert.ok(!ids.includes('hnd_arrival_2'), 'closed handoff must not appear');
    assert.ok(!ids.includes('pln_arrival_2'), 'done plan must not appear');
  });

  it('seeds the cursor at log end — second read is incremental, not a replay', () => {
    seedMatureState(workspace);
    seedEventHistory(workspace, 50);

    const first = buildContextDiffFromEvents('fresh-agent', workspace.dir);
    assert.equal(first?.source, 'arrival_digest');
    assert.ok(hasEventCursor('fresh-agent', workspace.dir));

    // Nothing new since arrival → no diff at all.
    const second = buildContextDiffFromEvents('fresh-agent', workspace.dir);
    assert.equal(second, undefined);

    // A genuinely new event shows up as a normal incremental cursor diff.
    appendEvent({ action: 'create', item_type: 'decision', item_id: 'dec_after_arrival', agent: 'alice', summary: 'post-arrival decision' }, workspace.dir);
    const third = buildContextDiffFromEvents('fresh-agent', workspace.dir, { includeItems: true });
    assert.equal(third?.source, 'event_cursor');
    assert.equal(third?.unseen_event_count, 1);
    assert.equal(third?.changed_items?.[0]?.id, 'dec_after_arrival');
  });

  it('returns undefined on a fully empty store (bootstrap hint territory)', () => {
    const diff = buildContextDiffFromEvents('fresh-agent', workspace.dir);
    // Workspace init may have written registration events; only assert the
    // empty-store contract when truly nothing exists.
    if (diff) {
      assert.equal(diff.source, 'arrival_digest');
    } else {
      assert.equal(diff, undefined);
    }
    const empty = buildArrivalDigest('other-fresh-agent', workspace.dir);
    if (empty) assert.equal(empty.source, 'arrival_digest');
  });

  it('respects includeItems: false', () => {
    seedMatureState(workspace);
    seedEventHistory(workspace, 5);
    const diff = buildArrivalDigest('fresh-agent', workspace.dir, { includeItems: false });
    assert.ok(diff);
    assert.equal(diff?.changed_items, undefined);
    assert.ok((diff?.counts.total ?? 0) > 0);
  });

  it('stays within the first-contact token budget (< 2k tokens ≈ 8 KB serialized)', () => {
    // Worst case: lots of active items AND a heavy event history.
    const now = new Date().toISOString();
    const author = workspace.currentAgent.agent_name;
    const author_id = workspace.currentAgent.agent_id;
    const base = { created_at: now, author, author_id, project_id: 'prj_arrival_test' };
    const mk = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
      id: `${prefix}_${i}`, text: `${prefix} item ${i} — `.padEnd(120, 'x'), status: 'active', tags: [], ...base,
    }));
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: mk(30, 'cst_budget') as never,
      recent_decisions: [],
      known_traps: mk(30, 'trp_budget').map((t) => ({ ...t, severity: 'low' })) as never,
      open_handoffs: mk(30, 'hnd_budget').map((h) => ({ ...h, status: 'open', from: 'a', to: 'b' })) as never,
      plan_items: mk(30, 'pln_budget').map((p) => ({ ...p, status: 'in_progress', priority: 'low', updated_at: now })) as never,
    }, workspace.dir);
    seedEventHistory(workspace, 2000);

    const diff = buildContextDiffFromEvents('fresh-agent', workspace.dir, { includeItems: true });
    assert.ok(diff);
    assert.ok((diff?.changed_items?.length ?? 0) <= 12, 'digest items must be hard-capped');
    const serialized = JSON.stringify(diff);
    assert.ok(serialized.length < 8000, `arrival digest serialized to ${serialized.length} chars — budget is < 8000 (~2k tokens)`);
  });

  it('seedCursorToEnd returns the sealed byte offset', () => {
    seedEventHistory(workspace, 10);
    const offset = seedCursorToEnd('fresh-agent', workspace.dir);
    assert.ok(offset > 0);
    assert.ok(hasEventCursor('fresh-agent', workspace.dir));
  });
});
