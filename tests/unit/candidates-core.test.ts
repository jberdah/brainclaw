import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCandidateStar,
  addCandidateUse,
  archiveCandidate,
  listArchivedCandidates,
  listCandidates,
  loadCandidate,
  resolvedSource,
  saveCandidate,
} from '../../src/core/candidates.js';
import { CandidateSchema, type Candidate } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('core/candidates', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-candidates-',
      projectId: 'prj_candidates_test',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('adds stars once per actor and usage once per actor/context pair', () => {
    const candidate: Candidate = {
      id: 'cnd_popular',
      type: 'decision',
      text: 'Popular candidate',
      created_at: iso(10),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: ['auth'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(candidate, workspace.dir);

    assert.equal(addCandidateStar(candidate.id, 'copilot', workspace.dir).added, true);
    assert.equal(addCandidateStar(candidate.id, 'copilot', workspace.dir).added, false);
    assert.equal(addCandidateStar(candidate.id, 'claude', workspace.dir).added, true);

    assert.equal(addCandidateUse(candidate.id, 'copilot', 'auth rollout', workspace.dir).added, true);
    assert.equal(addCandidateUse(candidate.id, 'copilot', 'auth rollout', workspace.dir).added, false);
    assert.equal(addCandidateUse(candidate.id, 'copilot', 'refund rollout', workspace.dir).added, true);

    const stored = loadCandidate(candidate.id, workspace.dir);
    assert.equal(stored.star_count, 2);
    assert.deepEqual(stored.starred_by, ['claude', 'copilot']);
    assert.equal(stored.usage_count, 2);
    assert.equal(stored.usage_events.length, 2);
  });

  it('schema backward compat: legacy free-text source on disk is silently dropped (catch → undefined → human)', () => {
    // Simulate old disk data where source was a free-text string like 'runtime-note:...'
    const legacyRaw = {
      id: 'cnd_disk_legacy',
      type: 'decision',
      text: 'Old candidate with free-text source',
      created_at: iso(15),
      author: 'claude',
      tags: [],
      status: 'pending',
      source: 'runtime-note:claude:note_123abc', // old format that must not crash
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    const parsed = CandidateSchema.parse(legacyRaw);
    assert.equal(parsed.source, undefined, 'invalid enum value should be silently dropped by .catch(undefined)');
    assert.equal(resolvedSource(parsed), 'human', 'dropped source should resolve to human (backward compat)');
  });

  it('source filter: resolvedSource defaults missing source to human', () => {
    const noSource: Candidate = {
      id: 'cnd_legacy',
      type: 'decision',
      text: 'Legacy candidate without source',
      created_at: iso(5),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: [],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(noSource, workspace.dir);
    const loaded = loadCandidate(noSource.id, workspace.dir);
    assert.equal(resolvedSource(loaded), 'human', 'missing source should resolve to human');
  });

  it('source filter: auto_generated=false excludes source=auto, keeps human and missing', () => {
    const autoCandidate: Candidate = {
      id: 'cnd_auto',
      type: 'trap',
      text: 'Auto-generated trap from session-end',
      created_at: iso(4),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: ['auto-reflect'],
      status: 'pending',
      source: 'auto',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    const agentCandidate: Candidate = {
      id: 'cnd_agent',
      type: 'decision',
      text: 'Intentional agent decision',
      created_at: iso(3),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: [],
      status: 'pending',
      source: 'agent',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    const legacyCandidate: Candidate = {
      id: 'cnd_legacy2',
      type: 'constraint',
      text: 'Legacy item without source',
      created_at: iso(2),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: [],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(autoCandidate, workspace.dir);
    saveCandidate(agentCandidate, workspace.dir);
    saveCandidate(legacyCandidate, workspace.dir);

    // auto_generated=false: should exclude only source=auto
    const filtered = listCandidates('pending', workspace.dir, { auto_generated: false });
    const ids = filtered.map((c) => c.id);
    assert.ok(!ids.includes('cnd_auto'), 'auto candidate should be excluded');
    assert.ok(ids.includes('cnd_agent'), 'agent candidate should be included');
    assert.ok(ids.includes('cnd_legacy2'), 'legacy (no source) candidate should be included as human');

    // auto_generated=true: should show only source=auto
    const autoOnly = listCandidates('pending', workspace.dir, { auto_generated: true });
    const autoIds = autoOnly.map((c) => c.id);
    assert.ok(autoIds.includes('cnd_auto'), 'auto candidate should be in auto-only set');
    assert.ok(!autoIds.includes('cnd_agent'), 'agent candidate should not be in auto-only set');
    assert.ok(!autoIds.includes('cnd_legacy2'), 'legacy candidate should not be in auto-only set');

    // source='agent': should show only source=agent
    const agentOnly = listCandidates('pending', workspace.dir, { source: 'agent' });
    assert.deepEqual(agentOnly.map((c) => c.id), ['cnd_agent']);
  });

  it('archives accepted and rejected candidates outside the pending inbox', () => {
    const accepted: Candidate = {
      id: 'cnd_accept',
      type: 'decision',
      text: 'Accepted candidate',
      created_at: iso(8),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_candidates_test',
      tags: [],
      status: 'accepted',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    const rejected: Candidate = {
      ...accepted,
      id: 'cnd_reject',
      text: 'Rejected candidate',
      status: 'rejected',
    };

    archiveCandidate(accepted, 'accepted', workspace.dir);
    archiveCandidate(rejected, 'rejected', workspace.dir);

    assert.deepEqual(listArchivedCandidates('accepted', workspace.dir).map((item) => item.id), ['cnd_accept']);
    assert.deepEqual(listArchivedCandidates('rejected', workspace.dir).map((item) => item.id), ['cnd_reject']);
  });
});
