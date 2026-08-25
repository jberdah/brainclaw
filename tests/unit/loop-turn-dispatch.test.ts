import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAgentRun } from '../../src/core/agentruns.js';
import { fingerprintPublicKeyPem, saveAgentIdentity } from '../../src/core/agent-registry.js';
import { convergeAssignmentToTerminal, loadAssignment } from '../../src/core/assignments.js';
import { loadClaim, releaseClaim } from '../../src/core/claims.js';
import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import { dispatchLoopTurn, type DispatchLoopTurnResult } from '../../src/core/loop-turn-dispatch.js';
import {
  derivePhaseQualifiedTurnId,
  deriveTurnId,
  getReservation,
  listReservations,
} from '../../src/core/loops/attempt-reservation.js';
import { takeoverLoopAttempt } from '../../src/core/loops/attempt-takeover.js';
import {
  activateAttemptAuthorityV2,
  ensureLocalAuthorityHome,
  prepareAttemptAuthorityRollout,
  publishAttemptRolloutAck,
} from '../../src/core/loops/attempt-rollout.js';
import { getLoop, openLoop } from '../../src/core/loops/store.js';
import type { LoopKind } from '../../src/core/loops/types.js';
import { advance, complete_turn } from '../../src/core/loops/verbs.js';

function project(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loop-driver-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n');
  for (const args of [
    ['init'], ['config', 'user.email', 'fixture@brainclaw.dev'],
    ['config', 'user.name', 'Brainclaw Fixture'], ['add', 'README.md'],
    ['commit', '-m', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  return cwd;
}

function activateV2(cwd: string): void {
  const home = ensureLocalAuthorityHome(cwd);
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  prepareAttemptAuthorityRollout(cwd, {
    membership_epoch: 1,
    authority_home: home,
    participants: [{
      writer_id: 'agt_coord',
      public_key_pem: publicKeyPem,
      key_fingerprint: fingerprintPublicKeyPem(publicKeyPem),
      status: 'active',
    }],
    prepared_by: 'agt_coord',
  });
  publishAttemptRolloutAck(cwd, {
    membership_epoch: 1,
    writer_id: 'agt_coord',
    writer_version: 2,
    private_key_pem: privateKeyPem,
  });
  activateAttemptAuthorityV2(cwd, 1, 'agt_coord');
}

const workerPhase: Record<'ideation' | 'implementation' | 'research' | 'debug', string> = {
  ideation: 'revision',
  implementation: 'execute',
  research: 'investigate',
  debug: 'reproduce',
};

describe('generic Loop Engine worker dispatch', () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env.BRAINCLAW_NO_SPAWN;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps post-cross transport fallback visible and retry-safe in the facade response', async () => {
    const cwd = project();
    roots.push(cwd);
    process.env.BRAINCLAW_NO_SPAWN = '1';
    const loop = openLoop({
      kind: 'debug', title: 'transport fallback', created_by: 'agt_coord',
      phases: [{ name: 'reproduce' }],
      slots: [{ slot_id: 'lsl_debugfallback', role: 'debugger', agent: 'codex' }],
      stop_condition: { kind: 'max_iterations', n: 1 },
    }, cwd);

    const handled = await handleBclawLoop({
      cwd,
      defaultActor: 'coord',
      args: {
        intent: 'turn', loop_id: loop.id, slot_id: 'lsl_debugfallback',
        input: 'reproduce deterministically', dispatch: true, auto_execute: true,
        agent: 'coord', agentId: 'agt_coord',
      },
    });
    assert.equal(handled.response.status, 'ok', 'a crossed grant must not be disguised as a mutation-free denial');
    assert.match(handled.response.warnings[0] ?? '', /BRAINCLAW_NO_SPAWN/);
    const dispatch = (handled.response.result as { dispatch: DispatchLoopTurnResult }).dispatch;
    assert.ok(dispatch.turn_id);
    assert.equal(dispatch.execution_status, 'command_ready_manual');
    assert.ok(handled.response.side_effects.some((effect) => effect.entity === 'assignment' && effect.id === dispatch.assignment_id));
    assert.ok(handled.response.side_effects.some((effect) => effect.entity === 'agent_run' && effect.id === dispatch.run_id));
  });

  for (const kind of Object.keys(workerPhase) as Array<keyof typeof workerPhase>) {
    it(`drives a real ${kind} production turn through AttemptAuthority`, async () => {
      const cwd = project();
      roots.push(cwd);
      const phase = workerPhase[kind];
      const slotId = `lsl_${kind}`;
      const loop = openLoop({
        kind: kind as LoopKind,
        title: `${kind} production driver`,
        created_by: 'agt_coord',
        phases: [{ name: phase }],
        slots: [{ slot_id: slotId, role: 'worker', agent: 'codex' }],
        stop_condition: { kind: 'max_iterations', n: 2 },
      }, cwd);

      const dispatched = await dispatchLoopTurn({
        loop_id: loop.id,
        slot_id: slotId,
        task: `perform ${kind}.${phase}`,
        dispatcher_agent: 'coord',
        dispatcher_agent_id: 'agt_coord',
        auto_execute: false,
        cwd,
      });
      assert.equal(dispatched.error, undefined);
      assert.equal(dispatched.execution_status, 'command_ready_manual');
      assert.ok(dispatched.turn_id);
      assert.ok(dispatched.assignment_id);
      assert.ok(dispatched.run_id);
      assert.ok(dispatched.claim_id);
      assert.ok(dispatched.message_id);

      const reservation = getReservation(dispatched.turn_id!, cwd)!;
      assert.equal(reservation.phase, phase);
      assert.equal(reservation.launch?.status, 'crossed');
      assert.ok(reservation.execution_contract_ref);
      assert.equal(loadAssignment(dispatched.assignment_id!, cwd)?.claim_id, dispatched.claim_id);
      assert.equal(loadAgentRun(dispatched.run_id!, cwd)?.assignment_id, dispatched.assignment_id);
      const slot = getLoop(loop.id, cwd)!.slots.find((candidate) => candidate.slot_id === slotId)!;
      assert.equal(slot.current_turn_id, dispatched.turn_id);
      assert.equal(slot.assignment_id, dispatched.assignment_id);

      const replay = await dispatchLoopTurn({
        loop_id: loop.id,
        slot_id: slotId,
        task: `perform ${kind}.${phase}`,
        dispatcher_agent: 'coord',
        dispatcher_agent_id: 'agt_coord',
        auto_execute: false,
        cwd,
      });
      assert.equal(replay.execution_status, 'inbox_only');
      assert.match(replay.error ?? '', /already crossed|launch (?:already )?crossed|launch grant is crossed|generation zero/);
      assert.equal(replay.assignment_id, undefined, 'a replay never receives fresh spawn authority');
    });
  }

  it('dispatches a fresh phase-qualified turn when one slot enters a later worker phase without an iteration bump', async () => {
    const cwd = project();
    roots.push(cwd);
    const slotId = 'lsl_reviewfollowup';
    const loop = openLoop({
      kind: 'review', title: 'same reviewer across phases', created_by: 'agt_coord',
      phases: [{ name: 'findings' }, { name: 'followup_review' }],
      slots: [{ slot_id: slotId, role: 'reviewer', agent: 'codex' }],
      stop_condition: { kind: 'max_iterations', n: 3 },
    }, cwd);
    const dispatch = (task: string) => handleBclawLoop({
      cwd,
      defaultActor: 'coord',
      args: {
        intent: 'turn', loop_id: loop.id, slot_id: slotId,
        input: task, dispatch: true, auto_execute: false,
        agent: 'coord', agentId: 'agt_coord',
      },
    });

    const firstHandled = await dispatch('review initial findings');
    assert.equal(firstHandled.response.status, 'ok');
    const first = (firstHandled.response.result as { dispatch: DispatchLoopTurnResult }).dispatch;
    assert.equal(first.error, undefined);
    assert.equal(first.turn_id, deriveTurnId(loop.id, slotId, 0), 'an unoccupied cell keeps the legacy three-tuple identity');
    assert.ok(first.assignment_id && first.run_id && first.claim_id && first.worktree_path);

    assert.equal(
      convergeAssignmentToTerminal(first.assignment_id!, 'completed', 'initial reviewer turn settled', cwd),
      true,
    );
    complete_turn({
      id: loop.id,
      slot_id: slotId,
      outcome: 'done',
      artifact: { phase: 'findings', type: 'verdict', body: 'request_changes' },
      actor: 'coord',
    }, cwd);
    const advanced = advance({
      id: loop.id,
      to_phase: 'followup_review',
      force: true,
      actor: 'coord',
    }, cwd);
    assert.equal(advanced.loop.iteration_count, 0, 'forward phase progress does not manufacture a new protocol iteration');
    assert.equal(advanced.loop.slots.find((slot) => slot.slot_id === slotId)?.status, 'done');

    const secondHandled = await dispatch('re-review the applied fixes');
    assert.equal(secondHandled.response.status, 'ok', JSON.stringify(secondHandled.response));
    const second = (secondHandled.response.result as { dispatch: DispatchLoopTurnResult }).dispatch;
    assert.equal(second.error, undefined);
    assert.equal(
      second.turn_id,
      derivePhaseQualifiedTurnId(loop.id, slotId, 'followup_review', 0),
      'the occupied legacy cell forces the deterministic phase-qualified identity',
    );
    assert.notEqual(second.turn_id, first.turn_id);
    assert.notEqual(second.assignment_id, first.assignment_id);
    assert.notEqual(second.run_id, first.run_id);
    assert.equal(second.claim_id, first.claim_id, 'the coordinator claim remains stable across review phases');
    assert.equal(second.worktree_path, first.worktree_path, 'the stable claim retains its worktree across logical turns');
    assert.equal(loadClaim(first.claim_id!, cwd).assignment_id, second.assignment_id, 'the claim pointer advances to the new terminal-successor assignment');
    assert.equal(getReservation(first.turn_id!, cwd)?.phase, 'findings');
    assert.equal(getReservation(second.turn_id!, cwd)?.phase, 'followup_review');
    const reboundSlot = getLoop(loop.id, cwd)!.slots.find((slot) => slot.slot_id === slotId)!;
    assert.equal(reboundSlot.current_turn_id, second.turn_id);
    assert.equal(reboundSlot.assignment_id, second.assignment_id);
    assert.ok(secondHandled.response.side_effects.some((effect) => effect.entity === 'assignment' && effect.id === second.assignment_id));
    assert.ok(secondHandled.response.side_effects.some((effect) => effect.entity === 'agent_run' && effect.id === second.run_id));

    const reservationsBeforeReplay = listReservations({}, cwd).length;
    const replay = await dispatch('retry the same follow-up phase');
    assert.equal(replay.response.status, 'error', 'same-phase replay is fenced instead of spawning again');
    assert.equal(replay.response.side_effects.length, 0);
    assert.equal(listReservations({}, cwd).length, reservationsBeforeReplay);
  });

  it('rebinds a terminal slot to a fresh claim on a later iteration', async () => {
    const cwd = project();
    roots.push(cwd);
    const slotId = 'lsl_iterativecritic';
    const loop = openLoop({
      kind: 'ideation', title: 'iterative critic', created_by: 'agt_coord',
      phases: [{ name: 'critique' }, { name: 'revision' }],
      slots: [{ slot_id: slotId, role: 'critic', agent: 'codex' }],
      stop_condition: { kind: 'max_iterations', n: 3 },
    }, cwd);
    const dispatch = (task: string) => handleBclawLoop({
      cwd,
      defaultActor: 'coord',
      args: {
        intent: 'turn', loop_id: loop.id, slot_id: slotId,
        input: task, dispatch: true, auto_execute: false,
        agent: 'coord', agentId: 'agt_coord',
      },
    });

    const firstHandled = await dispatch('critique iteration zero');
    assert.equal(firstHandled.response.status, 'ok');
    const first = (firstHandled.response.result as { dispatch: DispatchLoopTurnResult }).dispatch;
    assert.ok(first.assignment_id && first.claim_id && first.turn_id);
    assert.equal(convergeAssignmentToTerminal(first.assignment_id, 'completed', 'first critique settled', cwd), true);
    complete_turn({
      id: loop.id,
      slot_id: slotId,
      outcome: 'done',
      artifact: { phase: 'critique', type: 'critique', body: 'iteration zero critique' },
      actor: 'coord',
    }, cwd);
    assert.equal(releaseClaim(first.claim_id, cwd, { agent: 'codex' }).status, 'released');
    advance({ id: loop.id, to_phase: 'revision', force: true, actor: 'coord' }, cwd);
    const cycled = advance({ id: loop.id, to_phase: 'critique', force: true, actor: 'coord' }, cwd);
    assert.equal(cycled.loop.iteration_count, 1);
    assert.equal(cycled.loop.slots.find((slot) => slot.slot_id === slotId)?.status, 'done');

    const secondHandled = await dispatch('critique iteration one');
    assert.equal(secondHandled.response.status, 'ok', JSON.stringify(secondHandled.response));
    const second = (secondHandled.response.result as { dispatch: DispatchLoopTurnResult }).dispatch;
    assert.equal(second.error, undefined);
    assert.ok(second.claim_id && second.assignment_id && second.turn_id);
    assert.notEqual(second.claim_id, first.claim_id);
    assert.notEqual(second.assignment_id, first.assignment_id);
    assert.notEqual(second.turn_id, first.turn_id);
    assert.equal(second.turn_id, deriveTurnId(loop.id, slotId, 1));
    const reboundSlot = getLoop(loop.id, cwd)!.slots.find((slot) => slot.slot_id === slotId)!;
    assert.equal(reboundSlot.claim_id, second.claim_id);
    assert.equal(reboundSlot.assignment_id, second.assignment_id);
    assert.equal(reboundSlot.current_turn_id, second.turn_id);
  });

  it('selects a compatible worker deterministically for an unbound slot', async () => {
    const cwd = project();
    roots.push(cwd);
    for (const [agent_id, agent_name] of [['agt_codex', 'codex'], ['agt_claude', 'claude-code']] as const) {
      saveAgentIdentity({
        version: 1, agent_id, agent_name, kind: 'agent', trust_level: 'trusted',
        capabilities: [], created_at: '2026-08-23T00:00:00.000Z',
      }, cwd);
    }
    const loop = openLoop({
      kind: 'research', title: 'candidate selection', created_by: 'agt_coord',
      phases: [{ name: 'investigate' }],
      slots: [{ slot_id: 'lsl_unbound', role: 'researcher' }],
      stop_condition: { kind: 'max_iterations', n: 1 },
    }, cwd);
    const dispatched = await dispatchLoopTurn({
      loop_id: loop.id,
      slot_id: 'lsl_unbound',
      task: 'investigate',
      dispatcher_agent: 'coord',
      dispatcher_agent_id: 'agt_coord',
      candidate_agents: ['codex', 'claude-code'],
      auto_execute: false,
      cwd,
    });
    assert.equal(dispatched.error, undefined);
    assert.equal(dispatched.agent, 'claude-code');
    assert.equal(loadAgentRun(dispatched.run_id!, cwd)?.agent, 'claude-code');
  });

  it('rebinds the stable claim to the successor generation on takeover redispatch', async () => {
    const cwd = project();
    roots.push(cwd);
    const priorIdentityRoot = process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
    process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = path.join(cwd, '.test-local-identities');
    try {
      activateV2(cwd);
      const loop = openLoop({
        kind: 'debug', title: 'takeover redispatch', created_by: 'agt_coord',
        phases: [{ name: 'reproduce' }],
        slots: [{ slot_id: 'lsl_takeover', role: 'debugger', agent: 'codex' }],
        stop_condition: { kind: 'max_iterations', n: 2 },
      }, cwd);
      const dispatchInput = {
        loop_id: loop.id,
        slot_id: 'lsl_takeover',
        task: 'reproduce after takeover',
        dispatcher_agent: 'coord',
        dispatcher_agent_id: 'agt_coord',
        auto_execute: false,
        cwd,
      } as const;
      const first = await dispatchLoopTurn(dispatchInput);
      assert.equal(first.error, undefined);
      assert.ok(first.turn_id && first.claim_id && first.assignment_id && first.worktree_path);
      assert.equal(loadClaim(first.claim_id!, cwd).worktree_path, first.worktree_path);

      const successor = `${cwd}-successor`;
      roots.push(successor);
      const added = spawnSync('git', ['worktree', 'add', '-b', `takeover-${path.basename(cwd)}`, successor], {
        cwd, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(added.status, 0, added.stderr);
      takeoverLoopAttempt({
        loop_id: loop.id,
        slot_id: 'lsl_takeover',
        turn_id: first.turn_id!,
        expected_epoch: 0,
        authority_home: ensureLocalAuthorityHome(cwd),
        actor: 'agt_coord',
        writer_id: 'agt_coord',
        cause: 'first worker is no longer live',
        liveness_evidence: 'wrapper and heartbeat are absent',
        external_effect_policy: 'idempotent',
        next_workspace_path: successor,
        cwd,
      });

      const second = await dispatchLoopTurn(dispatchInput);
      assert.equal(second.error, undefined);
      assert.equal(second.claim_id, first.claim_id, 'logical claim remains stable');
      assert.notEqual(second.assignment_id, first.assignment_id, 'assignments remain generation-scoped');
      assert.equal(loadAssignment(first.assignment_id!, cwd)?.status, 'cancelled', 'the fenced generation is terminal before rebinding');
      assert.equal(second.worktree_path, successor, 'worker launches in the successor generation workspace');
      const rebound = loadClaim(first.claim_id!, cwd);
      assert.equal(rebound.worktree_path, successor, 'claim liveness and GC follow the active physical generation');
      assert.equal(rebound.assignment_id, second.assignment_id);
    } finally {
      if (priorIdentityRoot === undefined) delete process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT;
      else process.env.BRAINCLAW_AUTHORITY_IDENTITY_ROOT = priorIdentityRoot;
    }
  });

  it('grants exactly one authority when two dispatches race for the same slot', async () => {
    const cwd = project();
    roots.push(cwd);
    const loop = openLoop({
      kind: 'implementation', title: 'same-slot race', created_by: 'agt_coord',
      phases: [{ name: 'execute' }],
      slots: [{ slot_id: 'lsl_raced', role: 'implementer', agent: 'codex' }],
      stop_condition: { kind: 'max_iterations', n: 1 },
    }, cwd);
    const input = {
      loop_id: loop.id,
      slot_id: 'lsl_raced',
      task: 'implement once',
      dispatcher_agent: 'coord',
      dispatcher_agent_id: 'agt_coord',
      auto_execute: false,
      cwd,
    } as const;

    const results = await Promise.all([dispatchLoopTurn(input), dispatchLoopTurn(input)]);
    const winners = results.filter((item) => item.turn_id && item.assignment_id && !item.error);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(listReservations({}, cwd).filter((item) => item.loop_id === loop.id).length, 1);
    assert.equal(getLoop(loop.id, cwd)?.slots[0].current_turn_id, winners[0].turn_id);
  });

  it('allows independent slots to obtain distinct authorities', async () => {
    const cwd = project();
    roots.push(cwd);
    const loop = openLoop({
      kind: 'research', title: 'independent-slot dispatch', created_by: 'agt_coord',
      phases: [{ name: 'investigate' }],
      slots: [
        { slot_id: 'lsl_lanea', role: 'researcher', agent: 'codex' },
        { slot_id: 'lsl_laneb', role: 'researcher', agent: 'claude-code' },
      ],
      stop_condition: { kind: 'max_iterations', n: 1 },
    }, cwd);
    const dispatch = (slot_id: string) => dispatchLoopTurn({
      loop_id: loop.id,
      slot_id,
      task: `investigate ${slot_id}`,
      dispatcher_agent: 'coord',
      dispatcher_agent_id: 'agt_coord',
      auto_execute: false,
      cwd,
    });

    const [a, b] = await Promise.all([dispatch('lsl_lanea'), dispatch('lsl_laneb')]);
    assert.equal(a.error, undefined);
    assert.equal(b.error, undefined);
    assert.ok(a.turn_id);
    assert.ok(b.turn_id);
    assert.notEqual(a.turn_id, b.turn_id);
    assert.equal(listReservations({}, cwd).filter((item) => item.loop_id === loop.id).length, 2);
  });
});
