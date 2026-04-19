import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpReadToolCall } from '../../src/commands/mcp-read-handlers.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * Phase 3 slice 3c — bclaw_context(kind) unified dispatcher.
 * Verifies dispatch semantics against the 4 legacy handlers + the new
 * delta kind.
 */
describe('commands/mcp-read-handlers — bclaw_context(kind)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-context-unified-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('dispatches kind="memory" to bclaw_get_context', () => {
    const legacy = handleMcpReadToolCall('bclaw_get_context', {}, { cwd: workspace.dir });
    const unified = handleMcpReadToolCall('bclaw_context', { kind: 'memory' }, { cwd: workspace.dir });
    assert.ok(unified.content);
    assert.equal(unified.content.length, legacy.content.length);
  });

  it('dispatches kind="execution" to bclaw_get_execution_context', () => {
    const legacy = handleMcpReadToolCall('bclaw_get_execution_context', {}, { cwd: workspace.dir });
    const unified = handleMcpReadToolCall('bclaw_context', { kind: 'execution' }, { cwd: workspace.dir });
    assert.ok(unified.structuredContent);
    // Execution context snapshot is deterministic per run; shapes match.
    assert.deepEqual(
      Object.keys(unified.structuredContent ?? {}).sort(),
      Object.keys(legacy.structuredContent ?? {}).sort(),
    );
  });

  it('dispatches kind="board" to bclaw_get_agent_board', () => {
    const legacy = handleMcpReadToolCall('bclaw_get_agent_board', {}, { cwd: workspace.dir });
    const unified = handleMcpReadToolCall('bclaw_context', { kind: 'board' }, { cwd: workspace.dir });
    assert.ok(unified.content);
    assert.ok(legacy.content);
  });

  it('dispatches kind="board_summary" to bclaw_get_agent_board_summary', () => {
    const legacy = handleMcpReadToolCall('bclaw_get_agent_board_summary', {}, { cwd: workspace.dir });
    const unified = handleMcpReadToolCall('bclaw_context', { kind: 'board_summary' }, { cwd: workspace.dir });
    assert.deepEqual(
      Object.keys(unified.structuredContent ?? {}).sort(),
      Object.keys(legacy.structuredContent ?? {}).sort(),
    );
  });

  it('kind="delta" forwards `since` as since_session to the memory path', () => {
    const fakeSession = 'sess_nonexistent_abc';
    // Should not throw — handler forwards to bclaw_get_context with since_session.
    const unified = handleMcpReadToolCall(
      'bclaw_context',
      { kind: 'delta', since: fakeSession },
      { cwd: workspace.dir },
    );
    assert.ok(unified.content);
  });

  it('kind="delta" without `since` throws clearly', () => {
    assert.throws(
      () => handleMcpReadToolCall('bclaw_context', { kind: 'delta' }, { cwd: workspace.dir }),
      /requires `since`/,
    );
  });

  it('unknown kind throws with expected enum hint', () => {
    assert.throws(
      () => handleMcpReadToolCall('bclaw_context', { kind: 'nope' }, { cwd: workspace.dir }),
      /unknown kind/,
    );
  });
});
