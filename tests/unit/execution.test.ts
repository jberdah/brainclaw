/**
 * Tests for src/core/execution.ts — E2E dispatch execution engine.
 *
 * Covers: canSpawnAgent, executeDispatchedCommand, attemptExecution
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canSpawnAgent, attemptExecution, getAssignmentAckPath, type ExecutionResult } from '../../src/core/execution.js';
import { buildInvokeCommand, type InvokeCommand } from '../../src/core/agent-capability.js';
import { defaultExecutionAdapter } from '../../src/core/execution-adapters.js';
import { CoordinateRequestSchema, ExecutionStatusSchema } from '../../src/core/facade-schema.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-execution-test-'));
  const bc = path.join(dir, '.brainclaw');
  for (const sub of [
    'coordination/assignments',
    'coordination/runs',
    'coordination/claims',
    'coordination/sessions',
    'coordination/inbox',
  ]) {
    fs.mkdirSync(path.join(bc, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(bc, 'config.yaml'), 'project_id: prj_execution\n');
  return dir;
}

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
    // claude-code and codex have canBeSpawnedCli=true + invoke_template
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

  it('builds codex invoke commands with stdin_pipe delivery (pln#475)', () => {
    const invoke = buildInvokeCommand('codex', 'compact worker brief');
    assert.ok(invoke, 'codex should produce an invoke command');
    // pln#475: codex switched from inline_arg to stdin_pipe to avoid Windows
    // cmd.exe arg-parsing breaking long prompts (trp#59).
    assert.equal(invoke.promptDelivery, 'stdin_pipe');
    assert.equal(invoke.promptText, 'compact worker brief', 'prompt is delivered via stdin');
    assert.ok(!invoke.args.includes('compact worker brief'), 'prompt is not in args');
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
    // Shell field: 'cmd' on Windows, 'bash' when invoke.shell=true on POSIX, else 'sh'
    const expectedShell = process.platform === 'win32' ? 'cmd' : (invoke.shell ? 'bash' : 'sh');
    assert.equal(result.shell, expectedShell);
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
    assert.equal(posix.shell, 'sh');

    const win = await withPlatform('win32', () => attemptExecution(invoke, {
      agent: 'codex',
      autoExecute: false,
      dispatcherAgent: 'test',
      claimId: 'clm_win',
    }));
    assert.equal(win.execution_status, 'command_ready_manual');
    assert.ok(win.command?.startsWith('set BRAINCLAW_CLAIM_ID=clm_win && '), 'Windows command uses cmd-style env prefix');
    assert.equal(win.shell, 'cmd');
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

  it('falls back when spawned process never handshakes the assignment', async () => {
    const testDir = createTestStore();
    try {
      createAssignment({
        id: 'asgn_no_handshake',
        short_label: 'asgn#nh',
        claim_id: 'clm_no_handshake',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/no-handshake.ts',
        description: 'No handshake test',
      }, testDir);

      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-no-handshake',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'fallback-cmd', shell: 'bash' }),
        start: () => ({ pid: 1234, started_at: '2026-04-14T00:00:00Z', status: 'started' }),
      };

      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId: 'asgn_no_handshake',
        cwd: testDir,
        handshakeTimeoutMs: 50,
        adapter: mockAdapter,
      });

      assert.equal(result.execution_status, 'command_ready_manual');
      assert.equal(result.command, 'fallback-cmd');
      assert.ok(result.error?.includes('did not acknowledge'));
      assert.equal(result.failure_kind, 'spawn_no_handshake');
      assert.equal(result.pid, 1234);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('handshake passes when brief-ack file exists (pln#476)', async () => {
    const testDir = createTestStore();
    try {
      const assignmentId = 'asgn_with_ack';
      createAssignment({
        id: assignmentId,
        short_label: 'asgn#ack',
        claim_id: 'clm_with_ack',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/ack.ts',
        description: 'Brief-ack test',
      }, testDir);

      // Mock adapter writes the ack file synchronously inside start() to
      // simulate what CliExecutionAdapter does via the shell wrap.
      const ackPath = getAssignmentAckPath(testDir, assignmentId);
      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-ack',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'fallback', shell: 'bash' }),
        start: () => {
          fs.mkdirSync(path.dirname(ackPath), { recursive: true });
          fs.writeFileSync(ackPath, '');
          return { pid: 7777, started_at: '2026-04-25T00:00:00Z', status: 'started' };
        },
      };

      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId,
        cwd: testDir,
        handshakeTimeoutMs: 200, // small but enough for the first poll
        adapter: mockAdapter,
      });

      // Worker NEVER called bclaw_assignment_update — assignment.status is still 'offered'.
      // The ack file alone should satisfy the handshake.
      assert.equal(result.execution_status, 'delivered_and_started', 'spawn accepted via ack file');
      assert.equal(result.pid, 7777);
      assert.ok(fs.existsSync(ackPath), 'ack file persists post-handshake');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('getAssignmentAckPath builds correct path (pln#476)', () => {
    const ack = getAssignmentAckPath('/proj', 'asgn_xyz');
    assert.ok(ack.endsWith(path.join('coordination', 'runtime', 'ack', 'asgn_xyz.ack')));
    assert.ok(ack.includes('.brainclaw'));
  });

  it('handshake TTL honors BRAINCLAW_HANDSHAKE_TIMEOUT_MS env var (pln#475)', async () => {
    const testDir = createTestStore();
    const prev = process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS;
    try {
      // Set env to a tiny TTL so the test runs fast
      process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS = '50';
      createAssignment({
        id: 'asgn_env_ttl',
        short_label: 'asgn#env',
        claim_id: 'clm_env_ttl',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/env-ttl.ts',
        description: 'Env TTL test',
      }, testDir);

      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-env-ttl',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'fallback', shell: 'bash' }),
        start: () => ({ pid: 5555, started_at: '2026-04-25T00:00:00Z', status: 'started' }),
      };

      const start = Date.now();
      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId: 'asgn_env_ttl',
        cwd: testDir,
        // No handshakeTimeoutMs override → env var path used
        adapter: mockAdapter,
      });
      const elapsed = Date.now() - start;

      assert.equal(result.failure_kind, 'spawn_no_handshake');
      assert.ok(result.error?.includes('50ms'), `expected 50ms in error, got: ${result.error}`);
      assert.ok(elapsed < 5000, `env var should yield fast timeout, got ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS;
      else process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS = prev;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('explicit handshakeTimeoutMs option wins over env var (pln#475)', async () => {
    const testDir = createTestStore();
    const prev = process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS;
    try {
      // Env says 60000ms but option says 50ms — option wins, test stays fast.
      process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS = '60000';
      createAssignment({
        id: 'asgn_opt_ttl',
        short_label: 'asgn#opt',
        claim_id: 'clm_opt_ttl',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/opt-ttl.ts',
        description: 'Option TTL test',
      }, testDir);

      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-opt-ttl',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'fallback', shell: 'bash' }),
        start: () => ({ pid: 6666, started_at: '2026-04-25T00:00:00Z', status: 'started' }),
      };

      const start = Date.now();
      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId: 'asgn_opt_ttl',
        cwd: testDir,
        handshakeTimeoutMs: 50,
        adapter: mockAdapter,
      });
      const elapsed = Date.now() - start;

      assert.equal(result.failure_kind, 'spawn_no_handshake');
      assert.ok(result.error?.includes('50ms'), `expected 50ms (option), got: ${result.error}`);
      assert.ok(elapsed < 5000, `option should override env var, got ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS;
      else process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS = prev;
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps delivered_and_started when assignment handshake arrives in time', async () => {
    const testDir = createTestStore();
    try {
      createAssignment({
        id: 'asgn_handshake',
        short_label: 'asgn#ok',
        claim_id: 'clm_handshake',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/handshake.ts',
        description: 'Handshake test',
      }, testDir);

      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-handshake',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'fallback-cmd', shell: 'bash' }),
        start: async () => ({ pid: 5678, started_at: '2026-04-14T00:00:00Z', status: 'started' as const }),
      };

      setTimeout(() => {
        transitionAssignment('asgn_handshake', 'offered', { actor: 'coordinator' }, testDir);
        transitionAssignment('asgn_handshake', 'accepted', { actor: 'claude-code' }, testDir);
      }, 10);

      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId: 'asgn_handshake',
        cwd: testDir,
        handshakeTimeoutMs: 200,
        adapter: mockAdapter,
      });

      assert.equal(result.execution_status, 'delivered_and_started');
      assert.equal(result.pid, 5678);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
