/**
 * pln#520 step 5 — the generated brief carries an imperative, zero-MCP
 * liveness instruction: write `work_loop_reached` to an absolute signals path
 * BEFORE any other action. Pairs with the wrapper + reconciler (steps 4 + 1).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLivenessSection,
  generateBrief,
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
