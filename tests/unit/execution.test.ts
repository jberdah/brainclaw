/**
 * Tests for src/core/execution.ts — E2E dispatch execution engine.
 *
 * Covers: canSpawnAgent, executeDispatchedCommand, attemptExecution
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { canSpawnAgent, attemptExecution, type ExecutionResult } from '../../src/core/execution.js';
import { buildInvokeCommand, type InvokeCommand } from '../../src/core/agent-capability.js';
import { CoordinateRequestSchema, ExecutionStatusSchema } from '../../src/core/facade-schema.js';

// ── canSpawnAgent ───────────────────────────────────────────

describe('canSpawnAgent', () => {
  it('returns false for unknown agent', () => {
    const result = canSpawnAgent('nonexistent-agent');
    assert.equal(result.canSpawn, false);
    assert.ok(result.reason.includes('unknown'));
  });

  it('returns false for non-spawnable agent (cursor is IDE-only)', () => {
    const result = canSpawnAgent('cursor');
    assert.equal(result.canSpawn, false);
  });

  it('detects spawnable agents with invoke template', () => {
    // claude-code and codex have spawnable_cli=true + invoke_template
    for (const agent of ['claude-code', 'codex', 'opencode']) {
      const result = canSpawnAgent(agent);
      // In test context stdin is likely not a TTY, so canSpawn may be false
      // but the reason should NOT be about missing profile/template
      assert.ok(
        !result.reason.includes('unknown') && !result.reason.includes('not CLI-spawnable') && !result.reason.includes('no invoke template'),
        `${agent} should have valid profile+template, got: ${result.reason}`,
      );
    }
  });

  it('respects BRAINCLAW_CAN_SPAWN env override', () => {
    const prev = process.env.BRAINCLAW_CAN_SPAWN;
    try {
      process.env.BRAINCLAW_CAN_SPAWN = '1';
      const result = canSpawnAgent('claude-code');
      assert.equal(result.canSpawn, true);
      assert.ok(result.reason.includes('override'));
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_CAN_SPAWN;
      else process.env.BRAINCLAW_CAN_SPAWN = prev;
    }
  });

  it('returns false in non-TTY context (MCP stdio sandbox)', () => {
    const prev = process.env.BRAINCLAW_CAN_SPAWN;
    try {
      delete process.env.BRAINCLAW_CAN_SPAWN;
      // In test runner, stdin is typically not a TTY
      if (!process.stdin.isTTY) {
        const result = canSpawnAgent('claude-code');
        assert.equal(result.canSpawn, false);
        assert.ok(result.reason.includes('stdio'));
      }
    } finally {
      if (prev !== undefined) process.env.BRAINCLAW_CAN_SPAWN = prev;
    }
  });
});

// ── attemptExecution ────────────────────────────────────────

describe('attemptExecution', () => {
  it('returns inbox_only when no invoke command available', () => {
    const result = attemptExecution(undefined, {
      agent: 'cursor',
      autoExecute: true,
      dispatcherAgent: 'test',
      cwd: process.cwd(),
    });
    assert.equal(result.execution_status, 'inbox_only');
  });

  it('returns command_ready_manual when autoExecute is false', () => {
    const invoke = buildInvokeCommand('claude-code', 'test prompt');
    assert.ok(invoke, 'claude-code should produce an invoke command');
    const result = attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: false,
      dispatcherAgent: 'test',
      cwd: process.cwd(),
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.ok(result.command, 'should include the command string');
  });

  it('returns command_ready_manual in non-TTY context (test runner)', () => {
    const prev = process.env.BRAINCLAW_CAN_SPAWN;
    try {
      delete process.env.BRAINCLAW_CAN_SPAWN;
      const invoke = buildInvokeCommand('codex', 'test prompt');
      assert.ok(invoke, 'codex should produce an invoke command');
      if (!process.stdin.isTTY) {
        const result = attemptExecution(invoke, {
          agent: 'codex',
          autoExecute: true,
          dispatcherAgent: 'test',
          cwd: process.cwd(),
        });
        assert.equal(result.execution_status, 'command_ready_manual');
        assert.ok(result.command, 'should include command for manual run');
      }
    } finally {
      if (prev !== undefined) process.env.BRAINCLAW_CAN_SPAWN = prev;
    }
  });

  it('command_ready_manual includes shell info', () => {
    const invoke = buildInvokeCommand('claude-code', 'test');
    assert.ok(invoke);
    const result = attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: false,
      dispatcherAgent: 'test',
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.ok(result.shell, 'should include shell type');
  });
});

// ── ExecutionStatus schema ──────────────────────────────────

describe('ExecutionStatus schema', () => {
  it('validates all three status values', () => {
    for (const status of ['delivered_and_started', 'command_ready_manual', 'inbox_only']) {
      const result = ExecutionStatusSchema.safeParse(status);
      assert.ok(result.success, `${status} should be valid`);
    }
  });

  it('rejects invalid status', () => {
    const result = ExecutionStatusSchema.safeParse('invalid_status');
    assert.ok(!result.success);
  });
});

// ── CoordinateRequest autoExecute ───────────────────────────

describe('CoordinateRequestSchema — autoExecute', () => {
  it('accepts autoExecute=true', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'test',
      autoExecute: true,
    });
    assert.ok(result.success);
    assert.equal(result.data.autoExecute, true);
  });

  it('accepts autoExecute=false', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'test',
      autoExecute: false,
    });
    assert.ok(result.success);
    assert.equal(result.data.autoExecute, false);
  });

  it('autoExecute is optional (defaults to undefined)', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'test',
    });
    assert.ok(result.success);
    assert.equal(result.data.autoExecute, undefined);
  });
});
