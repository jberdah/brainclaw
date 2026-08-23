/**
 * Tests for src/core/execution.ts — E2E dispatch execution engine.
 *
 * Covers: canSpawnAgent, executeDispatchedCommand, attemptExecution
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canSpawnAgent, attemptExecution, getAssignmentAckPath, type ExecutionResult } from '../../src/core/execution.js';
import { buildInvokeCommand, type InvokeCommand } from '../../src/core/agent-capability.js';
import { buildAckWrapCommand, defaultExecutionAdapter, writeContractBootstrapScript } from '../../src/core/execution-adapters.js';
import { CoordinateRequestSchema, ExecutionStatusSchema } from '../../src/core/facade-schema.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';

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
  it('uses an environment-attesting bootstrap and exact terminal hashes on POSIX and Windows', () => {
    const hashes = {
      contract_hash: 'a'.repeat(64),
      capability_snapshot_hash: 'b'.repeat(64),
    };
    const paths = {
      ackPath: 'runtime/ack',
      completedPath: 'runtime/completed',
      failedPath: 'runtime/failed',
      stdoutLog: 'runtime/stdout.log',
      stderrLog: 'runtime/stderr.log',
      contractBootstrapPath: 'runtime/contract-bootstrap.cjs',
    };
    for (const isWin32 of [false, true]) {
      const command = buildAckWrapCommand('agent-command', paths, isWin32, {
        turn_id: 'tat_contract',
        run_id: 'run_contract',
        nonce: 'nonce_contract',
        ...hashes,
      });
      assert.match(command, /contract-bootstrap\.cjs/);
      assert.match(command, new RegExp(`"contract_hash":"${hashes.contract_hash}"`));
      assert.match(command, new RegExp(`"capability_snapshot_hash":"${hashes.capability_snapshot_hash}"`));
      assert.match(command, /"status":"completed"/);
      assert.match(command, /"status":"failed"/);
    }
  });

  it('bootstrap records the effective child environment and rejects an override mismatch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-contract-bootstrap-'));
    try {
      const scriptPath = path.join(dir, 'bootstrap.cjs');
      const ackPath = path.join(dir, 'ack.json');
      const expectedContract = 'a'.repeat(64);
      const expectedSnapshot = 'b'.repeat(64);
      writeContractBootstrapScript(scriptPath);

      const identity = ['tat_bootstrap', 'run_bootstrap', 'nonce_bootstrap'] as const;
      const accepted = spawnSync(process.execPath, [scriptPath, ackPath, ...identity, expectedContract, expectedSnapshot], {
        env: {
          ...process.env,
          BRAINCLAW_EXECUTION_CONTRACT_HASH: expectedContract,
          BRAINCLAW_CAPABILITY_SNAPSHOT_HASH: expectedSnapshot,
        },
      });
      assert.equal(accepted.status, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(ackPath, 'utf8')), {
        status: 'accepted',
        turn_id: identity[0],
        run_id: identity[1],
        nonce: identity[2],
        contract_hash: expectedContract,
        capability_snapshot_hash: expectedSnapshot,
      });

      fs.rmSync(ackPath);
      const rejected = spawnSync(process.execPath, [scriptPath, ackPath, ...identity, expectedContract, expectedSnapshot], {
        env: {
          ...process.env,
          BRAINCLAW_EXECUTION_CONTRACT_HASH: '0'.repeat(64),
          BRAINCLAW_CAPABILITY_SNAPSHOT_HASH: expectedSnapshot,
        },
      });
      assert.equal(rejected.status, 78);
      assert.deepEqual(JSON.parse(fs.readFileSync(ackPath, 'utf8')), {
        status: 'rejected',
        turn_id: identity[0],
        run_id: identity[1],
        nonce: identity[2],
        contract_hash: '0'.repeat(64),
        capability_snapshot_hash: expectedSnapshot,
      });
      const repeated = spawnSync(process.execPath, [scriptPath, ackPath, ...identity, expectedContract, expectedSnapshot], {
        env: {
          ...process.env,
          BRAINCLAW_EXECUTION_CONTRACT_HASH: expectedContract,
          BRAINCLAW_CAPABILITY_SNAPSHOT_HASH: expectedSnapshot,
        },
      });
      assert.equal(repeated.status, 79, 'an existing generation ack atomically refuses a second launch');
      assert.equal(JSON.parse(fs.readFileSync(ackPath, 'utf8')).status, 'rejected', 'the first anomaly remains monotone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('wraps a contracted manual command with the same bootstrap and terminal sentinels', () => {
    const dir = createTestStore();
    try {
      const invoke = buildInvokeCommand('codex', 'manual contract');
      assert.ok(invoke);
      const manual = defaultExecutionAdapter.prepareManualCommand(invoke, {
        agent: 'codex',
        claimId: 'clm_manual_contract',
        assignmentId: 'asgn_manual_contract',
        ackRoot: dir,
        turnEcho: {
          turn_id: 'tat_manual_contract',
          run_id: 'run_manual_contract',
          nonce: 'nonce_manual_contract',
          contract_hash: 'a'.repeat(64),
          capability_snapshot_hash: 'b'.repeat(64),
        },
      });
      assert.equal(manual.contractWrapped, true);
      assert.match(manual.command, /BRAINCLAW_EXECUTION_CONTRACT_HASH/);
      assert.match(manual.command, /BRAINCLAW_CAPABILITY_SNAPSHOT_HASH/);
      assert.match(manual.command, /bootstrap\.cjs/);
      assert.match(manual.command, /nonce_manual_contract/);
      assert.ok(fs.existsSync(`${getAssignmentAckPath(dir, 'asgn_manual_contract')}.bootstrap.cjs`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
    // pln#626 Phase 1 — a deliberate manual handoff is NOT a failure: it must
    // carry the auto_execute_disabled reason and NEITHER an error NOR a
    // failure_kind. (Guards against re-merging the two split branches.)
    assert.equal(result.execution_reason, 'auto_execute_disabled');
    assert.equal(result.failure_kind, undefined, 'auto_execute_disabled must carry no failure_kind');
    assert.equal(result.error, undefined, 'auto_execute_disabled is not an error');
  });

  it('returns only a contract-wrapped command for a contracted manual turn', async () => {
    const dir = createTestStore();
    try {
      const invoke = buildInvokeCommand('claude-code', 'contracted manual prompt')!;
      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: false,
        dispatcherAgent: 'test',
        assignmentId: 'asgn_contract_manual',
        cwd: dir,
        turnEcho: {
          turn_id: 'tat_contract_manual',
          run_id: 'run_contract_manual',
          nonce: 'nonce_contract_manual',
          contract_hash: 'a'.repeat(64),
          capability_snapshot_hash: 'b'.repeat(64),
        },
      });
      assert.equal(result.execution_status, 'command_ready_manual');
      assert.match(result.command ?? '', /bootstrap\.cjs/);
      assert.match(result.command ?? '', /BRAINCLAW_EXECUTION_CONTRACT_HASH/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not trust a custom adapter self-declaring an opaque manual command as wrapped', async () => {
    const dir = createTestStore();
    const adapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
      id: 'untrusted-manual-wrapper',
      canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
      prepareManualCommand: () => ({ command: 'raw-worker-command', shell: 'bash', contractWrapped: true }),
      start: () => { throw new Error('not reached'); },
    };
    try {
      const result = await attemptExecution(buildInvokeCommand('claude-code', 'opaque manual')!, {
        agent: 'claude-code', autoExecute: false, dispatcherAgent: 'test', adapter,
        assignmentId: 'asgn_untrusted_manual', cwd: dir,
        turnEcho: {
          turn_id: 'tat_untrusted_manual', run_id: 'run_untrusted_manual', nonce: 'nonce_untrusted_manual',
          contract_hash: 'a'.repeat(64), capability_snapshot_hash: 'b'.repeat(64),
        },
      });
      assert.equal(result.execution_status, 'inbox_only');
      assert.equal(result.failure_kind, 'contract_acceptance_anomaly');
      assert.equal(result.command, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      // pln#626 Phase 1 — an autoExecute request that cannot spawn IS a failure
      // of the caller's intent: surface failure_kind + reason + the dropped
      // spawnCheck.reason as error, instead of a silent bare manual command.
      assert.equal(result.failure_kind, 'not_spawnable');
      assert.equal(result.execution_reason, 'not_spawnable');
      assert.match(result.error ?? '', /BRAINCLAW_NO_SPAWN/);
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

  it('pln#531 — refuses to spawn a worker when a worktree is required but missing', async () => {
    const invoke = buildInvokeCommand('claude-code', 'test prompt');
    assert.ok(invoke);
    const result = await attemptExecution(invoke, {
      agent: 'claude-code',
      autoExecute: true,
      requireWorktree: true,
      // worktreePath intentionally omitted → must NOT fall back to the integration cwd
      dispatcherAgent: 'test',
      cwd: process.cwd(),
    });
    assert.equal(result.execution_status, 'command_ready_manual');
    assert.equal(result.failure_kind, 'spawn_no_worktree');
    assert.match(result.error ?? '', /worktree/i);
    assert.ok(result.command, 'still returns the command for manual isolated execution');
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

  it('withholds convergence without respawning when a crossed worker acknowledges the wrong contract', async () => {
    const testDir = createTestStore();
    try {
      const assignmentId = 'asgn_contract_mismatch';
      createAssignment({
        id: assignmentId,
        short_label: 'asgn#contract',
        claim_id: 'clm_contract',
        agent: 'claude-code',
        dispatcher_agent: 'coordinator',
        scope: 'src/contract.ts',
        description: 'Contract acceptance test',
      }, testDir);
      createAgentRun({
        id: 'run_contract',
        short_label: 'run#contract',
        assignment_id: assignmentId,
        claim_id: 'clm_contract',
        agent: 'claude-code',
        transport: 'cli_spawn',
        scope: 'src/contract.ts',
        description: 'Contract acceptance test',
        status: 'created',
      }, testDir);
      const ackPath = getAssignmentAckPath(testDir, assignmentId);
      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-contract-mismatch',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'must-not-respawn', shell: 'bash' }),
        start: () => {
          fs.mkdirSync(path.dirname(ackPath), { recursive: true });
          fs.writeFileSync(ackPath, JSON.stringify({
            status: 'accepted',
            turn_id: 'tat_contract',
            run_id: 'run_contract',
            nonce: 'nonce_contract',
            contract_hash: '0'.repeat(64),
            capability_snapshot_hash: '2'.repeat(64),
          }));
          return { pid: 8888, started_at: '2026-08-23T00:00:00Z', status: 'started' };
        },
      };
      const result = await attemptExecution(invoke, {
        agent: 'claude-code',
        autoExecute: true,
        dispatcherAgent: 'test',
        assignmentId,
        cwd: testDir,
        handshakeTimeoutMs: 200,
        adapter: mockAdapter,
        turnEcho: {
          turn_id: 'tat_contract',
          run_id: 'run_contract',
          nonce: 'nonce_contract',
          contract_hash: '1'.repeat(64),
          capability_snapshot_hash: '2'.repeat(64),
        },
      });
      assert.equal(result.execution_status, 'delivered_and_started');
      assert.equal(result.failure_kind, 'contract_acceptance_anomaly');
      assert.equal(result.execution_reason, 'contract_acceptance_anomaly');
      assert.match(result.error ?? '', /MUST NOT be respawned/);
      assert.equal(result.command, undefined, 'a process that crossed is never offered as a manual retry');
      assert.equal(loadAgentRun('run_contract', testDir)?.execution_contract_anomaly?.source, 'bootstrap_ack');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('never offers manual respawn after a contracted process misses its bootstrap handshake', async () => {
    const testDir = createTestStore();
    try {
      const assignmentId = 'asgn_contract_no_ack';
      createAssignment({
        id: assignmentId, claim_id: 'clm_contract_no_ack', agent: 'claude-code', dispatcher_agent: 'coordinator',
        scope: 'src/no-ack.ts', description: 'No contract ack',
      }, testDir);
      createAgentRun({
        id: 'run_contract_no_ack', assignment_id: assignmentId, claim_id: 'clm_contract_no_ack',
        agent: 'claude-code', transport: 'cli_spawn', scope: 'src/no-ack.ts', description: 'No contract ack', status: 'created',
      }, testDir);
      const mockAdapter: import('../../src/core/execution-adapters.js').ExecutionAdapter = {
        id: 'mock-contract-no-ack',
        canSpawn: () => ({ canSpawn: true, reason: 'mock' }),
        prepareManualCommand: () => ({ command: 'unsafe-second-launch', shell: 'bash', contractWrapped: true }),
        start: () => ({ pid: 9998, started_at: '2026-08-23T00:00:00Z', status: 'started' }),
      };
      const result = await attemptExecution(invoke, {
        agent: 'claude-code', autoExecute: true, dispatcherAgent: 'test', assignmentId, cwd: testDir,
        handshakeTimeoutMs: 50, adapter: mockAdapter,
        turnEcho: {
          turn_id: 'tat_contract_no_ack', run_id: 'run_contract_no_ack', nonce: 'nonce_contract_no_ack',
          contract_hash: '1'.repeat(64), capability_snapshot_hash: '2'.repeat(64),
        },
      });
      assert.equal(result.execution_status, 'delivered_and_started');
      assert.equal(result.failure_kind, 'contract_acceptance_anomaly');
      assert.equal(result.command, undefined);
      assert.equal(loadAgentRun('run_contract_no_ack', testDir)?.execution_contract_anomaly?.source, 'bootstrap_ack');
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
