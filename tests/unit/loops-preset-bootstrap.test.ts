import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import {
  AtomicStopConditionSchema,
  BOOTSTRAP_PRESET,
  evaluateStopCondition,
  getLoop,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { PRESETS } from '../../src/core/loops/presets/index.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * pln#511 step 1 — bootstrap preset module + `no_open_questions` StopCondition.
 *
 * Locks in (a) the preset's phase chain / gates / protocol — the coordinate
 * facade in step 2 wires off these exact fields — and (b) the new atomic
 * stop-condition primitive used by the `clarify` phase's `any` gate.
 */

function makeThread(overrides: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_test000000',
    version: 0,
    mutation_id: 'mut_test',
    kind: 'ideation',
    title: 'preset test thread',
    status: 'open',
    phases: [{ name: 'clarify' }],
    current_phase: 'clarify',
    iteration_count: 0,
    slots: [],
    artifacts: [],
    open_questions: [],
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    created_by: 'agt_test',
    ...overrides,
  };
}

describe('BOOTSTRAP_PRESET — phase chain (pln#511 step 1)', () => {
  it('declares five phases in the Phase 0 spec order', () => {
    assert.equal(BOOTSTRAP_PRESET.phases.length, 5);
    assert.deepEqual(
      BOOTSTRAP_PRESET.phases.map((p) => p.name),
      ['survey', 'propose', 'clarify', 'review_draft', 'converge'],
    );
  });

  it('uses curated context_filter on survey + clarify, wildcard on propose/review_draft/converge', () => {
    const [survey, propose, clarify, reviewDraft, converge] = BOOTSTRAP_PRESET.phases;
    assert.deepEqual(survey.context_filter, ['project_vision', 'decisions', 'plans', 'feedback']);
    assert.deepEqual(propose.context_filter, ['*']);
    assert.deepEqual(clarify.context_filter, ['critique_history', 'runtime_notes', 'feedback']);
    assert.deepEqual(reviewDraft.context_filter, ['*']);
    assert.deepEqual(converge.context_filter, ['*']);
  });

  it('survey advance_gate is artifact_produced(survey, signals_report)', () => {
    const gate = BOOTSTRAP_PRESET.phases[0].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'survey',
      type: 'signals_report',
    });
  });

  it('propose advance_gate is artifact_produced(propose, project_md_draft)', () => {
    const gate = BOOTSTRAP_PRESET.phases[1].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'propose',
      type: 'project_md_draft',
    });
  });

  it('clarify advance_gate is any[no_open_questions, max_iterations=1]', () => {
    const gate = BOOTSTRAP_PRESET.phases[2].advance_gate;
    assert.deepEqual(gate, {
      kind: 'any',
      conditions: [
        { kind: 'no_open_questions' },
        { kind: 'max_iterations', n: 1 },
      ],
    });
  });

  it('review_draft advance_gate is artifact_produced(review_draft, operator_answer)', () => {
    const gate = BOOTSTRAP_PRESET.phases[3].advance_gate;
    assert.deepEqual(gate, {
      kind: 'artifact_produced',
      phase: 'review_draft',
      type: 'operator_answer',
    });
  });

  it('converge has no advance_gate (terminal phase; loop closes on stop_condition)', () => {
    assert.equal(BOOTSTRAP_PRESET.phases[4].advance_gate, undefined);
  });
});

describe('BOOTSTRAP_PRESET — stop_condition + protocol', () => {
  it('stop_condition is artifact_produced(converge, project_md_final)', () => {
    assert.deepEqual(BOOTSTRAP_PRESET.stop_condition, {
      kind: 'artifact_produced',
      phase: 'converge',
      type: 'project_md_final',
    });
  });

  it('protocol carries the bootstrap preset identifier + safety caps', () => {
    assert.deepEqual(BOOTSTRAP_PRESET.protocol, {
      preset: 'bootstrap',
      max_operator_questions: 3,
      max_pause_duration: 'P7D',
    });
  });
});

