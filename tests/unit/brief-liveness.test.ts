/**
 * pln#520 step 5 — the generated brief carries an imperative, zero-MCP
 * liveness instruction: write `work_loop_reached` to an absolute signals path
 * BEFORE any other action. Pairs with the wrapper + reconciler (steps 4 + 1).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLivenessSection,
  buildWorkingDefaultsSection,
  generateBrief,
  generateDispatchBrief,
} from '../../src/core/dispatcher.js';
import { getRuntimeSignalPath } from '../../src/core/runtime-signals.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { PlanItem, SequenceItem } from '../../src/core/schema.js';

let ws: TestWorkspace;
beforeEach(() => { ws = createTestWorkspace({ currentAgent: 'brief-test' }); });
afterEach(() => { ws.cleanup(); });

function plan(): PlanItem {
  return {
    id: 'pln_b', short_label: 'pln#1', text: 'Do the thing', type: 'feat',
    status: 'todo', priority: 'medium', author: 'u',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    tags: [], steps: [],
  } as unknown as PlanItem;
}
function item(): SequenceItem {
  return { planId: 'pln_b', rank: 1, hard_after: [], soft_after: [] } as unknown as SequenceItem;
}

describe('buildLivenessSection (pln#520 step 5)', () => {
  it('emits a DO-THIS-FIRST heartbeat instruction with the absolute path', () => {
    const section = buildLivenessSection(ws.dir, 'asgn_z');
    const hbPath = getRuntimeSignalPath(ws.dir, 'asgn_z', 'heartbeat');
    assert.ok(section.includes('DO THIS FIRST'), section);
    assert.ok(section.includes('work_loop_reached'), section);
    assert.ok(section.includes(hbPath), `absolute heartbeat path present: ${section}`);
    // The write command targets the heartbeat path (a shell redirect, zero-MCP).
    assert.ok(section.includes(`> "${hbPath}"`), `shell redirect to heartbeat: ${section}`);
  });
});

describe('generateBrief liveness wiring (pln#520 step 5)', () => {
  it('includes the liveness section when an assignment id is present', () => {
    const brief = generateBrief(plan(), item(), ws.dir, 'full', { assignmentId: 'asgn_z', claimId: 'clm_z' });
    assert.ok(brief.includes('## Liveness'), 'full brief carries liveness section');
    assert.ok(brief.includes(getRuntimeSignalPath(ws.dir, 'asgn_z', 'heartbeat')));
  });

  it('includes it in compact mode too (zero-MCP sandboxed workers still heartbeat)', () => {
    const brief = generateBrief(plan(), item(), ws.dir, 'compact', { assignmentId: 'asgn_z' });
    assert.ok(brief.includes('## Liveness'), 'compact brief carries liveness section');
  });

  it('omits the liveness section when there is no assignment id', () => {
    const brief = generateBrief(plan(), item(), ws.dir, 'full', { claimId: 'clm_z' });
    assert.ok(!brief.includes('## Liveness'), 'no assignment → no heartbeat key → no section');
  });
});

describe('sandbox-aware heartbeat path (pln#554 step 4c)', () => {
  it('buildLivenessSection points at a worktree-RELATIVE path when sandboxed', () => {
    const wt = 'C:\\some\\worktree';
    const section = buildLivenessSection(ws.dir, 'asgn_sbx', wt, { sandboxed: true });
    assert.ok(section.includes('> ".brainclaw-heartbeat-asgn_sbx"'), `relative redirect: ${section}`);
    assert.ok(!section.includes(`> "${wt}`), 'must NOT redirect to the absolute worktree path');
    assert.match(section, /worktree-RELATIVE/);
  });

  it('keeps the absolute worktree path for non-sandboxed workers', () => {
    const wt = 'C:\\some\\worktree';
    const section = buildLivenessSection(ws.dir, 'asgn_nsx', wt);
    assert.ok(section.includes('.brainclaw-heartbeat-asgn_nsx'), section);
    assert.ok(section.includes(wt), 'absolute worktree heartbeat path expected');
  });

  it('generateBrief for codex (sandboxed spawn) uses the relative heartbeat', () => {
    const brief = generateBrief(plan(), item(), ws.dir, 'full', {
      assignmentId: 'asgn_cx', claimId: 'clm_cx', worktreePath: 'C:\\wt\\codex-lane', agent: 'codex',
    });
    assert.ok(brief.includes('> ".brainclaw-heartbeat-asgn_cx"'), 'codex brief must use the worktree-relative heartbeat');
  });

  it('generateDispatchBrief for codex uses the relative heartbeat too', () => {
    const brief = generateDispatchBrief({
      task: 'Do the thing', agent: 'codex', assignmentId: 'asgn_dx', claimId: 'clm_dx', worktreePath: 'C:\\wt\\codex-lane',
    });
    assert.ok(brief.includes('> ".brainclaw-heartbeat-asgn_dx"'), brief.slice(0, 600));
  });
});

describe('working defaults section (pln#554 step 4a/4b)', () => {
  it('committing workers get the incremental-commit rule + validation bar', () => {
    const section = buildWorkingDefaultsSection({ canCommit: true });
    assert.match(section, /Incremental commits/);
    assert.match(section, /Never hold more than one step uncommitted/);
    assert.match(section, /files you touched ONLY/);
    assert.match(section, /full gate after harvest/);
  });

  it('sandboxed (no-commit) workers get the incremental-delivery variant', () => {
    const section = buildWorkingDefaultsSection({ canCommit: false });
    assert.match(section, /cannot `git commit`/);
    assert.match(section, /commits the worktree on your behalf/);
    assert.match(section, /full gate after harvest/);
  });

  it('generateBrief bakes the defaults into full AND compact modes', () => {
    const full = generateBrief(plan(), item(), ws.dir, 'full', { assignmentId: 'asgn_z', agent: 'claude-code' });
    const compact = generateBrief(plan(), item(), ws.dir, 'compact', { assignmentId: 'asgn_z' });
    assert.ok(full.includes('## Working defaults'), 'full mode');
    assert.match(full, /Incremental commits/);
    assert.ok(compact.includes('## Working defaults'), 'compact mode');
  });

  it('generateBrief for codex flips to the no-commit variant', () => {
    const brief = generateBrief(plan(), item(), ws.dir, 'full', { assignmentId: 'asgn_z', agent: 'codex' });
    assert.match(brief, /commits the worktree on your behalf/);
    assert.ok(!brief.includes('**Incremental commits**'), 'codex cannot self-commit');
  });

  it('generateDispatchBrief carries the defaults as well', () => {
    const brief = generateDispatchBrief({ task: 'Do the thing', agent: 'claude-code', assignmentId: 'asgn_z' });
    assert.ok(brief.includes('## Working defaults'));
    assert.match(brief, /Incremental commits/);
  });
});
