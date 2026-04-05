import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanResource } from '../../src/commands/plan-resource.js';
import { runUpdatePlan } from '../../src/commands/update-plan.js';
import { createPlan } from '../../src/core/operations/plan.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureCommand(fn: () => void): { logs: string[]; errors: string[]; exitCode?: number } {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  }) as typeof process.exit;

  try {
    fn();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.startsWith('exit:')) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { logs, errors, exitCode };
}

describe('plan resource command', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-plan-resource-',
      projectId: 'prj_plan_resource_test',
      currentAgent: 'copilot',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
  });

  it('accepts plan get as an alias for plan show', () => {
    const plan = createPlan({
      text: 'Task with readable alias',
      author: workspace.currentAgent.agent_name,
      priority: 'medium',
    }, workspace.dir);

    const result = captureCommand(() => {
      runPlanResource('get', [plan.id], { cwd: workspace.dir });
    });

    assert.equal(result.exitCode, undefined);
    assert.ok(result.logs.some((line) => line.includes(`Plan: ${plan.id}`)));
    assert.ok(result.logs.some((line) => line.includes('Task with readable alias')));
  });

  it('reports a step-id specific error for stp_* ids', () => {
    const result = captureCommand(() => {
      runUpdatePlan('stp_fb421ebf', { status: 'done', cwd: workspace.dir });
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((line) => line.includes('looks like a step ID')));
    assert.ok(result.errors.some((line) => line.includes('complete-step')));
  });
});
