import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpReadToolCall } from '../../src/commands/mcp-read-handlers.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveSequence } from '../../src/core/sequence.js';
import { loadState, persistState } from '../../src/core/state.js';
import type { Claim, PlanItem, Sequence } from '../../src/core/schema.js';

/**
 * Phase 3 slice 3d — bclaw_dispatch(intent) unified. The intent router
 * lives inside the write-tool handler (`executeMcpToolCall`), which is
 * a big function without a thin seam for unit-testing. We verify the
 * pieces we CAN reach from the unit surface:
 *
 * - `bclaw_dispatch_analysis` (read path) still resolves through
 *   handleMcpReadToolCall — the intent=analysis branch delegates to it.
 *
 * Schema-level routing (intent=execute / review with full MCP
 * plumbing, trust enforcement, audit entries) is covered by the
 * existing dispatch E2E tests under tests/unit/dispatch-e2e*.
 *
 * Verified 2026-04-19 (Sonnet 4.6 pre-v1 review): the intent='review'
 * branch at src/commands/mcp.ts `intent === 'review'` block delegates
 * to the same `dispatchReview()` function consumed by the legacy
 * bclaw_dispatch_review handler. Not a divergence — same code path,
 * different entry point.
 */
describe('commands — bclaw_dispatch(intent) read delegate', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-dispatch-unified-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('bclaw_dispatch_analysis returns a well-formed analysis response (used by intent=analysis)', () => {
    const result = handleMcpReadToolCall('bclaw_dispatch_analysis', {}, { cwd: workspace.dir });
    assert.ok(result.content);
    // Analysis is safe to run on an empty workspace — must not throw, and
    // should surface either a structured analysis or a "no active sequence"
    // text response.
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    assert.ok(text.length > 0);
  });

  it('Codex r2: pre-adoption lane renders "pending adoption" (not "working") in MCP analysis text', () => {
    // Seed a plan with a fresh coordinator claim (no session_id → young,
    // pre-adoption). The CLI dispatch renderer was fixed in round 1 but the
    // MCP mirror still printed the misleading "agent working" label.
    const plan: PlanItem = {
      id: 'pln_pending_adopt',
      text: 'pre-adoption lane',
      status: 'in_progress',
      priority: 'medium',
      tags: [],
      depends_on: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author: 'test',
    };
    const state = loadState(workspace.dir);
    state.plan_items = [plan];
    persistState(state, workspace.dir);

    const claim: Claim = {
      schema_version: 2,
      id: 'clm_pending_adopt',
      agent: 'claude-code',
      scope: 'src/x.ts',
      description: 'Awaiting worker',
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago = young
      status: 'active',
      plan_id: 'pln_pending_adopt',
      // Intentionally no session_id / adopted_at — pre-adoption.
    };
    saveClaim(claim, workspace.dir);

    const sequence: Sequence = {
      schema_version: 2,
      id: 'seq_pending_adopt',
      name: 'pending-adopt-test',
      status: 'active',
      items: [{ rank: 1, planId: 'pln_pending_adopt', hard_after: [], soft_after: [] }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author: 'test',
      tags: [],
    };
    saveSequence(sequence, workspace.dir);

    const result = handleMcpReadToolCall('bclaw_dispatch_analysis', {}, { cwd: workspace.dir });
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    assert.match(text, /pending adoption/, 'pre-adoption lane should render "pending adoption"');
    assert.ok(
      !/claude-code working$/m.test(text),
      'must not print plain "working" for a pre-adoption lane',
    );
  });
});
