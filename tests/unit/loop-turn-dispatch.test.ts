import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAgentRun } from '../../src/core/agentruns.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { loadAssignment } from '../../src/core/assignments.js';
import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import { dispatchLoopTurn, type DispatchLoopTurnResult } from '../../src/core/loop-turn-dispatch.js';
import { getReservation, listReservations } from '../../src/core/loops/attempt-reservation.js';
import { getLoop, openLoop } from '../../src/core/loops/store.js';
import type { LoopKind } from '../../src/core/loops/types.js';

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
