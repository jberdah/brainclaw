import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { analyzeSequence } from '../../src/core/dispatcher.js';
import { runImplBind } from '../../src/core/loops/impl-bind.js';
import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import { openLoop, getLoop } from '../../src/core/loops/store.js';
import { pause } from '../../src/core/loops/verbs.js';
import { saveSequence, getActiveSequence } from '../../src/core/sequence.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { persistState } from '../../src/core/state.js';
import type { PlanItem, Sequence } from '../../src/core/schema.js';

/**
 * P0C implementation bind — runImplBind validates an implementation loop's linked
 * sequence and advances bind→execute without dispatching. Worker launch belongs to the
 * common turn(dispatch=true) AttemptAuthority path.
 */

function createStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-implbind-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/plans', 'coordination/sequences', 'coordination/claims',
    'coordination/handoffs', 'coordination/inbox', 'coordination/sessions',
    'coordination/loops', 'memory/constraints', 'memory/decisions', 'memory/traps', 'agents',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_implbind\n');
  return dir;
}

function makePlan(overrides: Partial<PlanItem> & { id: string; text: string }): PlanItem {
  return {
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    author: 'test', status: 'todo', priority: 'medium', tags: [], depends_on: [], ...overrides,
  };
}

function makeSequence(id: string, items: Sequence['items'], status: 'draft' | 'active' = 'draft'): Sequence {
  return {
    schema_version: 2, id, name: 'impl-bind-seq', status, items,
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', author: 'test', tags: [],
  };
}

function seedAgents(dir: string): void {
  saveAgentIdentity({
    version: 1, agent_id: 'agt_claude', agent_name: 'claude-code', kind: 'agent',
    trust_level: 'trusted', capabilities: [], created_at: '2026-04-01T00:00:00Z',
  }, dir);
}

/** One ready plan + a DRAFT (non-active) sequence containing it. Returns the sequence id. */
function seedReadySequence(dir: string, seqId = 'seq_ib1', planId = 'pln_ib1'): string {
  persistState({
    version: 1, write_version: 1, active_constraints: [], recent_decisions: [],
    known_traps: [], open_handoffs: [], plan_items: [makePlan({ id: planId, text: 'Ready impl task', status: 'todo' })],
  }, dir);
  saveSequence(makeSequence(seqId, [{ planId, rank: 1, hard_after: [], soft_after: [] }], 'draft'), dir);
  return seqId;
}

function openImplLoop(dir: string, linkedSequenceIds?: string[], planIds = ['pln_ib1']): string {
  const loop = openLoop({
    kind: 'implementation', title: 'impl-bind test', created_by: 'coord',
    slots: [{ role: 'implementer', agent: 'codex' }],
    ...(linkedSequenceIds ? { linked: { sequence_ids: linkedSequenceIds, plan_ids: planIds } } : {}),
  }, dir);
  return loop.id;
}

