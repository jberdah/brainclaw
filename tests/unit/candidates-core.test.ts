import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCandidateStar,
  addCandidateUse,
  archiveCandidate,
  listArchivedCandidates,
  loadCandidate,
  saveCandidate,
} from '../../src/core/candidates.js';
import type { Candidate } from '../../src/core/schema.js';
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
