import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpReadToolCall } from '../../src/commands/mcp-read-handlers.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

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
});
