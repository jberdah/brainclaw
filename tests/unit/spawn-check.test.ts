/**
 * pln#520 step 2 — `doctor --spawn-check` orchestration.
 *
 * Uses fake agent profiles backed by `node` (always on PATH in CI) + a probe
 * seam, so the real spawn → ack → completed/failed round-trip is exercised
 * without needing claude/codex installed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCapabilityProfile,
  type AgentCapabilityProfile,
  type InvokeCommand,
} from '../../src/core/agent-capability.js';
import { checkAgentSpawn, runSpawnCheck, renderSpawnCheckReport } from '../../src/core/spawn-check.js';

function fakeProfile(name: string, binary: string): AgentCapabilityProfile {
  return {
    name, category: 'autonomous-agent', workflowModel: 'task-based',
    hasMcp: false, hasHooks: false, hasAutoApprove: false, hasSkills: false, hasRules: false,
    instructionFile: 'AGENTS.md', sharedInstructionFile: false, mcpConfigScope: 'none', templateTier: 'C',
    role_capabilities: ['execute'],
    runtime: { mcp_direct: false, hooks: false, canBeSpawnedCli: true, canSpawnOtherCli: false, inbox: true },
    prompt_delivery: { methods: ['inline_arg'], preferred: 'inline_arg' },
    execution_env: { surface: 'cli' },
    max_concurrent_tasks: 1,
    invoke_template: `${binary} {prompt}`,
    invoke_binary: binary,
  };
}

function nodeInvoke(snippet: string): InvokeCommand {
  const isWin = process.platform === 'win32';
  const escaped = isWin ? snippet.replace(/"/g, '\\"') : snippet;
  return {
    executable: 'node', args: ['-e', escaped],
    bashCommand: `node -e "${escaped}"`,
    promptDelivery: 'inline_arg', shell: false,
  } as InvokeCommand;
}

describe('spawn-check (pln#520 step 2)', () => {
  it('a working agent round-trip → ok (delivered + completed)', async () => {
    registerCapabilityProfile(fakeProfile('probe-ok', 'node'));
    const entry = await checkAgentSpawn('probe-ok', {
      probeFor: () => nodeInvoke('console.log("OK");'),
      timeoutMs: 8000,
    });
    assert.equal(entry.status, 'ok', entry.detail);
    assert.equal(entry.delivered, true);
    assert.equal(entry.completed, true);
  });

  it('an agent that exits non-zero → failed (wrapper failed sentinel)', async () => {
    registerCapabilityProfile(fakeProfile('probe-fail', 'node'));
    const entry = await checkAgentSpawn('probe-fail', {
      probeFor: () => nodeInvoke('process.exit(2);'),
      timeoutMs: 8000,
    });
    assert.equal(entry.status, 'failed', entry.detail);
  });

  it('an agent whose binary is not on PATH → not_installed (skipped)', async () => {
    registerCapabilityProfile(fakeProfile('probe-missing', 'definitely-not-a-real-binary-zzz'));
    const entry = await checkAgentSpawn('probe-missing', { timeoutMs: 2000 });
    assert.equal(entry.status, 'not_installed');
    assert.equal(entry.delivered, false);
  });

  it('runSpawnCheck aggregates and sets exit_code on installed-agent failure', async () => {
    registerCapabilityProfile(fakeProfile('probe-ok2', 'node'));
    registerCapabilityProfile(fakeProfile('probe-fail2', 'node'));
    const report = await runSpawnCheck({
      agents: ['probe-ok2', 'probe-fail2', 'probe-missing'],
      timeoutMs: 8000,
      probeFor: (a) => a === 'probe-fail2' ? nodeInvoke('process.exit(1);') : nodeInvoke('console.log("OK");'),
    });
    assert.equal(report.ok, 1, JSON.stringify(report.entries));
    assert.equal(report.failures, 1);
    assert.equal(report.not_installed, 1);
    assert.equal(report.exit_code, 1);
    assert.ok(renderSpawnCheckReport(report).includes('spawn round-trip'));
  });
});
