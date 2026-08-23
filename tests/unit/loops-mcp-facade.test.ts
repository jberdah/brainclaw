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
  before(async () => {
    cwd = makeWorkspace();
  });
  after(async () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('opens a review loop and returns a FacadeResponse envelope', async () => {
    const r = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
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

  it('open with the same client_request_id returns the same loop without double-creation', async () => {
    const before = await handleBclawLoop({ args: { intent: 'list' }, cwd });
    const beforeTotal = (before.response.result as { total: number }).total;

    const first = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'idem-open',
        agentId: 'agt_a',
        client_request_id: 'req_open_same',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const second = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'idem-open',
        agentId: 'agt_a',
        client_request_id: 'req_open_same',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const after = await handleBclawLoop({ args: { intent: 'list' }, cwd });
    const afterTotal = (after.response.result as { total: number }).total;

    assert.equal(first.response.status, 'ok');
    assert.equal(second.response.status, 'ok');
    assert.equal(payload(first.response.result).loop.id, payload(second.response.result).loop.id);
    assert.deepEqual(stableJson(second.response.result), stableJson(first.response.result));
    assert.equal(afterTotal, beforeTotal + 1);
  });

  it('open rejects reuse of the same client_request_id with a different payload', async () => {
    await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'idem-mismatch-a',
        agentId: 'agt_a',
        client_request_id: 'req_open_diff',
      },
      cwd,
    });

    const r = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
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

  it('rejects an invalid payload with a structured validation_error', async () => {
    const r = await handleBclawLoop({ args: { intent: 'open' }, cwd });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.open');
    assert.match(r.response.error ?? '', /validation_error/);
  });

  it('rejects direct open without allow_orphan — anti-pattern gate (pln#461)', async () => {
    const r = await handleBclawLoop({
      args: {
        intent: 'open',
        kind: 'review',
        title: 'orphan-attempt',
        agentId: 'agt_hostile',
        slots: [{ role: 'reviewer', agent_id: 'agt_rev' }],
      },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.open');
    assert.match(r.response.error ?? '', /validation_error/);
    assert.match(r.response.error ?? '', /allow_orphan|bclaw_coordinate/);
    // The side effect must not include loop creation
    assert.equal(
      r.response.side_effects.some((s) => s.action === 'create' && s.entity === 'loop'),
      false,
      'no loop should be created when the gate rejects the call',
    );
  });

  it('get returns the loop with computed next_expected', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'to-get',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_rev' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const r = await handleBclawLoop({ args: { intent: 'get', loop_id: loopId }, cwd });
    assert.equal(r.response.status, 'ok');
    const p = payload(r.response.result);
    assert.equal(p.loop.id, loopId);
    // One reviewer slot in status=open → next_expected should suggest turn.
    assert.ok(p.next_expected);
    assert.deepEqual((p.next_expected as { action: string }).action, 'turn');
  });

  it('get with include_events returns the event journal', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'with-events', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const r = await handleBclawLoop({
      args: { intent: 'get', loop_id: loopId, include_events: true },
      cwd,
    });
    const p = payload(r.response.result);
    assert.ok(Array.isArray(p.events));
    assert.equal((p.events ?? []).length, 1);
  });

  it('get returns not_found for an unknown loop_id', async () => {
    const r = await handleBclawLoop({
      args: { intent: 'get', loop_id: 'lop_doesnotexist' },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.match(r.response.error ?? '', /not_found/);
  });

  it('list filters by kind and paginates', async () => {
    await handleBclawLoop({ args: { intent: 'open', allow_orphan: true, kind: 'ideation', title: 'i1', agentId: 'agt_a' }, cwd });
    await handleBclawLoop({ args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'r1', agentId: 'agt_a' }, cwd });

    const all = await handleBclawLoop({ args: { intent: 'list' }, cwd });
    const allResult = all.response.result as { loops: LoopThread[]; total: number };
    assert.ok(allResult.total >= 3);

    const ideation = await handleBclawLoop({ args: { intent: 'list', kind: 'ideation' }, cwd });
    const ideationResult = ideation.response.result as { loops: LoopThread[] };
    for (const l of ideationResult.loops) assert.equal(l.kind, 'ideation');

    const paged = await handleBclawLoop({ args: { intent: 'list', limit: 1, offset: 0 }, cwd });
    const pagedResult = paged.response.result as { loops: LoopThread[]; total: number };
    assert.equal(pagedResult.loops.length, 1);
  });
});

describe('bclaw_loop facade — turn / complete_turn / advance', () => {
  let cwd: string;
  before(async () => {
    cwd = makeWorkspace();
  });
  after(async () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('turn flips the reviewer slot to assigned and records a loop_event', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'turn-loop',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_rev' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const reviewerSlotId = payload(opened.response.result).loop.slots[0].slot_id;

    const r = await handleBclawLoop({
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

  it('turn without slot_id or role fails as validation_error with the turn intent preserved', async () => {
    const r = await handleBclawLoop({
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

  it('complete_turn enforces slot-bound auth via caller_agent_id', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
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
    await handleBclawLoop({
      args: { intent: 'turn', loop_id: loopId, slot_id: reviewerSlotId, agentId: 'agt_author' },
      cwd,
    });

    const impersonator = await handleBclawLoop({
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
    const ok = await handleBclawLoop({
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

  it('advance reports auto_closed=true when reviewer_green stop fires', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'auto-close',
        agentId: 'agt_a',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const reviewerSlotId = payload(opened.response.result).loop.slots[0].slot_id;

    await handleBclawLoop({
      args: {
        intent: 'complete_turn',
        loop_id: loopId,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: { phase: 'verdict', type: 'verdict', body: 'accepted' },
        agentId: 'agt_reviewer',
      },
      cwd,
    });

    const r = await handleBclawLoop({
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

  it('advance succeeds when expected_version matches', async () => {
    const opened = await handleBclawLoop({
      // ideation: its first phase (proposal) has no advance_gate, so this
      // exercises the version-CAS mechanic without a phase gate interfering
      // (pln#628 gave research an investigate advance_gate).
      args: { intent: 'open', allow_orphan: true, kind: 'ideation', title: 'advance-cas-pass', agentId: 'agt_a' },
      cwd,
    });
    const openedPayload = payload(opened.response.result);

    const r = await handleBclawLoop({
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

  it('advance returns version_conflict with actual_version when expected_version mismatches', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'ideation', title: 'advance-cas-fail', agentId: 'agt_a' },
      cwd,
    });
    const openedPayload = payload(opened.response.result);

    const r = await handleBclawLoop({
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

  it('complete_turn idempotent retry returns the cached response', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
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

    await handleBclawLoop({
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

    const first = await handleBclawLoop({ args: request, cwd });
    const second = await handleBclawLoop({ args: request, cwd });

    assert.equal(first.response.status, 'ok');
    assert.equal(second.response.status, 'ok');
    assert.deepEqual(stableJson(second.response.result), stableJson(first.response.result));
    assert.deepEqual(stableJson(second.response.artifacts), stableJson(first.response.artifacts));
    assert.deepEqual(stableJson(second.response.side_effects), stableJson(first.response.side_effects));
  });

  it('complete_turn cached response is NOT returned to a different caller (slot-bound auth)', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'owner-match',
        agentId: 'agt_author',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const openedPayload = payload(opened.response.result);
    const loopId = openedPayload.loop.id;
    const reviewerSlotId = openedPayload.loop.slots[0].slot_id;
    await handleBclawLoop({
      args: { intent: 'turn', loop_id: loopId, slot_id: reviewerSlotId, agentId: 'agt_author' },
      cwd,
    });

    const payloadBody = {
      intent: 'complete_turn' as const,
      loop_id: loopId,
      slot_id: reviewerSlotId,
      outcome: 'done' as const,
      artifact: { phase: 'findings', type: 'finding', body: 'LGTM' },
      client_request_id: 'req_owner_match',
    };

    const legitimate = await handleBclawLoop({
      args: { ...payloadBody, agentId: 'agt_reviewer' },
      cwd,
    });
    assert.equal(legitimate.response.status, 'ok');

    // Impersonator reuses the same client_request_id + identical payload body.
    // Without caller-match enforcement they'd get back the cached success
    // response. With requireCallerMatch=true the facade must reject.
    const impersonator = await handleBclawLoop({
      args: { ...payloadBody, agentId: 'agt_impersonator' },
      cwd,
    });
    assert.equal(impersonator.response.status, 'error');
    assert.match(impersonator.response.error ?? '', /^idempotency_owner_mismatch/);
  });

  it('turn with client_request_id is idempotent across retries', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'turn-idem',
        agentId: 'agt_author',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const p = payload(opened.response.result);
    const reviewerSlotId = p.loop.slots[0].slot_id;

    const req = {
      intent: 'turn' as const,
      loop_id: p.loop.id,
      slot_id: reviewerSlotId,
      assignment_id: 'asgn_once',
      agentId: 'agt_author',
      client_request_id: 'req_turn_1',
    };
    const first = await handleBclawLoop({ args: req, cwd });
    const second = await handleBclawLoop({ args: req, cwd });
    assert.equal(first.response.status, 'ok');
    assert.equal(second.response.status, 'ok');
    assert.deepEqual(stableJson(first.response.result), stableJson(second.response.result));
  });

  it('close supports expected_version CAS', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'close-cas', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const v = payload(opened.response.result).loop.version;

    const stale = await handleBclawLoop({
      args: { intent: 'close', loop_id: loopId, status: 'completed', expected_version: v + 99, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(stale.response.status, 'error');
    assert.match(stale.response.error ?? '', /^version_conflict/);

    const ok = await handleBclawLoop({
      args: { intent: 'close', loop_id: loopId, status: 'completed', expected_version: v, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(ok.response.status, 'ok');
    assert.equal(payload(ok.response.result).loop.status, 'completed');
  });

  it('failed mutation does NOT poison the idempotency cache; retry after fixing succeeds', async () => {
    const opened = await handleBclawLoop({
      args: {
        intent: 'open', allow_orphan: true,
        kind: 'review',
        title: 'no-poison',
        agentId: 'agt_author',
        slots: [{ role: 'reviewer', agent_id: 'agt_reviewer' }],
      },
      cwd,
    });
    const openedPayload = payload(opened.response.result);
    const reviewerSlotId = openedPayload.loop.slots[0].slot_id;
    await handleBclawLoop({
      args: { intent: 'turn', loop_id: openedPayload.loop.id, slot_id: reviewerSlotId, agentId: 'agt_author' },
      cwd,
    });

    // First call: impersonator tries complete_turn. Rejected by slot-bound
    // auth inside the verb → error, NOT cached (cache writes only on success).
    const rejected = await handleBclawLoop({
      args: {
        intent: 'complete_turn',
        loop_id: openedPayload.loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        agentId: 'agt_impersonator',
        client_request_id: 'req_first_fails',
      },
      cwd,
    });
    assert.equal(rejected.response.status, 'error');

    // Second call with the SAME client_request_id but the right caller must
    // succeed — the cache is empty because the first call errored before
    // withLoopLock persisted anything.
    const ok = await handleBclawLoop({
      args: {
        intent: 'complete_turn',
        loop_id: openedPayload.loop.id,
        slot_id: reviewerSlotId,
        outcome: 'done',
        artifact: { phase: 'findings', type: 'finding', body: 'retry ok' },
        agentId: 'agt_reviewer',
        client_request_id: 'req_first_fails',
      },
      cwd,
    });
    assert.equal(ok.response.status, 'ok');
    assert.equal(payload(ok.response.result).loop.artifacts.length, 1);
  });

  it('add_artifact supports CAS via expected_version', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'artifact-cas', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;
    const v = payload(opened.response.result).loop.version;

    const stale = await handleBclawLoop({
      args: {
        intent: 'add_artifact',
        loop_id: loopId,
        artifact: { phase: 'investigate', type: 'note', body: 'first' },
        expected_version: v + 50,
        agentId: 'agt_a',
      },
      cwd,
    });
    assert.equal(stale.response.status, 'error');
    assert.match(stale.response.error ?? '', /^version_conflict/);

    const ok = await handleBclawLoop({
      args: {
        intent: 'add_artifact',
        loop_id: loopId,
        artifact: { phase: 'investigate', type: 'note', body: 'first' },
        expected_version: v,
        agentId: 'agt_a',
      },
      cwd,
    });
    assert.equal(ok.response.status, 'ok');
  });
});

describe('bclaw_loop facade — lock_timeout', () => {
  let cwd: string;
  before(async () => {
    cwd = makeWorkspace();
  });
  after(async () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns lock_timeout when a concurrent lock is already held past the backoff window', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'lock-timeout', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    // Simulate another live writer holding the per-loop lock by dropping a
    // valid lock blob at the expected path with a lease well into the future
    // and a live pid (this process's own).
    const lockPath = path.join(cwd, '.brainclaw', 'loops', 'locks', `${loopId}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = new Date();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host_id: os.hostname(),
        agent_id: 'agt_phantom',
        acquired_at: now.toISOString(),
        lease_until: new Date(now.getTime() + 60_000).toISOString(),
        hard_deadline: new Date(now.getTime() + 300_000).toISOString(),
        mutation_id: 'mut_phantom',
      }),
    );

    const r = await handleBclawLoop({
      args: { intent: 'advance', loop_id: loopId, agentId: 'agt_b' },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.match(r.response.error ?? '', /^lock_timeout/);

    fs.unlinkSync(lockPath);
  });
});

describe('bclaw_loop facade — pause / resume / close', () => {
  let cwd: string;
  before(async () => {
    cwd = makeWorkspace();
  });
  after(async () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('pause then resume round-trips the status', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'p', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const paused = await handleBclawLoop({
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

    const resumed = await handleBclawLoop({
      args: { intent: 'resume', loop_id: loopId, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(payload(resumed.response.result).loop.status, 'open');
    assert.equal(resumed.response.artifacts.filter((a) => a.type === 'loop_event').length, 1);
  });

  it('close transitions to the requested final_status', async () => {
    const opened = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'research', title: 'c', agentId: 'agt_a' },
      cwd,
    });
    const loopId = payload(opened.response.result).loop.id;

    const closed = await handleBclawLoop({
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
    const err = await handleBclawLoop({
      args: { intent: 'advance', loop_id: loopId, agentId: 'agt_a' },
      cwd,
    });
    assert.equal(err.response.status, 'error');
  });
});

describe('bclaw_loop facade — envelope contract', () => {
  let cwd: string;
  before(async () => {
    cwd = makeWorkspace();
  });
  after(async () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('every successful response carries status=ok, intent, artifacts, side_effects, warnings', async () => {
    const r = await handleBclawLoop({
      args: { intent: 'open', allow_orphan: true, kind: 'ideation', title: 'env', agentId: 'agt_a' },
      cwd,
    });
    assert.equal(r.response.status, 'ok');
    assert.match(r.response.intent, /^bclaw_loop\./);
    assert.ok(Array.isArray(r.response.artifacts));
    assert.ok(Array.isArray(r.response.side_effects));
    assert.ok(Array.isArray(r.response.warnings));
    assert.equal(typeof r.response.duration_ms, 'number');
  });

  it('error responses still return a FacadeResponse with intent + error string', async () => {
    const r = await handleBclawLoop({
      args: { intent: 'get', loop_id: 'lop_missing' },
      cwd,
    });
    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.get');
    assert.equal(r.response.result, null);
    assert.ok(r.response.error);
  });
});