describe('pln#632 analyzeSequence(sequenceId) — target a specific sequence, no activation', () => {
  let cwd: string;
  beforeEach(() => { cwd = createStore(); seedAgents(cwd); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('resolves a DRAFT sequence by id even though it is not the active one', () => {
    const seqId = seedReadySequence(cwd);
    // No active sequence exists → the historical (no-arg) path returns null.
    assert.equal(getActiveSequence(cwd), undefined, 'the seeded sequence is draft, not active');
    assert.equal(analyzeSequence(cwd), null, 'no-arg analyzeSequence finds no active sequence');
    // …but targeting by id analyzes it anyway (backward-compatible additive param).
    const byId = analyzeSequence(cwd, seqId);
    assert.ok(byId, 'analyzeSequence(cwd, seqId) resolves the draft sequence');
    assert.equal(byId!.ready.length, 1);
    assert.equal(byId!.ready[0]!.plan.id, 'pln_ib1');
  });

  it('an unknown sequenceId yields null (non-throwing, like "no active sequence")', () => {
    seedReadySequence(cwd);
    assert.equal(analyzeSequence(cwd, 'seq_does_not_exist'), null);
  });
});

describe('pln#632 runImplBind', () => {
  let cwd: string;
  beforeEach(() => { cwd = createStore(); seedAgents(cwd); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('dryRun validates the link, does NOT advance, and never dispatches', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    const res = await runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', dryRun: true }, cwd);
    assert.equal(res.action, 'preview');
    assert.equal(res.sequence_id, seqId);
    assert.equal(getLoop(loopId, cwd)!.current_phase, 'bind', 'dryRun does not advance');
    assert.equal(getActiveSequence(cwd), undefined, 'dryRun never activates the linked sequence');
    assert.equal(res.advanced_to, undefined);
    assert.equal(res.dispatch, null);
    assert.equal(res.messages_sent, 0);
    assert.match(res.warnings.join(' '), /engine-only/);
  });

  it('real bind is engine-only: validates + advances bind→execute with zero delivery side effects', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    // Historical launch options remain accepted during rollout, but are inert.
    const res = await runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', autoExecute: false }, cwd);
    assert.equal(res.action, 'bound');
    assert.equal(res.advanced_to, 'execute');
    assert.equal(res.sequence_id, seqId);
    assert.equal(res.dispatch, null, 'bind cannot bypass the common loop-turn driver');
    assert.equal(res.messages_sent, 0, 'bind never delivers an assignment');
    assert.match(res.warnings.join(' '), /launch options are retained but ignored/);
    const loop = getLoop(loopId, cwd)!;
    assert.equal(loop.current_phase, 'execute', 'bind advanced the loop into the execute↔verify cycle');
    assert.equal(loop.slots[0]!.lane, 'default');
    assert.deepEqual(loop.slots[0]!.plan_ids, ['pln_ib1']);
    assert.equal(getActiveSequence(cwd), undefined, 'the linked sequence stays draft — no global active-sequence hijack');
    assert.equal(
      fs.existsSync(path.join(cwd, '.brainclaw', 'coordination', 'assignments')),
      false,
      'engine-only bind creates no assignment store',
    );
    assert.deepEqual(
      fs.readdirSync(path.join(cwd, '.brainclaw', 'coordination', 'inbox')),
      [],
      'engine-only bind sends no worker message',
    );
  });

  it('is idempotent — a second bind on a loop already past bind is a noop', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    await runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', autoExecute: false }, cwd);
    const second = await runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', autoExecute: false }, cwd);
    assert.equal(second.action, 'noop');
    assert.match(second.reason, /already bound|not 'bind'/);
    assert.equal(getLoop(loopId, cwd)!.current_phase, 'execute', 'still in execute, not cycled');
  });

  it('rejects a PAUSED loop without advancing', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    pause({ id: loopId, actor: 'coord', reason: 'operator hold' }, cwd);
    const paused = getLoop(loopId, cwd)!;
    assert.equal(paused.status, 'paused');
    assert.equal(paused.current_phase, 'bind', 'pause keeps the loop in the bind phase (the trap)');
    await assert.rejects(
      () => runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', autoExecute: false }, cwd),
      /requires an open loop/,
    );
    assert.equal(getActiveSequence(cwd), undefined);
    const after = getLoop(loopId, cwd)!;
    assert.equal(after.status, 'paused');
    assert.equal(after.current_phase, 'bind');
  });

  it('rejects an implementation loop with NO linked sequence', async () => {
    const loopId = openImplLoop(cwd); // no linked sequence
    await assert.rejects(
      () => runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', dryRun: true }, cwd),
      /requires a linked sequence/,
    );
  });

  it('rejects a linked sequence id that does not exist', async () => {
    const loopId = openImplLoop(cwd, ['seq_ghost']);
    await assert.rejects(
      () => runImplBind({ loop_id: loopId, dispatcherAgent: 'coord', dryRun: true }, cwd),
      /Sequence not found: seq_ghost/,
    );
  });

  it('binds explicit sequence lanes to slots and rejects a lane/slot mismatch', async () => {
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [], known_traps: [], open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_a', text: 'A' }), makePlan({ id: 'pln_b', text: 'B' })],
    }, cwd);
    saveSequence(makeSequence('seq_lanes', [
      { planId: 'pln_a', rank: 1, lane: 'api', scope_hint: 'src/api', hard_after: [], soft_after: [] },
      { planId: 'pln_b', rank: 2, lane: 'ui', scope_hint: 'src/ui', hard_after: [], soft_after: [] },
    ]), cwd);
    const mismatched = openImplLoop(cwd, ['seq_lanes'], ['pln_a', 'pln_b']);
    await assert.rejects(() => runImplBind({ loop_id: mismatched, dispatcherAgent: 'coord' }, cwd), /lane\/slot mismatch/);

    const matched = openLoop({
      kind: 'implementation', title: 'lanes', created_by: 'coord',
      slots: [{ role: 'implementer', lane: 'api' }, { role: 'implementer', lane: 'ui' }],
      linked: { sequence_ids: ['seq_lanes'], plan_ids: ['pln_a', 'pln_b'] },
    }, cwd);
    await runImplBind({ loop_id: matched.id, dispatcherAgent: 'coord' }, cwd);
    const bound = getLoop(matched.id, cwd)!;
    assert.deepEqual(bound.slots.map((slot) => [slot.lane, slot.scope_hint]), [['api', 'src/api'], ['ui', 'src/ui']]);
  });

  it('rejects positional multi-lane slots instead of silently permuting lane policies', async () => {
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [], known_traps: [], open_handoffs: [],
      plan_items: [makePlan({ id: 'pln_a', text: 'A' }), makePlan({ id: 'pln_b', text: 'B' })],
    }, cwd);
    saveSequence(makeSequence('seq_unordered_lanes', [
      { planId: 'pln_a', rank: 1, lane: 'correctifs', scope_hint: 'schema.prisma', hard_after: [], soft_after: [] },
      { planId: 'pln_b', rank: 2, lane: 'documentaire', scope_hint: 'docs/', hard_after: [], soft_after: [] },
    ]), cwd);
    const loop = openLoop({
      kind: 'implementation', title: 'unsafe positional lanes', created_by: 'coord',
      slots: [
        { role: 'implementer', perspective: 'only lane allowed to touch schema.prisma' },
        { role: 'implementer', perspective: 'documentation only' },
      ],
      linked: { sequence_ids: ['seq_unordered_lanes'], plan_ids: ['pln_a', 'pln_b'] },
    }, cwd);
    await assert.rejects(
      () => runImplBind({ loop_id: loop.id, dispatcherAgent: 'coord', dryRun: true }, cwd),
      /explicit slot\.lane.*positional slot order is rejected/,
    );
  });

  it('rejects a stop condition that names no phase in the opened protocol', () => {
    assert.throws(
      () => openLoop({
        kind: 'implementation', title: 'bad stop phase', created_by: 'coord',
        stop_condition: { kind: 'phase_reached', phase: 'verdict' },
      }, cwd),
      /stop_condition references unknown phase "verdict"/,
    );
  });

  it('rejects the singular linked.sequence typo at the facade instead of dropping it', async () => {
    const handled = await handleBclawLoop({
      args: {
        intent: 'open', kind: 'implementation', title: 'bad link key', allow_orphan: true,
        linked: { sequence: 'seq_ib1', plan_ids: ['pln_ib1'] },
        agent: 'coord',
      },
      cwd,
    });
    assert.equal(handled.response.status, 'error');
    assert.match(handled.response.error ?? '', /Unrecognized key|unrecognized key|sequence/);
  });

  it('rejects a non-implementation loop (review loops dispatch via coordinate)', async () => {
    const seqId = seedReadySequence(cwd);
    const review = openLoop({
      kind: 'review', title: 'r', created_by: 'coord', mode: 'symmetric',
      slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: 'codex', status: 'assigned' }],
      linked: { sequence_ids: [seqId] },
    }, cwd);
    await assert.rejects(
      () => runImplBind({ loop_id: review.id, dispatcherAgent: 'coord', dryRun: true }, cwd),
      /only valid for implementation loops/,
    );
  });

  it('unknown loop id → throws unknown loop_id', async () => {
    await assert.rejects(
      () => runImplBind({ loop_id: 'lop_nope', dispatcherAgent: 'coord', dryRun: true }, cwd),
      /unknown loop_id/,
    );
  });
});

