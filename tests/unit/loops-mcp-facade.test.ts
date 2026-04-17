import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import type { LoopThread } from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-facade-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

interface LoopPayload {
  loop: LoopThread;
  next_expected?: unknown;
  events?: unknown[];
  auto_closed?: boolean;
}

function payload(result: unknown): LoopPayload {
  return result as LoopPayload;
}

function stableJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('bclaw_loop facade — open / get / list', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('opens a review loop and returns a FacadeResponse envelope', () => {
    const r = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'mcp open',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    assert.equal(r.response.status, 'ok');
    assert.equal(r.response.intent, 'bclaw_loop.open');
    const { loop } = payload(r.response.result);
    assert.match(loop.id, /^lop_/);
    assert.equal(loop.kind, 'review');
    assert.equal(loop.current_phase, 'change_summary');

    const artifactTypes = r.response.artifacts.map((a) => a.type);
    assert.ok(artifactTypes.includes('loop'));
    assert.ok(artifactTypes.includes('loop_event'));
    assert.ok(
      r.response.side_effects.some(
        (s) => s.action === 'create' && s.entity === 'loop' && s.id === loop.id,
      ),
    );
    assert.match(r.summary, /opened lop_/);
  });

  it('open with the same client_request_id returns the same loop without double-creation', () => {
    const before = handleBclawLoop({ args: { intent: 'list' }, cwd });
    const beforeTotal = (before.response.result as { total: number }).total;

    const first = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'idem-open',
        agentId: 'agt_a',
        client_request_id: 'req_open_same',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const second = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'idem-open',
        agentId: 'agt_a',
        client_request_id: 'req_open_same',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const after = handleBclawLoop({ args: { intent: 'list' }, cwd });
    const afterTotal = (after.response.result as { total: number }).total;

    assert.equal(first.response.status, 'ok');
    assert.equal(second.response.status, 'ok');
    assert.equal(payload(first.response.result).loop.id, payload(second.response.result).loop.id);
    assert.deepEqual(stableJson(second.response.result), stableJson(first.response.result));
    assert.equal(afterTotal, beforeTotal + 1);
  });

  it('open rejects reuse of the same client_request_id with a different payload', () => {
    handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'idem-mismatch-a',
        agentId: 'agt_a',
        client_request_id: 'req_open_diff',
      },
      cwd,
    });

    const r = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'idem-mismatch-b',
        agentId: 'agt_a',
        client_request_id: 'req_open_diff',
      },
      cwd,
    });

    assert.equal(r.response.status, 'error');
    assert.match(r.response.error ?? '', /^idempotency_key_reused_with_different_body:/);
    assert.ok((r.response.result as { stored_hash?: string }).stored_hash);
    assert.ok((r.response.result as { submitted_hash?: string }).submitted_hash);
  });

  it('rejects an invalid payload with a structured validation_error', () => {
    const r = handleBclawLoop({ args: { intent: 'open' }, cwd });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.open');
    assert.match(r.response.error ?? '', /validation_error/);
  });

  it('get returns the loop with computed next_expected', () => {
    const opened = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'to-get',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_rev' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const r = handleBclawLoop({ args: { intent: 'get', loop_id: loopId }, cwd });
    assert.equal(r.response.status, 'ok');
    const p = payload(r.response.result);
    assert.equal(p.loop.id, loopId);
    // One reviewer slot in status=open → next_expected should suggest turn.
    assert.ok(p.next_expected);
    assert.deepEqual((p.next_expected as { action: string }).action, 'turn');
  });

  it('get with include_events returns the event journal', () => {
    const opened = handleBclawLoop({
      args: { intent: 'open', kind: 'research', title: 'with-events', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const r = handleBclawLoop({
      args: { intent: 'get', loop_id: loopId, include_events: true },
      cwd,
    });
    const p = payload(r.response.result);
    assert.ok(Array.isArray(p.events));
    assert.equal((p.events ?? []).length, 1);
  });

  it('get returns not_found for an unknown loop_id', () => {
    const r = handleBclawLoop({
      args: { intent: 'get', loop_id: 'lop_doesnotexist' },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.match(r.response.error ?? '', /not_found/);
  });

  it('list filters by kind and paginates', () => {
    handleBclawLoop({ args: { intent: 'open', kind: 'ideation', title: 'i1', agentId: 'agt_a' }, cwd });
    handleBclawLoop({ args: { intent: 'open', kind: 'research', title: 'r1', agentId: 'agt_a' }, cwd });

    const all = handleBclawLoop({ args: { intent: 'list' }, cwd });
    const allResult = all.response.result as { loops: LoopThread[]; total: number };
    assert.ok(allResult.total >= 3);

    const ideation = handleBclawLoop({ args: { intent: 'list', kind: 'ideation' }, cwd });
    const ideationResult = ideation.response.result as { loops: LoopThread[] };
    for (const l of ideationResult.loops) assert.equal(l.kind, 'ideation');

    const paged = handleBclawLoop({ args: { intent: 'list', limit: 1, offset: 0 }, cwd });
    const pagedResult = paged.response.result as { loops: LoopThread[]; total: number };
    assert.equal(pagedResult.loops.length, 1);
  });
});

describe('bclaw_loop facade — turn / complete_turn / advance', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('turn flips the reviewer slot to assigned and records a loop_event', () => {
    const opened = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'turn-loop',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_rev' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const reviewerSlotId = payload(opened.response.result).loop.slots[0].slot_id;

    const r = handleBclawLoop({
      args: {
        intent: 'turn',
        loop_id: loopId,
        slot_id: reviewerSlotId,
        assignment_id: 'asgn_x',
        agentId: 'agt_a',
      },
      cwd,
    });
    assert.equal(r.response.status, 'ok');
    const p = payload(r.response.result);
    const slot = p.loop.slots.find((s) => s.slot_id === reviewerSlotId)!;
    assert.equal(slot.status, 'assigned');
    assert.equal(slot.assignment_id, 'asgn_x');
    assert.equal(r.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);
  });

  it('turn without slot_id or role fails as validation_error with the turn intent preserved', () => {
    const r = handleBclawLoop({
      args: {
        intent: 'turn',
        loop_id: 'lop_abcdef',
        agentId: 'agt_a',
      },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.turn');
    assert.match(r.response.error ?? '', /validation_error/);
  });

  it('complete_turn enforces slot-bound auth via caller_agent_id', () => {
    const opened = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'auth-loop',
        agentId: 'agt_author',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const reviewerSlotId = payload(opened.response.result).loop.slots[0].slot_id;

    // Assign first.
    handleBclawLoop({
      args: { intent: 'turn', loop_id: loopId, slot_id: reviewerSlotId, agentId: 'agt_author' },
      cwd,
    });

    const impersonator = handleBclawLoop({
      args: {
        intent: 'complete_turn',
        loop_id: loopId,
        slot_id: reviewerSlotId,
        outcome: 'done',
        agentId: 'agt_impersonator',
      },
      cwd,
    });
    assert.equal(impersonator.response.status, 'error');
    assert.match(impersonator.response.error ?? '', /unauthorized_slot_write/);

    // Legitimate slot owner.
    const ok = handleBclawLoop({
      args: {
        intent: 'complete_turn',
        loop_id: loopId,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: { phase: 'findings', type: 'finding', body: 'LGTM' },
        agentId: 'agt_reviewer',
      },
      cwd,
    });
    assert.equal(ok.response.status, 'ok');
    const p = payload(ok.response.result);
    assert.equal(p.loop.slots[0].status, 'done');
    assert.equal(p.loop.artifacts.length, 1);
    assert.deepEqual((p.next_expected as { action: string }).action, 'advance');
    assert.equal(ok.response.artifacts.filter((a) => a.type === 'loop_event').length, 2);
    assert.equal(ok.response.side_effects.filter((s) => s.entity === 'loop_event').length, 2);
  });

  it('advance reports auto_closed=true when reviewer_green stop fires', () => {
    const opened = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'auto-close',
        agentId: 'agt_a',
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    handleBclawLoop({
      args: {
        intent: 'add_artifact',
        loop_id: loopId,
        artifact: { phase: 'verdict', type: 'verdict', body: 'accepted' },
        agentId: 'agt_a',
      },
      cwd,
    });

    const r = handleBclawLoop({
      args: { intent: 'advance', loop_id: loopId, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(r.response.status, 'ok');
    const p = payload(r.response.result);
    assert.equal(p.auto_closed, true);
    assert.equal(p.loop.status, 'completed');
    // `advance` detects reviewer_green before the phase transition, so the verb
    // short-circuits and emits only the `closed` event (no intermediate
    // phase_advanced). Auto-close with a post-transition stop_condition would
    // surface 2 events; that path is covered in loops-verbs.test.ts.
    assert.equal(r.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);
    const loopEvents = r.response.artifacts.filter((a) => a.type === 'loop_event');
    assert.ok(loopEvents.length >= 1, 'closed event must be surfaced on auto-close');
  });

  it('advance succeeds when expected_version matches', () => {
    const opened = handleBclawLoop({
      args: { intent: 'open', kind: 'research', title: 'advance-cas-pass', agentId: 'agt_a' },
      cwd,
    });
    const openedPayload = payload(opened.response.result);

    const r = handleBclawLoop({
      args: {
        intent: 'advance',
        loop_id: openedPayload.loop.id,
        agentId: 'agt_a',
        expected_version: openedPayload.loop.version,
      },
      cwd,
    });

    assert.equal(r.response.status, 'ok');
    assert.equal(payload(r.response.result).loop.version, openedPayload.loop.version + 1);
  });

  it('advance returns version_conflict with actual_version when expected_version mismatches', () => {
    const opened = handleBclawLoop({
      args: { intent: 'open', kind: 'research', title: 'advance-cas-fail', agentId: 'agt_a' },
      cwd,
    });
    const openedPayload = payload(opened.response.result);

    const r = handleBclawLoop({
      args: {
        intent: 'advance',
        loop_id: openedPayload.loop.id,
        agentId: 'agt_a',
        expected_version: openedPayload.loop.version + 10,
      },
      cwd,
    });

    assert.equal(r.response.status, 'error');
    assert.match(r.response.error ?? '', /^version_conflict: expected=/);
    assert.equal((r.response.result as { actual_version?: number }).actual_version, openedPayload.loop.version);
  });

  it('complete_turn idempotent retry returns the cached response', () => {
    const opened = handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'complete-idem',
        agentId: 'agt_author',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const openedPayload = payload(opened.response.result);
    const loopId = openedPayload.loop.id;
    const reviewerSlotId = openedPayload.loop.slots[0].slot_id;

    handleBclawLoop({
      args: { intent: 'turn', loop_id: loopId, slot_id: reviewerSlotId, agentId: 'agt_author' },
      cwd,
    });

    const request = {
      intent: 'complete_turn' as const,
      loop_id: loopId,
      slot_id: reviewerSlotId,
      outcome: 'done' as const,
      artifact: { phase: 'findings', type: 'finding', body: 'cached' },
      agentId: 'agt_reviewer',
      client_request_id: 'req_complete_same',
    };

    const first = handleBclawLoop({ args: request, cwd });
    const second = handleBclawLoop({ args: request, cwd });

    assert.equal(first.response.status, 'ok');
    assert.equal(second.response.status, 'ok');
    assert.deepEqual(stableJson(second.response.result), stableJson(first.response.result));
    assert.deepEqual(stableJson(second.response.artifacts), stableJson(first.response.artifacts));
    assert.deepEqual(stableJson(second.response.side_effects), stableJson(first.response.side_effects));
  });
});

describe('bclaw_loop facade — pause / resume / close', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('pause then resume round-trips the status', () => {
    const opened = handleBclawLoop({
      args: { intent: 'open', kind: 'research', title: 'p', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const paused = handleBclawLoop({
      args: {
        intent: 'pause',
        loop_id: loopId,
        reason: 'afk',
        agentId: 'agt_a',
        expected_version: 1,
        client_request_id: 'req_123',
      },
      cwd,
    });
    assert.equal(paused.response.status, 'ok');
    assert.equal(payload(paused.response.result).loop.status, 'paused');
    assert.equal(paused.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);
    assert.deepEqual(paused.response.warnings, []);

    const resumed = handleBclawLoop({
      args: { intent: 'resume', loop_id: loopId, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(payload(resumed.response.result).loop.status, 'open');
    assert.equal(resumed.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);
  });

  it('close transitions to the requested final_status', () => {
    const opened = handleBclawLoop({
      args: { intent: 'open', kind: 'research', title: 'c', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const closed = handleBclawLoop({
      args: {
        intent: 'close',
        loop_id: loopId,
        status: 'cancelled',
        reason: 'scrapped',
        agentId: 'agt_a',
      },
      cwd,
    });
    assert.equal(closed.response.status, 'ok');
    assert.equal(payload(closed.response.result).loop.status, 'cancelled');
    assert.ok(payload(closed.response.result).loop.closed_at);
    assert.equal(closed.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);

    // Any subsequent advance returns a verb_error / not_found-adjacent code.
    const err = handleBclawLoop({
      args: { intent: 'advance', loop_id: loopId, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(err.response.status, 'error');
  });
});

describe('bclaw_loop facade — envelope contract', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('every successful response carries status=ok, intent, artifacts, side_effects, warnings', () => {
    const r = handleBclawLoop({
      args: { intent: 'open', kind: 'ideation', title: 'env', agentId: 'agt_a' },
      cwd,
    });
    assert.equal(r.response.status, 'ok');
    assert.match(r.response.intent, /^bclaw_loop\./);
    assert.ok(Array.isArray(r.response.artifacts));
    assert.ok(Array.isArray(r.response.side_effects));
    assert.ok(Array.isArray(r.response.warnings));
    assert.equal(typeof r.response.duration_ms, 'number');
  });

  it('error responses still return a FacadeResponse with intent + error string', () => {
    const r = handleBclawLoop({
      args: { intent: 'get', loop_id: 'lop_missing' },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.get');
    assert.equal(r.response.result, null);
    assert.ok(r.response.error);
  });
});