describe('AtomicStopConditionSchema — no_open_questions (pln#511 step 1)', () => {
  it('parses the new atomic shape', () => {
    const parsed = AtomicStopConditionSchema.parse({ kind: 'no_open_questions' });
    assert.deepEqual(parsed, { kind: 'no_open_questions' });
  });
});

describe('evaluateStopCondition — no_open_questions', () => {
  it('returns true when the thread has zero open_questions', () => {
    const thread = makeThread({ open_questions: [] });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      true,
    );
  });

  it('returns false when at least one question is open', () => {
    const thread = makeThread({ open_questions: ['qst_abc123'] });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      false,
    );
  });

  it('returns false when multiple questions are open', () => {
    const thread = makeThread({
      open_questions: ['qst_abc123', 'qst_def456', 'qst_ghi789'],
    });
    assert.equal(
      evaluateStopCondition(thread, { kind: 'no_open_questions' }),
      false,
    );
  });

  it('composes inside the clarify `any` gate: matches when either condition holds', () => {
    const clarifyGate = BOOTSTRAP_PRESET.phases[2].advance_gate!;
    // open_questions empty → no_open_questions branch fires.
    assert.equal(
      evaluateStopCondition(makeThread({ open_questions: [] }), clarifyGate),
      true,
    );
    // Question still open BUT iteration_count >= 1 → max_iterations branch fires.
    assert.equal(
      evaluateStopCondition(
        makeThread({ open_questions: ['qst_abc123'], iteration_count: 1 }),
        clarifyGate,
      ),
      true,
    );
    // Question open AND iteration_count < 1 → neither branch holds.
    assert.equal(
      evaluateStopCondition(
        makeThread({ open_questions: ['qst_abc123'], iteration_count: 0 }),
        clarifyGate,
      ),
      false,
    );
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * pln#511 step 2 — preset selector wiring into bclaw_coordinate
 *
 * Exercises the handler end-to-end so the schema field, the registry
 * lookup, the openLoop pass-through, and the dispatch guard all line up.
 * ────────────────────────────────────────────────────────────────────── */

interface CoordinateResult extends FacadeResponse {
  result: Record<string, unknown>;
}

interface CoordinateErrorEnvelope {
  error: { kind: string; message: string; details?: unknown };
}

async function coordinate(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<{ outcome: Awaited<ReturnType<typeof executeMcpToolCall>>; ok: CoordinateResult; err: CoordinateErrorEnvelope }> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_coordinate',
    args,
    cwd: workspace.dir,
  });
  const structured = outcome.response.structuredContent;
  return {
    outcome,
    ok: structured as unknown as CoordinateResult,
    err: structured as unknown as CoordinateErrorEnvelope,
  };
}

