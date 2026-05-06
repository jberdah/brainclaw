/**
 * pln#492 phase 2.e — End-to-end ideation_loop tests (closes stp_f528ae94).
 *
 * Pure-function tests for the iteration engine, gate evaluator, and
 * brief assembler are covered by their dedicated test files. What's
 * exercised here is the integration of the four moving parts that come
 * together only at the bclaw_coordinate(intent='ideate') layer:
 *
 *   1. The real BriefMemoryProvider plugged onto src/core/search.ts —
 *      i.e. seeded memory makes its way into the brief that the critic
 *      slot receives.
 *   2. The 12 KB-token (~48 KB-char) cap on a project with 30+ traps —
 *      the assembler's truncation path actually fires under realistic
 *      memory volume.
 *   3. min_artifacts_by_type at LOOP scope used as a stop_condition
 *      (separate from its phase-scope use as an advance_gate). The
 *      loop auto-closes as 'completed' once the loop-wide critique
 *      count crosses the threshold.
 *
 * Items already covered elsewhere are NOT re-tested here:
 *   - decideNextPhase outcomes (loops-iteration-engine.test.ts)
 *   - phase_advance_blocked / max_iterations_reached events
 *     (loops-advance-iteration.test.ts)
 *   - context_filter wildcard expansion + size cap of the assembler
 *     (loops-brief-assembly.test.ts)
 *   - ideate single-agent / multi-agent dispatch shape
 *     (bclaw-coordinate.test.ts)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import {
  add_artifact,
  advance,
  getLoop,
  openLoop,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { loadState, saveState } from '../../src/core/state.js';
import { readInbox } from '../../src/core/messaging.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';

interface CoordinateResult extends FacadeResponse {
  result: Record<string, unknown>;
}

async function coordinate(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<CoordinateResult> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_coordinate',
    args,
    cwd: workspace.dir,
  });
  assert.equal(
    outcome.response.isError,
    false,
    `bclaw_coordinate error: ${JSON.stringify(outcome.response)}`,
  );
  return outcome.response.structuredContent as unknown as CoordinateResult;
}

function seedTrap(workspace: TestWorkspace, id: string, text: string): void {
  const state = loadState(workspace.dir);
  state.known_traps.push({
    id,
    text,
    created_at: new Date().toISOString(),
    author: 'agt_test',
    severity: 'medium',
    tags: ['test'],
    status: 'active',
    visibility: 'shared',
  });
  saveState(state, workspace.dir);
}

describe('ideate e2e — search-backed memory makes it into the brief (pln#492 stp_f528ae94)', () => {
  let workspace: TestWorkspace;
  let previousNoSpawn: string | undefined;
  let previousTestMode: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_TEST_MODE = '1';
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({ currentAgent: 'claude-code' });
  });

  afterEach(() => {
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    if (previousNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = previousNoSpawn;
  });

  it('the dispatched brief includes seeded trap ids whose text matches the proposal query', async () => {
    // Seed three traps that should all match a "dispatcher refactor" query
    // and one unrelated trap that should NOT match.
    seedTrap(workspace, 'trp_dispatcher_a', 'dispatcher refactor: previous attempt regressed silent failures');
    seedTrap(workspace, 'trp_dispatcher_b', 'dispatcher monolith owns claim + assignment + spawn — splitting risks losing idempotency');
    seedTrap(workspace, 'trp_dispatcher_c', 'dispatcher tests rely on integration spawn — pure unit refactor will rot them');
    seedTrap(workspace, 'trp_unrelated', 'avoid using emojis in commit messages');

    const response = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Should we refactor the dispatcher to extract claim handling into a separate module?',
      targetAgents: ['codex'],
      agent: 'claude-code',
    });

    assert.equal(response.status, 'ok');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.dispatched_critics, 1);
    assert.equal(result.current_phase, 'critique');

    // The brief is delivered to the critic via the inbox. Read it back
    // and verify the seeded trap ids appear.
    const messages = readInbox({ agent: 'codex' }, workspace.dir).messages;
    assert.ok(messages.length > 0, 'codex inbox must contain the dispatched brief');
    const briefBody = messages.map((m) => m.text).join('\n');
    assert.match(briefBody, /trp_dispatcher_a/, 'seeded trap a must appear in the brief');
    assert.match(briefBody, /trp_dispatcher_b/, 'seeded trap b must appear in the brief');
    assert.match(briefBody, /trp_dispatcher_c/, 'seeded trap c must appear in the brief');
    // The unrelated trap may or may not appear depending on BM25 — we don't
    // pin it either way. The point of the assertion is that the dispatcher-
    // matching ones DO appear.
  });

  it('30+ traps trigger the brief truncation warning surfacing through the ideate response', async () => {
    // Seed 35 traps with overlapping vocabulary — guarantees enough matches
    // that the assembler hits the cap even with topKPerCategory defaulting
    // to 8. Each trap body is ~7 KB so 8 × 7 KB ≫ 48 KB and the bundle
    // truncates.
    const longBody = 'dispatcher refactor regression risk: '.repeat(200);
    for (let i = 0; i < 35; i++) {
      seedTrap(workspace, `trp_volume_${i}`, `${longBody} (instance ${i})`);
    }

    const response = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Refactor the dispatcher entirely',
      targetAgents: ['codex'],
      agent: 'claude-code',
    });

    assert.equal(response.status, 'ok');
    const result = response.result as Record<string, unknown>;
    assert.equal(result.dispatched_critics, 1);

    // The assembler reports truncation when over budget; the handler
    // surfaces this as a per-slot warning.
    assert.ok(
      response.warnings.some((w) => /truncated/i.test(w) && /memory items dropped/i.test(w)),
      `expected truncation warning, got: ${response.warnings.join(' | ')}`,
    );

    // The dispatched brief itself should also stay within a sane envelope —
    // after truncation, the brief text length should be within the cap +
    // a small overhead for the truncation tail.
    const messages = readInbox({ agent: 'codex' }, workspace.dir).messages;
    assert.ok(messages.length > 0);
    const briefBody = messages[0].text;
    assert.ok(
      briefBody.length <= 48_000 + 500,
      `brief should be near the 48 000 char budget; got ${briefBody.length}`,
    );
    assert.match(briefBody, /memory bundle truncated/, 'brief should carry the truncation tail');
  });
});

describe('ideate e2e — min_artifacts_by_type at loop scope as stop_condition (pln#492 stp_f528ae94)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ currentAgent: 'claude-code' });
  });

  afterEach(() => {
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('a loop-scoped min_artifacts_by_type stop_condition fires once the loop-wide count crosses the threshold', () => {
    // Open an ideation loop with a custom stop_condition that uses
    // min_artifacts_by_type at LOOP scope (separate from the default
    // critique advance_gate which is at PHASE scope). After 3 critique
    // artifacts have accumulated anywhere in the loop, the next advance
    // should auto-close the loop as completed.
    const loop = openLoop(
      {
        kind: 'ideation',
        title: 'loop-scope stop',
        created_by: workspace.currentAgent.agent_id,
        slots: [{ role: 'champion', agent: 'claude-code', agent_id: workspace.currentAgent.agent_id }],
        stop_condition: {
          kind: 'min_artifacts_by_type',
          type: 'critique',
          n: 3,
          scope: 'loop',
        },
      },
      workspace.dir,
    );

    // Seed a proposal artifact so advance proposal → critique is allowed.
    add_artifact(
      {
        id: loop.id,
        actor: workspace.currentAgent.agent_id,
        artifact: { phase: 'proposal', type: 'proposal', body: 'a proposal' },
      },
      workspace.dir,
    );

    // proposal → critique (no advance_gate on proposal).
    advance({ id: loop.id, actor: workspace.currentAgent.agent_id }, workspace.dir);

    // Add 3 critique artifacts — meets the loop-scoped threshold.
    for (let i = 0; i < 3; i++) {
      add_artifact(
        {
          id: loop.id,
          actor: workspace.currentAgent.agent_id,
          artifact: { phase: 'critique', type: 'critique', body: `crit ${i}` },
        },
        workspace.dir,
      );
    }

    // Try to advance again. The current critique advance_gate (≥3 critique
    // artifacts in current phase, current iteration) is met, so the engine
    // can move out of critique. After the move, the stop_condition fires
    // (loop-wide critique count = 3 ≥ 3) and the loop auto-closes.
    const result = advance({ id: loop.id, actor: workspace.currentAgent.agent_id }, workspace.dir);
    assert.equal(result.auto_closed, true, 'stop_condition must auto-close the loop');
    assert.equal(result.loop.status, 'completed', 'loop status must flip to completed');

    const refreshed = getLoop(loop.id, workspace.dir) as LoopThread;
    assert.ok(refreshed.closed_at, 'closed_at must be set');
  });

  it('the same stop_condition does NOT fire while the count is below the threshold', () => {
    const loop = openLoop(
      {
        kind: 'ideation',
        title: 'below threshold',
        created_by: workspace.currentAgent.agent_id,
        slots: [{ role: 'champion', agent: 'claude-code', agent_id: workspace.currentAgent.agent_id }],
        stop_condition: {
          kind: 'min_artifacts_by_type',
          type: 'critique',
          n: 5, // requires 5; we'll only add 2
          scope: 'loop',
        },
      },
      workspace.dir,
    );

    add_artifact(
      {
        id: loop.id,
        actor: workspace.currentAgent.agent_id,
        artifact: { phase: 'proposal', type: 'proposal', body: 'a proposal' },
      },
      workspace.dir,
    );

    advance({ id: loop.id, actor: workspace.currentAgent.agent_id }, workspace.dir);

    for (let i = 0; i < 2; i++) {
      add_artifact(
        {
          id: loop.id,
          actor: workspace.currentAgent.agent_id,
          artifact: { phase: 'critique', type: 'critique', body: `crit ${i}` },
        },
        workspace.dir,
      );
    }

    // Phase advance_gate (3 in phase) is unmet → advance throws
    // phase_advance_blocked, the stop_condition never gets evaluated post-
    // transition. The loop stays open.
    assert.throws(
      () => advance({ id: loop.id, actor: workspace.currentAgent.agent_id }, workspace.dir),
      /phase_advance_blocked/,
    );

    const stillOpen = getLoop(loop.id, workspace.dir) as LoopThread;
    assert.equal(stillOpen.status, 'open', 'loop must remain open below the stop threshold');
  });
});
