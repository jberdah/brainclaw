/**
 * pln#638 PR-6b — the ContextEnvelope: survival context rides IN the brief.
 *
 * Dispatch briefs used to tell workers "call bclaw_context for project memory".
 * That instruction assumes MCP is reachable — and PR-6 exists because a
 * production critic ran with the declared-MCP flag true and no server there,
 * working blind. The brief is the one artifact every tier demonstrably
 * receives, so constraints/traps/decisions are inlined: bounded, deterministic,
 * newest-first. MCP becomes a refresh, never a prerequisite.
 *
 * Deliberately NOT scope-filtered: relevance guessing risks hiding the one trap
 * that mattered — the claim-scope inverted-default lesson applied to context.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextEnvelopeSection, generateDispatchBrief } from '../../src/core/dispatcher.js';
import { saveState, loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function seedState(dir: string, counts: { constraints?: number; traps?: number; decisions?: number }, textLen = 40): void {
  const state = loadState(dir);
  const mk = (prefix: string, i: number): Record<string, unknown> => ({
    id: `${prefix}_${String(i).padStart(3, '0')}`,
    text: `${prefix} item ${i} ${'x'.repeat(textLen)}`,
    author: 'test',
    created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    tags: [],
  });
  // Schema-required discriminants: constraints carry a status, traps a severity.
  state.active_constraints = Array.from(
    { length: counts.constraints ?? 0 }, (_, i) => ({ ...mk('cst', i), status: 'active' }),
  ) as never;
  state.known_traps = Array.from(
    { length: counts.traps ?? 0 }, (_, i) => ({ ...mk('trp', i), severity: 'medium' }),
  ) as never;
  state.recent_decisions = Array.from({ length: counts.decisions ?? 0 }, (_, i) => mk('dec', i)) as never;
  saveState(state, dir);
}

describe('pln#638 PR-6b — context envelope', { concurrency: false }, () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-ctx-envelope-' });
  });

  afterEach(() => {
    process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    workspace.cleanup();
  });

  it('renders constraints, traps and decisions, newest first', () => {
    seedState(workspace.dir, { constraints: 2, traps: 3, decisions: 2 });
    const s = buildContextEnvelopeSection(workspace.dir);
    assert.match(s, /## Project context \(inlined — MCP is a refresh, not a prerequisite\)/);
    assert.match(s, /Active constraints \(binding\)/);
    // Newest first: trp_002 (Jan 3) must appear before trp_000 (Jan 1).
    assert.ok(s.indexOf('trp_002') < s.indexOf('trp_000'), 'traps must be newest-first');
  });

  it('is deterministic — same store, same envelope, byte for byte', () => {
    seedState(workspace.dir, { constraints: 1, traps: 4, decisions: 4 });
    assert.equal(buildContextEnvelopeSection(workspace.dir), buildContextEnvelopeSection(workspace.dir));
  });

  it('caps traps and decisions at top-K and SAYS so in the snapshot line', () => {
    seedState(workspace.dir, { traps: 20, decisions: 15 });
    const s = buildContextEnvelopeSection(workspace.dir);
    assert.match(s, /6\/20 trap\(s\)/, 'the snapshot must state included/total — silent truncation reads as complete');
    assert.match(s, /6\/15 decision\(s\)/);
  });

  it('respects the total character budget with long items', () => {
    seedState(workspace.dir, { constraints: 6, traps: 6, decisions: 6 }, 400);
    const s = buildContextEnvelopeSection(workspace.dir);
    assert.ok(s.length <= 3000, `envelope must stay within budget, got ${s.length}`);
    assert.match(s, /## Project context/, 'the header survives the trim');
  });

  it('an empty store yields NO section — no noise', () => {
    assert.equal(buildContextEnvelopeSection(workspace.dir), '');
  });

  it('a missing store yields NO section and never throws', () => {
    assert.doesNotThrow(() => buildContextEnvelopeSection('/definitely/not/a/store'));
  });

  it('EMISSION: the delivered dispatch brief carries the envelope', () => {
    // The seam. Helper-only green was this session's recurring failure.
    seedState(workspace.dir, { constraints: 1, traps: 2 });
    const brief = generateDispatchBrief({
      task: 'fix the thing',
      agent: 'codex',
      assignmentId: 'asgn_env',
      cwd: workspace.dir,
    });
    assert.match(brief, /## Project context \(inlined/);
    assert.match(brief, /cst_000/);
  });

  it('EMISSION: no store context → the brief simply omits the section', () => {
    const brief = generateDispatchBrief({ task: 'fix', agent: 'codex', cwd: workspace.dir });
    assert.doesNotMatch(brief, /## Project context/);
  });

  it('contextEnvelope: false suppresses the section even with a seeded store', () => {
    // The ideation critic path: its content already inlines a BM25-curated
    // memory bundle, so the generic envelope would double-carry the same
    // traps and blow the ideation content cap (ideation-loop-e2e pins the
    // budget math; this pins the switch).
    seedState(workspace.dir, { constraints: 1, traps: 2 });
    const brief = generateDispatchBrief({
      task: 'critique the proposal',
      agent: 'codex',
      cwd: workspace.dir,
      contextEnvelope: false,
    });
    assert.doesNotMatch(brief, /## Project context/);
  });
});
