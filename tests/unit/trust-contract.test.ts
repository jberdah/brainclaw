import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReflect } from '../../src/commands/reflect.js';
import { runSetTrust } from '../../src/commands/set-trust.js';
import { acceptCandidate } from '../../src/commands/accept.js';
import { rejectCandidate } from '../../src/commands/reject.js';
import { listCandidates } from '../../src/core/candidates.js';
import { setAgentTrustLevel, setCurrentAgentIdentity } from '../../src/core/agent-registry.js';
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

describe('trust contract', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-trust-contract-',
      projectId: 'prj_trust_contract',
      currentAgent: 'copilot',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
  });

  it('bootstraps the first curator locally', () => {
    const result = captureCommand(() => {
      runSetTrust(workspace.currentAgent.agent_name, { level: 'curator', json: true });
    });

    assert.equal(result.errors.length, 0);
    const parsed = JSON.parse(result.logs[0] ?? '{}') as { trust_level?: string };
    assert.equal(parsed.trust_level, 'curator');
  });

  it('refuses trust changes from non-curator agents once an elevated agent exists', () => {
    setAgentTrustLevel(workspace.currentAgent.agent_name, 'curator', workspace.dir);
    const claude = workspace.registerAgent('claude');
    setCurrentAgentIdentity(claude, workspace.dir);

    const result = captureCommand(() => {
      runSetTrust(workspace.currentAgent.agent_name, { level: 'trusted' });
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((line) => line.includes('Insufficient trust')));
  });

  it('reserves accept and reject to trusted or curator identities', () => {
    runReflect('Contributor proposal', {
      type: 'decision',
      cwd: workspace.dir,
    });
    const candidateId = listCandidates('pending', workspace.dir)[0]?.id;
    assert.ok(candidateId);

    assert.throws(() => acceptCandidate(candidateId as string, workspace.currentAgent.agent_name, workspace.dir), /Insufficient trust/);
    assert.throws(() => rejectCandidate(candidateId as string, 'not now', workspace.currentAgent.agent_name, workspace.dir), /Insufficient trust/);

    setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
    assert.doesNotThrow(() => rejectCandidate(candidateId as string, 'not now', workspace.currentAgent.agent_name, workspace.dir));
  });
});
