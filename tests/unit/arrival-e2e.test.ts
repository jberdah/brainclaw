/**
 * E2E coverage of the two arrival paths (pln#557 step 5):
 *
 *   (a) fresh agent on a MATURE store → first bclaw_work returns an arrival
 *       digest (no event replay), seeds the cursor at log end, surfaces dead
 *       related_paths in stale_warnings, and stays under the first-contact
 *       token budget (< 2k tokens ≈ 8 KB serialized).
 *   (b) fresh agent on an EMPTY store over a brownfield repo → the single
 *       empty-memory decision rule routes to extraction (bclaw_bootstrap)
 *       and the scanner yields typed suggestions; same token budget.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { appendEvent } from '../../src/core/event-log.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

const TOKEN_BUDGET_CHARS = 8000; // < 2k tokens at ~4 chars/token

async function callWork(workspace: TestWorkspace, args: Record<string, unknown> = {}): Promise<{ facade: FacadeResponse; serializedLength: number }> {
  const outcome = await executeMcpToolCall({ name: 'bclaw_work', args: { intent: 'consult', ...args }, cwd: workspace.dir });
  const facade = outcome.response.structuredContent as FacadeResponse;
  return { facade, serializedLength: JSON.stringify(outcome.response.structuredContent).length };
}

function actAsFreshAgent(workspace: TestWorkspace, name: string): () => void {
  const identity = workspace.registerAgent(name);
  const saved = {
    BRAINCLAW_AGENT: process.env.BRAINCLAW_AGENT,
    BRAINCLAW_AGENT_NAME: process.env.BRAINCLAW_AGENT_NAME,
    BRAINCLAW_AGENT_ID: process.env.BRAINCLAW_AGENT_ID,
  };
  process.env.BRAINCLAW_AGENT = identity.agent_name;
  process.env.BRAINCLAW_AGENT_NAME = identity.agent_name;
  process.env.BRAINCLAW_AGENT_ID = identity.agent_id;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('arrival e2e — fresh agent on a mature store', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreAgent: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-arrival-e2e-', projectId: 'prj_arrival_e2e', currentAgent: 'veteran' });
  });

  afterEach(() => {
    restoreAgent?.();
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('first bclaw_work returns the arrival digest + dead-ref warnings within budget; second call is incremental', async () => {
    // Mature store: PROJECT.md present (so no bootstrap hint), active state,
    // one decision pointing at a deleted file, and a heavy event history.
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '# Arrival demo\n\nVision text.\n', 'utf8');
    const now = new Date().toISOString();
    const base = { created_at: now, author: 'veteran', author_id: workspace.currentAgent.agent_id, project_id: 'prj_arrival_e2e' };
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [
        { id: 'cst_e2e_1', text: 'No deploys during the release cut', status: 'active', tags: [], ...base },
      ],
      recent_decisions: [
        { id: 'dec_e2e_dead', text: 'Routing logic lives in src/legacy-router.ts', tags: [], related_paths: ['src/legacy-router.ts'], ...base },
      ],
      known_traps: [
        { id: 'trp_e2e_1', text: 'CI uses dist-test, not dist', status: 'active', severity: 'medium', visibility: 'shared', tags: [], ...base },
      ],
      open_handoffs: [
        { id: 'hnd_e2e_1', text: 'Pick up the cursor migration', status: 'open', from: 'veteran', to: 'anyone', tags: [], ...base },
      ],
      plan_items: [
        { id: 'pln_e2e_1', text: 'Ship the arrival experience', status: 'in_progress', priority: 'high', depends_on: [], tags: [], ...base, updated_at: now },
      ],
    }, workspace.dir);
    for (let i = 0; i < 500; i++) {
      appendEvent({ action: 'update', item_type: 'claim', item_id: `clm_hist_${i}`, agent: 'veteran' }, workspace.dir);
    }

    restoreAgent = actAsFreshAgent(workspace, 'newcomer');

    const first = await callWork(workspace);
    assert.equal(first.facade.status, 'ok');
    const result = first.facade.result as {
      context_diff: { source?: string; summary?: string; changed_items?: Array<{ id: string }> } | null;
      stale_warnings: Array<{ id: string; entity: string }>;
    };
    assert.ok(result.context_diff, 'first contact must carry a context_diff');
    assert.equal(result.context_diff?.source, 'arrival_digest');
    assert.match(result.context_diff?.summary ?? '', /First contact/);
    // Dead reference surfaced on arrival.
    assert.ok(
      result.stale_warnings.some((w) => w.id === 'dec_e2e_dead'),
      `dead related_paths must surface in stale_warnings; got ${JSON.stringify(result.stale_warnings)}`,
    );
    // No bootstrap noise on a healthy mature store.
    assert.equal(first.facade.bootstrap_verdict, 'none');
    // Token budget.
    assert.ok(
      first.serializedLength < TOKEN_BUDGET_CHARS,
      `first bclaw_work serialized to ${first.serializedLength} chars — budget is < ${TOKEN_BUDGET_CHARS}`,
    );

    // Second call: cursor was seeded at EOF → no replay. Only the events the
    // first call itself emitted (session/audit bridge) may show up; the 500
    // historical events must NOT.
    const second = await callWork(workspace);
    const secondResult = second.facade.result as { context_diff: { source?: string; unseen_event_count?: number } | null };
    if (secondResult.context_diff) {
      assert.equal(secondResult.context_diff.source, 'event_cursor');
      assert.ok(
        (secondResult.context_diff.unseen_event_count ?? 0) < 50,
        `second call must be incremental, saw ${secondResult.context_diff.unseen_event_count} events`,
      );
    }
  });
});

describe('arrival e2e — fresh agent on an empty store over a brownfield repo', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-arrival-brown-', projectId: 'prj_arrival_brown' });
  });

  afterEach(() => {
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('routes to extraction via the single empty-memory rule, then bootstrap yields typed suggestions', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Brownfield\n\nAn existing project with docs.\n', 'utf8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({ name: 'brownfield', scripts: { test: 'node --test', build: 'tsc' } }), 'utf8');

    const first = await callWork(workspace);
    assert.equal(first.facade.status, 'ok');
    assert.equal(first.facade.bootstrap_recommended, true);
    assert.equal(first.facade.bootstrap_verdict, 'bootstrap');
    // Repo has content → extract route (the single decision rule).
    assert.equal(first.facade.next_action, 'bclaw_bootstrap()');
    assert.ok(
      first.facade.next_actions?.some((a) => a.tool === 'bclaw_bootstrap'),
      'next_actions must carry the extraction affordance',
    );
    assert.ok(
      first.serializedLength < TOKEN_BUDGET_CHARS,
      `first bclaw_work serialized to ${first.serializedLength} chars — budget is < ${TOKEN_BUDGET_CHARS}`,
    );

    // Chained extraction produces typed candidates/suggestions.
    const bootstrap = await executeMcpToolCall({ name: 'bclaw_bootstrap', args: {}, cwd: workspace.dir });
    const sc = bootstrap.response.structuredContent as {
      seed_count: number;
      import_plan?: { suggestions?: Array<{ target: string }> };
      auto_imports?: unknown[];
      proposals?: unknown[];
    };
    assert.ok(sc.seed_count > 0, 'scanner must extract seeds from the brownfield repo');
    const suggestions = sc.import_plan?.suggestions ?? [];
    assert.ok(suggestions.length > 0, 'import plan must carry typed suggestions');
    for (const s of suggestions) {
      assert.ok(['instruction', 'decision', 'constraint', 'trap'].includes(s.target), `suggestion target must be typed, got ${s.target}`);
    }
  });
});
