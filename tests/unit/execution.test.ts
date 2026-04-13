/**
 * Tests for src/core/execution.ts — E2E dispatch execution engine.
 *
 * Covers: canSpawnAgent, executeDispatchedCommand, attemptExecution
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { canSpawnAgent, attemptExecution, type ExecutionResult } from '../../src/core/execution.js';
import { buildInvokeCommand, type InvokeCommand } from '../../src/core/agent-capability.js';
import { defaultExecutionAdapter } from '../../src/core/execution-adapters.js';
import { CoordinateRequestSchema, ExecutionStatusSchema } from '../../src/core/facade-schema.js';

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

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

  it('returns true by default for spawnable agents (even in non-TTY)', () => {
    const prev = process.env.BRAINCLAW_NO_SPAWN;
    try {
      delete process.env.BRAINCLAW_NO_SPAWN;
      const result = canSpawnAgent('claude-code');
      assert.equal(result.canSpawn, true);
      assert.ok(result.reason.includes('spawnable'));
    } finally {
      if (prev !== undefined) process.env.BRAINCLAW_NO_SPAWN = prev;
    }
  });

  it('respects BRAINCLAW_NO_SPAWN opt-out', () => {
    const prev = process.env.BRAINCLAW_NO_SPAWN;
    try {
      process.env.BRAINCLAW_NO_SPAWN = '1';
      const result = canSpawnAgent('claude-code');
      assert.equal(result.canSpawn, false);
      assert.ok(result.reason.includes('NO_SPAWN'));
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
      else process.env.BRAINCLAW_NO_SPAWN = prev;
    }
  });
});

describe('defaultExecutionAdapter', () => {
  it('builds manual commands with OS-specific claim routing across agent families', () => {
    for (const agent of ['codex', 'claude-code']) {
      const invoke = buildInvokeCommand(agent, 'test prompt');
      assert.ok(invoke, `${agent} should produce an invoke command`);

      const posix = withPlatform('linux', () => defaultExecutionAdapter.prepareManualCommand(invoke, {
        agent,
        claimId: 'clm_posix',
      }));
      assert.ok(posix.command.startsWith('BRAINCLAW_CLAIM_ID=clm_posix '));

      const win = withPlatform('win32', () => defaultExecutionAdapter.prepareManualCommand(invoke, {
        agent,
        claimId: 'clm_win',
      }));
      assert.ok(win.command.startsWith('set BRAINCLAW_CLAIM_ID=clm_win && '));
    }
  });
});

// ── attemptExecution ────────────────────────────────────────

describe('attemptExecution', () => {
  it('returns inbox_only when no invoke command available', async () => {
    const result = await attemptExecution(undefined, {
      agent: 'cursor',
      autoExecute: true,
      dispatcherAgent: 'test',
      cwd: process.cwd(),
    });
    assert.equal(result.execution_status, 'inbox_only');
  });

  it('returns command_ready_manual when autoExecute is false', async () => {
    const invoke = buildInvokeCommand('claude-code', 'test prompt');
    assert.ok(invoke, 'claude-code should produce an invoke command');
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: false,
      dispatcherAgent: 'test',
      cwd: process.cwd(),
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.ok(result.command, 'should include the command string');
  });

  it('returns command_ready_manual when BRAINCLAW_NO_SPAWN is set', async () => {
    const prev = process.env.BRAINCLAW_NO_SPAWN;
    try {
      process.env.BRAINCLAW_NO_SPAWN = '1';
      const invoke = buildInvokeCommand('codex', 'test prompt');
      assert.ok(invoke, 'codex should produce an invoke command');
      const result = await attemptExecution(invoke, {
        agent: 'codex',
        autoExecute: true,
        dispatcherAgent: 'test',
        cwd: process.cwd(),
      });
      assert.equal(result.execution_status, 'command_ready_manual');
      assert.ok(result.command, 'should include command for manual run');
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
      else process.env.BRAINCLAW_NO_SPAWN = prev;
    }
  });

  it('command_ready_manual includes shell info', async () => {
    const invoke = buildInvokeCommand('claude-code', 'test');
    assert.ok(invoke);
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: false,
      dispatcherAgent: 'test',
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.ok(result.shell, 'should include shell type');
  });

  it('manual fallback prefixes claim_id differently on POSIX and Windows', async () => {
    const invoke = buildInvokeCommand('codex', 'test prompt');
    assert.ok(invoke, 'codex should produce an invoke command');

    const posix = await withPlatform('linux', () => attemptExecution(invoke, {
      agent: 'codex',
      autoExecute: false,
      dispatcherAgent: 'test',
      claimId: 'clm_posix',
    }));
    assert.equal(posix.execution_status, 'command_ready_manual');
    assert.ok(posix.command?.startsWith('BRAINCLAW_CLAIM_ID=clm_posix '), 'POSIX command uses inline env prefix');

    const win = await withPlatform('win32', () => attemptExecution(invoke, {
      agent: 'codex',
      autoExecute: false,
      dispatcherAgent: 'test',
      claimId: 'clm_win',
    }));
    assert.equal(win.execution_status, 'command_ready_manual');
    assert.ok(win.command?.startsWith('set BRAINCLAW_CLAIM_ID=clm_win && '), 'Windows command uses cmd-style env prefix');
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

// ── Mock adapter: spawn success and failure paths ──────────

describe('attemptExecution with mock adapter', () => {
  const invoke = buildInvokeCommand('claude-code', 'test prompt')!;

  it('delivered_and_started with successful mock adapter', async () => {
    const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
      id: 'mock',
      canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
      prepareManualCommand: () => ({ command: 'mock-cmd', shell: 'bash' }),
      start: () => ({ pid: 99999, started_at: '2026-04-13T00:00:00Z', status: 'started' }),
    };
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: true,
      dispatcherAgent: 'test',
      adapter: mockAdapter,
    });
    assert.equal(result.execution_status, 'delivered_and_started');
    assert.equal(result.pid, 99999);
  });

  it('falls back to command_ready_manual when mock adapter.start() throws', async () => {
    const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
      id: 'mock-fail',
      canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
      prepareManualCommand: () => ({ command: 'fallback-cmd', shell: 'bash' }),
      start: () => { throw new Error('spawn failed on purpose'); },
    };
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: true,
      dispatcherAgent: 'test',
      adapter: mockAdapter,
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.ok(result.error?.includes('spawn failed on purpose'));
    assert.equal(result.command, 'fallback-cmd');
  });

  it('supports async adapter.start() returning a Promise', async () => {
    const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
      id: 'mock-async',
      canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
      prepareManualCommand: () => ({ command: 'mock-cmd', shell: 'bash' }),
      start: async () => ({ pid: 42, started_at: '2026-04-13T00:00:00Z', status: 'started' as const }),
    };
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: true,
      dispatcherAgent: 'test',
      adapter: mockAdapter,
    });
    assert.equal(result.execution_status, 'delivered_and_started');
    assert.equal(result.pid, 42);
  });

  it('canSpawn=false returns command_ready_manual even with autoExecute=true', async () => {
    const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
      id: 'mock-nospawn',
      canSpawn: () => ({ canSpawn: false, reason: 'not allowed' }),
      prepareManualCommand: () => ({ command: 'manual-only', shell: 'bash' }),
      start: () => { throw new Error('should not be called'); },
    };
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: true,
      dispatcherAgent: 'test',
      adapter: mockAdapter,
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.equal(result.command, 'manual-only');
  });
});