describe('bclaw_coordinate preset selector — wiring (pln#511 step 2)', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;
  // Env vars not handled by createTestWorkspace's isolation list (those
  // strip BRAINCLAW_AGENT*, but leave BRAINCLAW_CWD / BRAINCLAW_CLAIM_ID
  // alone). When the test is run from inside a brainclaw assignment
  // session, both are set and route resolveEffectiveCwd back to the
  // outer project — defeating the workspace boundary. Save and clear
  // them here so the test sees only the temp workspace.
  const ENV_KEYS_TO_ISOLATE = [
    'BRAINCLAW_TEST_MODE',
    'BRAINCLAW_NO_SPAWN',
    'BRAINCLAW_CWD',
    'BRAINCLAW_CLAIM_ID',
    'BRAINCLAW_PROJECT',
  ] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS_TO_ISOLATE)[number], string | undefined>> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.BRAINCLAW_TEST_MODE = '1';
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({
      prefix: 'preset-bootstrap-wiring-',
      currentAgent: 'claude-code',
    });
    // useCwd anchors process.cwd() into the workspace so any code that
    // falls back to process.cwd() (e.g. inner helpers without a cwd arg)
    // also resolves to the test workspace, not the parent worktree.
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
  });

  it('preset=bootstrap opens an ideation loop with the 5 BOOTSTRAP_PRESET phases in order', async () => {
    const { outcome, ok } = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Bootstrap project memory from existing scaffold',
      agent: 'claude-code',
      preset: 'bootstrap',
    });

    assert.equal(outcome.response.isError, false, `unexpected MCP error: ${JSON.stringify(outcome.response.structuredContent)}`);
    assert.equal(ok.status, 'ok');
    const result = ok.result;
    const loopId = result.loop_id as string;
    assert.match(loopId, /^lop_[0-9a-z]+$/);
    assert.equal(result.preset, 'bootstrap');
    assert.equal(result.current_phase, 'survey');
    // Preset path skips the proposal-seed artifact: it would dangle on
    // a 'proposal' phase that the bootstrap loop does not declare.
    assert.equal(result.proposal_artifact_id, undefined);

    const loop = getLoop(loopId, workspace.dir);
    assert.ok(loop, 'bootstrap loop must be persisted');
    assert.deepEqual(
      loop.phases.map((p) => p.name),
      ['survey', 'propose', 'clarify', 'review_draft', 'converge'],
    );
    assert.equal(loop.current_phase, 'survey');
    // Phase advance gates carry through unchanged from the preset.
    assert.deepEqual(loop.phases[2].advance_gate, {
      kind: 'any',
      conditions: [
        { kind: 'no_open_questions' },
        { kind: 'max_iterations', n: 1 },
      ],
    });
    // The stop_condition wired into the thread is the preset's.
    assert.deepEqual(loop.stop_condition, {
      kind: 'artifact_produced',
      phase: 'converge',
      type: 'project_md_final',
    });
  });

  it("preset=bootstrap sets loop.protocol.preset='bootstrap' + safety caps", async () => {
    const { outcome, ok } = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Bootstrap project memory',
      agent: 'claude-code',
      preset: 'bootstrap',
    });
    assert.equal(outcome.response.isError, false);
    assert.equal(ok.status, 'ok');
    const loopId = ok.result.loop_id as string;
    const loop = getLoop(loopId, workspace.dir);
    assert.ok(loop);
    assert.deepEqual(loop.protocol, {
      preset: 'bootstrap',
      max_operator_questions: 3,
      max_pause_duration: 'P7D',
    });
  });

  it('preset=bootstrap with targetAgents=[codex] is rejected with bootstrap_preset_not_dispatchable (can_753a083a)', async () => {
    const { outcome, err } = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Bootstrap project memory',
      agent: 'claude-code',
      preset: 'bootstrap',
      targetAgents: ['codex'],
    });
    assert.equal(outcome.response.isError, true, 'must surface an MCP-level error');
    assert.equal(err.error.kind, 'bootstrap_preset_not_dispatchable');
    assert.match(
      err.error.message,
      /can_753a083a/,
      'error body must cite the can_753a083a constraint',
    );
  });

  it('preset=bootstrap with targetAgents=[caller] is accepted (single-agent self-champion form)', async () => {
    const { outcome, ok } = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Bootstrap project memory',
      agent: 'claude-code',
      preset: 'bootstrap',
      targetAgents: ['claude-code'],
    });
    assert.equal(outcome.response.isError, false);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.result.preset, 'bootstrap');
  });

  it('preset=<unknown> is rejected with unknown_preset listing valid names', async () => {
    const { outcome, err } = await coordinate(workspace, {
      intent: 'ideate',
      task: 'Whatever',
      agent: 'claude-code',
      preset: 'nonexistent',
    });
    assert.equal(outcome.response.isError, true);
    assert.equal(err.error.kind, 'unknown_preset');
    // Lists the registry's valid names so the caller can fix the typo.
    for (const name of Object.keys(PRESETS)) {
      assert.match(err.error.message, new RegExp(name));
    }
  });

  it('preset on a non-ideate intent is rejected with preset_kind_mismatch', async () => {
    const { outcome, err } = await coordinate(workspace, {
      intent: 'review',
      task: 'Review PR',
      scope: 'src/somewhere.ts',
      targetAgents: ['codex'],
      agent: 'claude-code',
      preset: 'bootstrap',
    });
    assert.equal(outcome.response.isError, true);
    assert.equal(err.error.kind, 'preset_kind_mismatch');
    assert.match(err.error.message, /ideate/);
  });
});
