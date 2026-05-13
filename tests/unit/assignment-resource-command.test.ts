import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAssignment, loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { runAssignmentResource } from '../../src/commands/assignment-resource.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = createTestWorkspace({ currentAgent: 'dispatcher' });
});

afterEach(() => {
  workspace.cleanup();
});

function captureOutput(fn: () => void): { stdout: string[]; stderr: string[]; exitCode: number | null } {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit.bind(process);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  (process as NodeJS.Process).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  try {
    fn();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('process.exit('))) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    (process as NodeJS.Process).exit = originalExit;
  }

  return { stdout, stderr, exitCode };
}

describe('assignment resource command', () => {
  it('lists only non-terminal assignments by default', () => {
    const active = createAssignment({
      claim_id: 'clm_assignment_cmd_1',
      agent: 'worker-a',
      dispatcher_agent: 'dispatcher',
      scope: 'src/active',
      description: 'Active assignment',
    }, workspace.dir);
    const cancelled = createAssignment({
      claim_id: 'clm_assignment_cmd_2',
      agent: 'worker-b',
      dispatcher_agent: 'dispatcher',
      scope: 'src/cancelled',
      description: 'Cancelled assignment',
    }, workspace.dir);
    transitionAssignment(cancelled.id, 'cancelled', { actor: 'dispatcher' }, workspace.dir);

    const { stdout } = captureOutput(() => {
      runAssignmentResource('list', [], { cwd: workspace.dir });
    });

    const output = stdout.join('\n');
    assert.ok(output.includes(active.id), output);
    assert.ok(!output.includes(cancelled.id), output);
  });

  it('cancels an assignment through the resource command', () => {
    const assignment = createAssignment({
      claim_id: 'clm_assignment_cmd_3',
      agent: 'worker-c',
      dispatcher_agent: 'dispatcher',
      scope: 'src/to-cancel',
      description: 'Needs cancellation',
    }, workspace.dir);

    const { stdout, exitCode } = captureOutput(() => {
      runAssignmentResource('cancel', [assignment.id], {
        cwd: workspace.dir,
        reason: 'Supervisor aborted the lane',
      });
    });

    assert.equal(exitCode, null);
    assert.ok(stdout.join('\n').includes('Assignment cancelled'));
    const reloaded = loadAssignment(assignment.id, workspace.dir);
    assert.equal(reloaded?.status, 'cancelled');
    assert.equal(reloaded?.status_reason, 'Supervisor aborted the lane');
  });
});
