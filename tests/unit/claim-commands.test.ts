import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runClaim } from '../../src/commands/claim.js';
import { runListClaims } from '../../src/commands/list-claims.js';
import { runReleaseClaim } from '../../src/commands/release-claim.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { generateMarkdown } from '../../src/core/markdown.js';
import { loadState, saveState } from '../../src/core/state.js';
import { setAgentTrustLevel } from '../../src/core/agent-registry.js';
import type { Claim } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function captureConsole(fn: () => void): { logs: string[]; warns: string[]; errors: string[] } {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
    throw new Error(args.map(String).join(' '));
  };

  try {
    fn();
    return { logs, warns, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe('claim commands', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-claim-',
      projectId: 'prj_claim_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates a claim, links it to a plan, and keeps live claims out of legacy project markdown', () => {
    const state = loadState(workspace.dir);
    state.plan_items.push({
      id: 'pln_auth_claim',
      text: 'Own auth rollout',
      created_at: iso(8),
      updated_at: iso(8),
      author: workspace.currentAgent.agent_name,
      status: 'todo',
      priority: 'high',
      project: 'auth',
      tags: ['auth'],
      depends_on: [],
    });
    saveState(state, workspace.dir);
    fs.writeFileSync(path.join(workspace.dir, '.brainclaw', 'project.md'), generateMarkdown(state, workspace.dir), 'utf-8');

    const previousSession = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_claim_test';
    try {
      const captured = captureConsole(() => {
        runClaim('Taking auth rollout', {
          scope: 'src/auth/',
          plan: 'pln_auth_claim',
          cwd: workspace.dir,
        });
      });

      assert.equal(captured.warns.length, 0);
      assert.ok(captured.logs[0].includes('Claim created'));
      const claimId = captured.logs[0].match(/\[(clm_[a-f0-9]+)\]/)?.[1];
      assert.ok(claimId);

      const claim = loadClaim(claimId as string, workspace.dir);
      assert.equal(claim.agent, workspace.currentAgent.agent_name);
      assert.equal(claim.plan_id, 'pln_auth_claim');
      assert.equal(claim.project, 'auth');
      assert.equal(claim.session_id, 'sess_claim_test');

      const updatedState = loadState(workspace.dir);
      assert.equal(updatedState.plan_items[0].assignee, workspace.currentAgent.agent_name);
      assert.equal(updatedState.plan_items[0].status, 'in_progress');

      const markdown = fs.readFileSync(path.join(workspace.dir, '.brainclaw', 'project.md'), 'utf-8');
      assert.ok(markdown.includes('Legacy derived summary'));
      assert.ok(!markdown.includes('Taking auth rollout'));
    } finally {
      if (previousSession === undefined) {
        delete process.env.BRAINCLAW_SESSION_ID;
      } else {
        process.env.BRAINCLAW_SESSION_ID = previousSession;
      }
    }
  });

  it('lists, filters, and releases claims through direct command calls', () => {
    const state = loadState(workspace.dir);
    state.plan_items.push({
      id: 'pln_release_claim',
      text: 'Finish auth rollout',
      created_at: iso(7),
      updated_at: iso(7),
      author: workspace.currentAgent.agent_name,
      status: 'in_progress',
      priority: 'medium',
      assignee: workspace.currentAgent.agent_name,
      project: 'auth',
      tags: ['auth'],
      depends_on: [],
    });
    saveState(state, workspace.dir);
    fs.writeFileSync(path.join(workspace.dir, '.brainclaw', 'project.md'), generateMarkdown(state, workspace.dir), 'utf-8');

    const activeClaims: Claim[] = [
      {
        id: 'clm_auth',
        agent: workspace.currentAgent.agent_name,
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_claim_test',
        scope: 'src/auth/',
        description: 'Own auth work',
        created_at: iso(5),
        project: 'auth',
        plan_id: 'pln_release_claim',
        status: 'active',
      },
      {
        id: 'clm_db',
        agent: 'claude',
        project_id: 'prj_claim_test',
        scope: 'src/db/',
        description: 'Own db work',
        created_at: iso(4),
        project: 'data',
        status: 'active',
      },
    ];
    for (const claim of activeClaims) {
      saveClaim(claim, workspace.dir);
    }

    const listAll = captureConsole(() => {
      runListClaims({ json: true, cwd: workspace.dir });
    });
    const parsedAll = JSON.parse(listAll.logs.at(-1) as string);
    assert.equal(parsedAll.length, 2);

    const filtered = captureConsole(() => {
      runListClaims({ json: true, agent: workspace.currentAgent.agent_name, plan: 'pln_release_claim', cwd: workspace.dir });
    });
    const parsedFiltered = JSON.parse(filtered.logs.at(-1) as string);
    assert.deepEqual(parsedFiltered.map((claim: { id: string }) => claim.id), ['clm_auth']);

    const released = captureConsole(() => {
      runReleaseClaim('clm_auth', { planStatus: 'done', cwd: workspace.dir });
    });
    assert.ok(released.logs[0].includes('released'));

    const releasedClaim = loadClaim('clm_auth', workspace.dir);
    assert.equal(releasedClaim.status, 'released');

    const updatedState = loadState(workspace.dir);
    assert.equal(updatedState.plan_items[0].status, 'done');
    assert.equal(updatedState.plan_items[0].assignee, undefined);
  });

  it('release-claim enforces ownership unless trusted coordinator override is explicit', () => {
    saveClaim({
      id: 'clm_foreign_cli',
      agent: 'claude',
      agent_id: 'agt_claude',
      project_id: 'prj_claim_test',
      scope: 'src/foreign-cli/',
      description: 'Foreign claim',
      created_at: iso(2),
      status: 'active',
    }, workspace.dir);

    assert.throws(() => {
      captureConsole(() => {
        runReleaseClaim('clm_foreign_cli', { cwd: workspace.dir });
      });
    }, /coordinator_override:true/);
    assert.equal(loadClaim('clm_foreign_cli', workspace.dir).status, 'active');

    assert.throws(() => {
      captureConsole(() => {
        runReleaseClaim('clm_foreign_cli', { cwd: workspace.dir, coordinatorOverride: true });
      });
    }, /Insufficient trust/);
    assert.equal(loadClaim('clm_foreign_cli', workspace.dir).status, 'active');

    setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
    const released = captureConsole(() => {
      runReleaseClaim('clm_foreign_cli', { cwd: workspace.dir, coordinatorOverride: true });
    });

    assert.ok(released.logs[0].includes('released'));
    assert.equal(loadClaim('clm_foreign_cli', workspace.dir).status, 'released');
  });

  it('rejects overlapping active claims on the same scope', () => {
    saveClaim({
      id: 'clm_existing',
      agent: 'claude',
      project_id: 'prj_claim_test',
      scope: 'src/auth/',
      description: 'Existing auth work',
      created_at: iso(3),
      status: 'active',
    }, workspace.dir);

    assert.throws(() => {
      captureConsole(() => {
        runClaim('Competing auth work', {
          agent: 'copilot',
          scope: 'src/auth/',
          cwd: workspace.dir,
        });
      });
    }, /Active claim already exists for scope "src\/auth\/"/);
  });
});
