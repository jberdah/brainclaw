/**
 * Tests: CLI list commands read via store chain (fix for trap trp_22030d7c)
 *
 * Verifies that `runListPlans`, `runListClaims`, and `runInboxList` aggregate
 * entities from all stores in the chain (not just the local store), and that
 * --local-only opts back to single-store behaviour.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runListPlans } from '../../src/commands/list-plans.js';
import { runListClaims } from '../../src/commands/list-claims.js';
import { runInboxList } from '../../src/commands/inbox.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { loadState, saveState } from '../../src/core/state.js';
import { saveClaim } from '../../src/core/claims.js';
import { sendMessage } from '../../src/core/messaging.js';
import { registerAgentIdentity, setCurrentAgentIdentity } from '../../src/core/agent-registry.js';
import type { PlanItem, Claim } from '../../src/core/schema.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix = 'bclaw-chain-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initStore(dir: string, projectName: string, projectId: string): void {
  ensureMemoryDir(dir);
  saveConfig(defaultConfig(projectName, { projectId }), dir);
}

function addPlan(dir: string, id: string, text: string): PlanItem {
  const state = loadState(dir);
  const plan: PlanItem = {
    id,
    text,
    status: 'todo',
    type: 'feat',
    priority: 'medium',
    tags: [],
    depends_on: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: 'test',
  };
  state.plan_items.push(plan);
  saveState(state, dir);
  return plan;
}

function addClaim(dir: string, id: string, scope: string): Claim {
  const claim: Claim = {
    id,
    agent: 'test-agent',
    agent_id: 'agt_test',
    project_id: 'prj_test',
    host_id: 'host_test',
    session_id: 'ses_test',
    scope,
    description: `Claim for ${scope}`,
    created_at: new Date().toISOString(),
    status: 'active',
  };
  saveClaim(claim, dir);
  return claim;
}

function captureOutput(fn: () => void): { stdout: string[]; exitCode: number | null } {
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit.bind(process);

  const stdout: string[] = [];
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stdout.push('[ERROR] ' + args.map(String).join(' '));
  (process as NodeJS.Process).exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    (process as NodeJS.Process).exit = origExit;
  }

  return { stdout, exitCode };
}

// ── test fixture: two-store chain ────────────────────────────────────────────
// wsDir (workspace root, depth 1 from repo)
//   └── repoDir (child, depth 0 — local store when running from here)

interface TwoStoreFixture {
  wsDir: string;
  repoDir: string;
  cleanup: () => void;
}

function createTwoStoreFixture(): TwoStoreFixture {
  const wsDir = makeTmpDir('bclaw-chain-ws-');
  const repoDir = path.join(wsDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  initStore(wsDir, 'workspace-project', 'prj_ws');
  initStore(repoDir, 'repo-project', 'prj_repo');

  // Isolate from user store above
  process.env.BRAINCLAW_STORE_BOUNDARY = wsDir;

  // Register a test agent in repoDir
  const agent = registerAgentIdentity({ agentName: 'test-agent', kind: 'agent', cwd: repoDir });
  setCurrentAgentIdentity(agent, repoDir);
  process.env.BRAINCLAW_AGENT_NAME = 'test-agent';
  process.env.BRAINCLAW_AGENT = 'test-agent';
  process.env.BRAINCLAW_AGENT_ID = agent.agent_id;

  // Also register agent in wsDir so claims/inbox work there
  registerAgentIdentity({ agentName: 'test-agent', kind: 'agent', cwd: wsDir });

  return {
    wsDir,
    repoDir,
    cleanup: () => {
      fs.rmSync(wsDir, { recursive: true, force: true });
      delete process.env.BRAINCLAW_STORE_BOUNDARY;
      delete process.env.BRAINCLAW_AGENT_NAME;
      delete process.env.BRAINCLAW_AGENT;
      delete process.env.BRAINCLAW_AGENT_ID;
    },
  };
}

// ── plan list ────────────────────────────────────────────────────────────────

describe('CLI plan list — store chain visibility', () => {
  let fixture: TwoStoreFixture;

  beforeEach(() => { fixture = createTwoStoreFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('sees plans in local store (repoDir)', () => {
    addPlan(fixture.repoDir, 'pln_local01', 'local plan');

    const { stdout } = captureOutput(() =>
      runListPlans({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('pln_local01'), `Expected pln_local01 in: ${output}`);
  });

  it('sees plans written to parent store (wsDir) by default — chain mode', () => {
    addPlan(fixture.wsDir, 'pln_parent01', 'parent plan from workspace');

    const { stdout } = captureOutput(() =>
      runListPlans({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('pln_parent01'), `Expected pln_parent01 visible via chain in: ${output}`);
  });

  it('does NOT see parent plans with --local-only', () => {
    addPlan(fixture.wsDir, 'pln_parent02', 'parent plan hidden by local-only');

    const { stdout } = captureOutput(() =>
      runListPlans({ cwd: fixture.repoDir, localOnly: true }),
    );

    const output = stdout.join('\n');
    assert.ok(!output.includes('pln_parent02'), `Expected pln_parent02 hidden in local-only mode: ${output}`);
  });

  it('shows both local and parent plans in chain mode', () => {
    addPlan(fixture.repoDir, 'pln_local03', 'local plan');
    addPlan(fixture.wsDir, 'pln_parent03', 'parent plan');

    const { stdout } = captureOutput(() =>
      runListPlans({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('pln_local03'), `Expected pln_local03 in: ${output}`);
    assert.ok(output.includes('pln_parent03'), `Expected pln_parent03 in: ${output}`);
  });

  it('deduplicates plans that appear in multiple stores', () => {
    // Same id in both stores (shouldn't normally happen, but guard against it)
    addPlan(fixture.repoDir, 'pln_dup01', 'plan in local');
    addPlan(fixture.wsDir, 'pln_dup01', 'plan in parent');

    const { stdout } = captureOutput(() =>
      runListPlans({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    const matches = (output.match(/pln_dup01/g) ?? []).length;
    assert.equal(matches, 1, `Expected exactly 1 occurrence of pln_dup01, got ${matches}: ${output}`);
  });
});

// ── claim list ───────────────────────────────────────────────────────────────

describe('CLI claim list — store chain visibility', () => {
  let fixture: TwoStoreFixture;

  beforeEach(() => { fixture = createTwoStoreFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('sees claims in local store (repoDir)', () => {
    addClaim(fixture.repoDir, 'clm_local01', 'src/local.ts');

    const { stdout } = captureOutput(() =>
      runListClaims({ cwd: fixture.repoDir }),
    );

    assert.ok(stdout.join('\n').includes('clm_local01'));
  });

  it('sees claims written to parent store (wsDir) by default — chain mode', () => {
    addClaim(fixture.wsDir, 'clm_parent01', 'src/shared.ts');

    const { stdout } = captureOutput(() =>
      runListClaims({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('clm_parent01'), `Expected clm_parent01 via chain in: ${output}`);
  });

  it('does NOT see parent claims with --local-only', () => {
    addClaim(fixture.wsDir, 'clm_parent02', 'src/hidden.ts');

    const { stdout } = captureOutput(() =>
      runListClaims({ cwd: fixture.repoDir, localOnly: true }),
    );

    const output = stdout.join('\n');
    assert.ok(!output.includes('clm_parent02'), `Expected clm_parent02 hidden in local-only mode: ${output}`);
  });

  it('shows both local and parent claims in chain mode', () => {
    addClaim(fixture.repoDir, 'clm_local03', 'src/local.ts');
    addClaim(fixture.wsDir, 'clm_parent03', 'src/parent.ts');

    const { stdout } = captureOutput(() =>
      runListClaims({ cwd: fixture.repoDir }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('clm_local03'), `Expected clm_local03 in: ${output}`);
    assert.ok(output.includes('clm_parent03'), `Expected clm_parent03 in: ${output}`);
  });
});

// ── inbox list ───────────────────────────────────────────────────────────────

describe('CLI inbox list — store chain visibility', () => {
  let fixture: TwoStoreFixture;

  beforeEach(() => { fixture = createTwoStoreFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('sees messages in local store (repoDir)', () => {
    sendMessage({ from: 'sender', to: 'test-agent', type: 'info', text: 'local message' }, fixture.repoDir);

    const { stdout } = captureOutput(() =>
      runInboxList({ cwd: fixture.repoDir, agent: 'test-agent', all: true }),
    );

    assert.ok(stdout.join('\n').includes('local message'));
  });

  it('sees messages written to parent store (wsDir) by default — chain mode', () => {
    sendMessage({ from: 'coordinator', to: 'test-agent', type: 'assign', text: 'dispatch from workspace' }, fixture.wsDir);

    const { stdout } = captureOutput(() =>
      runInboxList({ cwd: fixture.repoDir, agent: 'test-agent', all: true }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('dispatch from workspace'), `Expected parent message via chain in: ${output}`);
  });

  it('does NOT see parent messages with --local-only', () => {
    sendMessage({ from: 'coordinator', to: 'test-agent', type: 'assign', text: 'hidden parent message' }, fixture.wsDir);

    const { stdout } = captureOutput(() =>
      runInboxList({ cwd: fixture.repoDir, agent: 'test-agent', all: true, localOnly: true }),
    );

    const output = stdout.join('\n');
    assert.ok(!output.includes('hidden parent message'), `Expected parent message hidden in local-only mode: ${output}`);
  });

  it('shows messages from both stores in chain mode', () => {
    sendMessage({ from: 'sender', to: 'test-agent', type: 'info', text: 'local msg' }, fixture.repoDir);
    sendMessage({ from: 'coordinator', to: 'test-agent', type: 'assign', text: 'parent msg' }, fixture.wsDir);

    const { stdout } = captureOutput(() =>
      runInboxList({ cwd: fixture.repoDir, agent: 'test-agent', all: true }),
    );

    const output = stdout.join('\n');
    assert.ok(output.includes('local msg'), `Expected local msg in: ${output}`);
    assert.ok(output.includes('parent msg'), `Expected parent msg in: ${output}`);
  });
});
