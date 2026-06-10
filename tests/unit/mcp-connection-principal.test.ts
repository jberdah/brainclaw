import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { executeMcpToolCall, __resetConnectionPrincipalForTests } from '../../src/commands/mcp.js';
import { registerAgentIdentity, setAgentTrustLevel } from '../../src/core/agent-registry.js';
import { saveClaim, generateClaimId } from '../../src/core/claims.js';
import { loadState } from '../../src/core/state.js';

// pln#562 step 3 — authenticated connection principal: identity is pinned from
// server-side facts (claim binding, env detection), caller args cannot spoof
// it, and author resolution failure is a hard validation_error.
describe('MCP connection principal (pln#562 step 3)', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  async function createDecision(extraArgs: Record<string, unknown> = {}) {
    return executeMcpToolCall({
      name: 'bclaw_create',
      args: { entity: 'decision', data: { text: 'principal test decision' }, ...extraArgs },
      cwd: workspace.dir,
    });
  }

  function lastDecisionAuthor(): string | undefined {
    const decisions = loadState(workspace.dir).recent_decisions;
    return decisions[decisions.length - 1]?.author;
  }

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-principal-' });
    restoreCwd = workspace.useCwd();
    // createTestWorkspace pins the env to its default 'testuser' identity;
    // these tests control identity explicitly.
    delete process.env.BRAINCLAW_AGENT;
    delete process.env.BRAINCLAW_AGENT_NAME;
    delete process.env.BRAINCLAW_AGENT_ID;
    __resetConnectionPrincipalForTests();
  });

  afterEach(() => {
    __resetConnectionPrincipalForTests();
    restoreCwd();
    workspace.cleanup();
  });

  it('resolveCanonicalAuthor failure is a hard validation_error, not author:unknown', async () => {
    // No env identity, no detected agent, no args.agent → must refuse loudly.
    const outcome = await createDecision();
    assert.equal(outcome.response.isError, true);
    const text = outcome.response.content?.[0]?.text ?? '';
    assert.match(text, /cannot resolve mutation author/);
    assert.equal(loadState(workspace.dir).recent_decisions.length, 0, 'no record written');
  });

  it('non-curator caller args.agent cannot spoof the pinned principal', async () => {
    registerAgentIdentity({ agentName: 'claude-code', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
    registerAgentIdentity({ agentName: 'codex', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
    process.env.BRAINCLAW_AGENT_NAME = 'claude-code';
    process.env.BRAINCLAW_AGENT = 'claude-code';

    const outcome = await createDecision({ agent: 'codex' });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    assert.equal(lastDecisionAuthor(), 'claude-code', 'mutation attributed to the pinned principal, not the spoofed arg');
  });

  it('curator principal may explicitly override with args.agent', async () => {
    registerAgentIdentity({ agentName: 'claude-code', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
    registerAgentIdentity({ agentName: 'codex', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
    setAgentTrustLevel('claude-code', 'curator', workspace.dir);
    process.env.BRAINCLAW_AGENT_NAME = 'claude-code';
    process.env.BRAINCLAW_AGENT = 'claude-code';

    const outcome = await createDecision({ agent: 'codex' });
    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    assert.equal(lastDecisionAuthor(), 'codex', 'curator override honored');
  });

  it('BRAINCLAW_CLAIM_ID binds the principal to the dispatched identity', async () => {
    const codex = registerAgentIdentity({ agentName: 'codex', kind: 'agent', trustLevel: 'contributor', cwd: workspace.dir });
    const claimId = generateClaimId();
    saveClaim({
      id: claimId,
      agent: 'codex',
      agent_id: codex.agent_id,
      scope: 'src/test-scope',
      description: 'principal binding test',
      created_at: new Date().toISOString(),
      status: 'active',
    }, workspace.dir);
    process.env.BRAINCLAW_CLAIM_ID = claimId;

    try {
      const outcome = await createDecision();
      assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
      assert.equal(lastDecisionAuthor(), 'codex', 'mutation attributed to the claim-bound identity');
    } finally {
      delete process.env.BRAINCLAW_CLAIM_ID;
    }
  });
});
