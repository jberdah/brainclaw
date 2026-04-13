import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidate, saveCandidate } from '../../src/core/candidates.js';
import { saveClaim } from '../../src/core/claims.js';
import {
  buildCurrentAgentResumeSummary,
  buildReputationRankingLookup,
  buildReputationSnapshot,
  buildReputationSummary,
  findAgentReputationSummary,
} from '../../src/core/reputation.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import type { Candidate, Claim, RuntimeNote } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('core/reputation', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-reputation-',
      projectId: 'prj_reputation_test',
      currentAgent: 'alice',
      reputationEnabled: true,
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('aggregates candidate, runtime, and review signals into the snapshot', () => {
    const alice = workspace.currentAgent;
    const bob = workspace.registerAgent('bob');

    const pending: Candidate = {
      id: 'cnd_pending_alice',
      type: 'decision',
      text: 'Pending auth follow-up',
      created_at: iso(20),
      author: alice.agent_name,
      author_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      tags: ['auth'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(pending, workspace.dir);

    const accepted: Candidate = {
      id: 'cnd_accepted_alice',
      type: 'decision',
      text: 'Accepted auth finding',
      created_at: iso(18),
      author: alice.agent_name,
      author_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      source: 'auto',
      tags: ['auth'],
      status: 'accepted',
      star_count: 2,
      starred_by: ['bob', 'carol'],
      usage_count: 1,
      usage_events: [{ by: 'bob', context: 'auth rollout', created_at: iso(12) }],
      resolved_at: iso(6),
      resolved_by: bob.agent_name,
    };
    archiveCandidate(accepted, 'accepted', workspace.dir);

    const rejected: Candidate = {
      id: 'cnd_rejected_alice',
      type: 'decision',
      text: 'Rejected auth finding',
      created_at: iso(17),
      author: alice.agent_name,
      author_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      tags: ['auth'],
      status: 'rejected',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
      resolved_at: iso(5),
      resolved_by: bob.agent_name,
      resolution_reason: 'Duplicate of an accepted decision.',
    };
    archiveCandidate(rejected, 'rejected', workspace.dir);

    const notes: RuntimeNote[] = [
      {
        id: 'rtn_promoted',
        agent: alice.agent_name,
        agent_id: alice.agent_id,
        project_id: 'prj_reputation_test',
        session_id: 'sess_rep_1',
        text: 'Runtime note later promoted',
        created_at: iso(16),
        tags: ['auth'],
        plan_id: 'pln_auth_rollout',
        visibility: 'shared',
        note_type: 'observation',
      },
      {
        id: 'rtn_orphan',
        agent: alice.agent_name,
        agent_id: alice.agent_id,
        project_id: 'prj_reputation_test',
        session_id: 'sess_rep_2',
        text: 'Unlinked runtime note',
        created_at: iso(15),
        tags: ['auth'],
        visibility: 'shared',
        note_type: 'observation',
      },
    ];
    for (const note of notes) {
      saveRuntimeNote(note, workspace.dir);
    }

    const claims: Claim[] = [
      {
        id: 'clm_active',
        agent: alice.agent_name,
        agent_id: alice.agent_id,
        project_id: 'prj_reputation_test',
        scope: 'auth-rollout',
        description: 'Own rollout sequencing',
        created_at: iso(14),
        status: 'active',
      },
      {
        id: 'clm_released',
        agent: alice.agent_name,
        agent_id: alice.agent_id,
        project_id: 'prj_reputation_test',
        scope: 'auth-cleanup',
        description: 'Own cleanup tasks',
        created_at: iso(13),
        status: 'released',
        released_at: iso(4),
      },
    ];
    for (const claim of claims) {
      saveClaim(claim, workspace.dir);
    }

    const snapshot = buildReputationSnapshot(workspace.dir);
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.current_agent_id, alice.agent_id);
    assert.ok(snapshot.current_agent);
    assert.equal(snapshot.current_agent?.agent_name, alice.agent_name);
    assert.equal(snapshot.current_agent?.signals.pending_candidates, 1);
    assert.equal(snapshot.current_agent?.signals.accepted_candidates, 1);
    assert.equal(snapshot.current_agent?.signals.rejected_candidates_authored, 1);
    assert.equal(snapshot.current_agent?.signals.promoted_runtime_candidates, 1);
    assert.equal(snapshot.current_agent?.signals.promoted_runtime_accepted, 1);
    assert.equal(snapshot.current_agent?.signals.stars_received, 2);
    assert.equal(snapshot.current_agent?.signals.uses_received, 1);
    assert.equal(snapshot.current_agent?.signals.runtime_notes_created, 2);
    assert.equal(snapshot.current_agent?.signals.plan_linked_activity, 1);
    assert.equal(snapshot.current_agent?.signals.claims_created, 2);
    assert.equal(snapshot.current_agent?.signals.released_claims, 1);
    assert.equal(snapshot.current_agent?.signals.orphan_runtime_noise, 0);
    assert.ok(snapshot.current_agent && snapshot.current_agent.scores.internal_trust > 0);

    const bobSnapshot = snapshot.agents.find((agent) => agent.agent_name === bob.agent_name);
    assert.ok(bobSnapshot);
    assert.equal(bobSnapshot?.signals.accepted_reviews, 1);
    assert.equal(bobSnapshot?.signals.rejected_reviews, 1);
    assert.equal(bobSnapshot?.signals.reasoned_rejections, 1);
    assert.ok(bobSnapshot && bobSnapshot.scores.review_reliability > 0);
  });

  it('builds resume, ranking lookup, and aggregate summaries from the same signals', () => {
    const alice = workspace.currentAgent;
    const bob = workspace.registerAgent('bob');

    saveCandidate({
      id: 'cnd_pending_summary',
      type: 'decision',
      text: 'Pending summary item',
      created_at: iso(20),
      author: alice.agent_name,
      author_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      tags: ['summary'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    }, workspace.dir);

    archiveCandidate({
      id: 'cnd_accepted_summary',
      type: 'decision',
      text: 'Accepted summary item',
      created_at: iso(18),
      author: alice.agent_name,
      author_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      source: 'auto',
      tags: ['summary'],
      status: 'accepted',
      star_count: 1,
      starred_by: ['bob'],
      usage_count: 1,
      usage_events: [{ by: 'bob', context: 'summary usage', created_at: iso(12) }],
      resolved_at: iso(6),
      resolved_by: bob.agent_name,
    }, 'accepted', workspace.dir);

    saveRuntimeNote({
      id: 'rtn_summary',
      agent: alice.agent_name,
      agent_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      session_id: 'sess_summary',
      text: 'Summary runtime note',
      created_at: iso(15),
      tags: ['summary'],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);

    saveClaim({
      id: 'clm_summary',
      agent: alice.agent_name,
      agent_id: alice.agent_id,
      project_id: 'prj_reputation_test',
      scope: 'summary-scope',
      description: 'Keep summary claim active',
      created_at: iso(13),
      status: 'active',
    }, workspace.dir);

    const resume = buildCurrentAgentResumeSummary(workspace.dir);
    assert.ok(resume);
    assert.equal(resume?.agent_name, alice.agent_name);
    assert.ok(resume && resume.internal_trust > 0);
    assert.ok(resume?.strengths.some((item) => item.includes('accepted candidate')));
    assert.ok(resume?.cautions.some((item) => item.includes('pending candidate')));
    assert.ok(resume?.suggested_focus.some((item) => item.includes('Review pending candidates')));

    const ranking = buildReputationRankingLookup(workspace.dir);
    assert.equal(ranking.enabled, true);
    assert.ok(ranking.getInternalTrust(alice.agent_id, alice.agent_name) > 0);
    assert.ok(ranking.getRankingBonus(alice.agent_id, alice.agent_name) > 0);

    const summary = buildReputationSummary(workspace.dir);
    assert.equal(summary.enabled, true);
    assert.equal(summary.current_agent_id, alice.agent_id);
    assert.equal(summary.total_pending_candidates, 1);
    assert.equal(summary.total_review_resolutions, 1);
    assert.equal(summary.total_runtime_notes, 1);
    assert.ok(summary.tracked_agents >= 2);
    assert.ok(summary.avg_internal_trust > 0);

    const publicSummary = findAgentReputationSummary(alice.agent_name, workspace.dir);
    assert.ok(publicSummary);
    assert.equal(publicSummary?.agent_id, alice.agent_id);
    assert.ok(publicSummary && publicSummary.internal_trust > 0);
  });
});
