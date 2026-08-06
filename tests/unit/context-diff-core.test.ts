import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildContextDiff } from '../../src/core/context-diff.js';
import { runSessionStart } from '../../src/commands/session-start.js';
import { saveCandidate } from '../../src/core/candidates.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/context-diff', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-context-diff-',
      projectId: 'prj_context_diff_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    delete process.env.BRAINCLAW_SESSION_ID;
    workspace.cleanup();
  });

  it('returns undefined when no reference point is available', () => {
    const diff = buildContextDiff({ cwd: workspace.dir });
    assert.equal(diff, undefined);
  });

  it('builds counts and changed items from a session reference', () => {
    process.env.BRAINCLAW_SESSION_ID = 'sess_diff_core';
    runSessionStart({ context: 'auth', cwd: workspace.dir });

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [
        {
          id: 'cst_diff_core',
          text: 'Auth deploys are frozen',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_context_diff_test',
          status: 'active',
          tags: ['auth'],
        },
      ],
      recent_decisions: [
        {
          id: 'dec_diff_core',
          text: 'Auth requests now go through the gateway',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_context_diff_test',
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);
    saveCandidate({
      id: 'cnd_diff_core',
      type: 'decision',
      text: 'Document auth rollback flow',
      created_at: new Date().toISOString(),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_context_diff_test',
      tags: ['auth'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    }, workspace.dir);

    const diff = buildContextDiff({
      session: 'sess_diff_core',
      cwd: workspace.dir,
      includeItems: true,
    });

    assert.ok(diff);
    assert.equal(diff?.since_session, 'sess_diff_core');
    assert.equal(diff?.counts.constraints, 1);
    assert.equal(diff?.counts.decisions, 1);
    assert.equal(diff?.counts.pending_candidates, 1);
    assert.equal(diff?.counts.total, 3);
    assert.ok((diff?.changed_items?.length ?? 0) >= 3);
    assert.match(diff?.summary ?? '', /constraint/);
  });
});

/**
 * pln#649 — the session snapshot was read from ONE directory, chosen by
 * `resolveEntityDir(..., 'read')`'s `hasContent` heuristic. That answers a DIRECTORY
 * question for what is a FILE question, so a single canonical file made every legacy
 * record invisible. The same malformed abstraction the plan removed from the locator and
 * the by-id loaders; it survived here because nothing routed sessions.
 *
 * NOT A HYPOTHETICAL: the author's own store holds 173 sessions in the legacy layout next
 * to 1019 canonical ones (T2's dual write). This is the one remaining by-id site with live
 * two-layout data, which is why it was fixed while its siblings were only re-ranked.
 *
 * THE PIN DELIBERATELY AVOIDS THE AUDIT-LOG FALLBACK. `resolveContextDiffSince` falls back
 * to a `session_start` audit entry, so a session created through `runSessionStart` would
 * resolve its window EVEN WITH the defect present — a pin built that way passes for the
 * wrong reason, which is the failure mode that cost three CI rounds elsewhere in this plan
 * (trp#1447). So the snapshot is hand-written for an id that was never audit-logged: only
 * the snapshot path can supply `since`, and the defect's real symptom — "no changes"
 * reported over a window where there were changes — is what goes red.
 */
describe('core/context-diff — legacy-layout session snapshot (pln#649)', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace({
      prefix: 'bclaw-context-diff-layout-',
      projectId: 'prj_context_diff_layout',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => { ws.cleanup(); });

  it('resolves the diff window from a snapshot in the LEGACY layout, with the canonical dir populated', () => {
    const started = new Date(Date.now() - 60_000).toISOString();
    const legacyId = 'sess_legacy_only';

    // The canonical dir must hold SOMETHING, otherwise the `hasContent` heuristic picks the
    // legacy dir on its own and the pin would pass without the fix.
    const canonicalDir = path.join(ws.dir, '.brainclaw', 'coordination', 'sessions');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, 'sess_canonical_other.json'), JSON.stringify({
      schema_version: 2, session_id: 'sess_canonical_other', started_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(), agent: 'copilot', host_id: 'test-host', pid: 1,
      isolation_mode: 'shared-checkout',
    }), 'utf-8');

    // The session under test exists ONLY in the legacy layout, and never in the audit log.
    const legacyDir = path.join(ws.dir, '.brainclaw', 'sessions');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, `${legacyId}.json`), JSON.stringify({
      schema_version: 2, session_id: legacyId, started_at: started, last_seen_at: started,
      agent: 'copilot', host_id: 'test-host', pid: 2, isolation_mode: 'shared-checkout',
    }), 'utf-8');

    // Something genuinely changed inside the window.
    saveCandidate({
      id: 'cnd_after_legacy_session',
      type: 'trap',
      text: 'captured after the legacy session started',
      status: 'pending',
      created_at: new Date().toISOString(),
      author: ws.currentAgent.agent_name,
      author_id: ws.currentAgent.agent_id,
      project_id: 'prj_context_diff_layout',
      tags: [],
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    }, ws.dir);

    const diff = buildContextDiff({ session: legacyId, cwd: ws.dir, includeItems: true });

    assert.ok(diff, 'a legacy-layout snapshot must still resolve a window — undefined here IS the defect, reported to the agent as "no changes"');
    assert.equal(diff.since, started, 'the window must come from the snapshot, not from a fallback');
    assert.ok(diff.counts.total > 0, `the change inside the window must be reported — got ${JSON.stringify(diff.counts)}`);
  });
});