describe('P0C bclaw_loop(intent="bind") facade — engine-only handler wiring', () => {
  let cwd: string;
  beforeEach(() => { cwd = createStore(); seedAgents(cwd); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('advances to execute, reports zero dispatch, and points to turn(dispatch=true)', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    const handled = await handleBclawLoop({
      args: { intent: 'bind', loop_id: loopId, auto_execute: false, agent: 'coord' }, cwd,
    });
    assert.equal(handled.response.status, 'ok');
    const result = handled.response.result as {
      action: string;
      advanced_to: string | null;
      dispatched: number;
      dispatch: unknown;
      loop: { current_phase: string };
    };
    assert.equal(result.action, 'bound');
    assert.equal(result.advanced_to, 'execute');
    assert.equal(result.loop.current_phase, 'execute');
    assert.equal(result.dispatched, 0);
    assert.equal(result.dispatch, null);
    assert.match(handled.response.warnings.join(' '), /turn.*dispatch=true/);
  });

  it('dryRun through the facade previews without advancing', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    const handled = await handleBclawLoop({
      args: { intent: 'bind', loop_id: loopId, dry_run: true, agent: 'coord' }, cwd,
    });
    assert.equal(handled.response.status, 'ok');
    const result = handled.response.result as { action: string; loop: { current_phase: string } };
    assert.equal(result.action, 'preview');
    assert.equal(result.loop.current_phase, 'bind');
  });

  it('surfaces the review-loop handoff when implementation reaches handoff_ready', async () => {
    const seqId = seedReadySequence(cwd);
    const loopId = openImplLoop(cwd, [seqId]);
    await handleBclawLoop({ args: { intent: 'bind', loop_id: loopId, agent: 'coord' }, cwd });
    const handled = await handleBclawLoop({
      args: { intent: 'advance', loop_id: loopId, to_phase: 'handoff_ready', force: true, agent: 'coord' }, cwd,
    });
    assert.equal(handled.response.next_actions?.[0]?.tool, 'bclaw_loop');
    assert.equal(handled.response.next_actions?.[0]?.args?.intent, 'continue');
    assert.equal(handled.response.next_actions?.[0]?.args?.loop_id, loopId);
    assert.equal(handled.response.next_actions?.[0]?.args?.autonomy_mode, 'autonomous');
    assert.equal(handled.response.next_actions?.[0]?.args?.risk, 'normal');
  });

  it('routes synthesis-owned verification through the governed continuation action', async () => {
    const ideation = openLoop({
      kind: 'ideation',
      title: 'pipeline synthesis',
      created_by: 'coord',
      phases: [{ name: 'synthesis' }],
      linked: { plan_ids: ['pln_chain'], sequence_ids: ['seq_chain'] },
    }, cwd);
    const handled = await handleBclawLoop({
      args: {
        intent: 'add_artifact',
        loop_id: ideation.id,
        artifact: {
          phase: 'synthesis',
          type: 'plan_draft',
          body: 'Implement the accepted pipeline design.',
          addresses_critique: ['art_critique1'],
          implementation_verify: { command: ['npm', 'test'], timeout_ms: 120_000 },
        },
        agent: 'coord',
      },
      cwd,
    });
    assert.equal(handled.response.status, 'ok');
    assert.equal(handled.response.next_actions?.[0]?.tool, 'bclaw_loop');
    assert.equal(handled.response.next_actions?.[0]?.args?.intent, 'continue');
    assert.equal(handled.response.next_actions?.[0]?.args?.loop_id, ideation.id);
    assert.equal(handled.response.next_actions?.[0]?.args?.autonomy_mode, 'autonomous');
    assert.equal(handled.response.next_actions?.[0]?.args?.risk, 'normal');
  });

  it('a review loop bound via the facade → validation_error (not implementation)', async () => {
    const seqId = seedReadySequence(cwd);
    const review = openLoop({
      kind: 'review', title: 'r', created_by: 'coord', mode: 'symmetric',
      slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: 'codex', status: 'assigned' }],
      linked: { sequence_ids: [seqId] },
    }, cwd);
    const handled = await handleBclawLoop({ args: { intent: 'bind', loop_id: review.id, agent: 'coord' }, cwd });
    assert.equal(handled.response.status, 'error');
    assert.match(handled.response.error ?? '', /only valid for implementation/);
  });
});
