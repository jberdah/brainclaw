import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidate, listCandidates, saveCandidate } from '../../src/core/candidates.js';
import { runReview } from '../../src/commands/review.js';
import type { Candidate } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function captureLogs(fn: () => void): string[] {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = () => {};
  console.error = (...args: unknown[]) => {
    throw new Error(args.map(String).join(' '));
  };

  try {
    fn();
    return logs;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe('commands/review', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-review-',
      projectId: 'prj_review_test',
      currentAgent: 'reviewer',
      reputationEnabled: true,
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('prioritizes JSON review output and decorates promotion metadata', () => {
    const trusted = workspace.registerAgent('trusted-bot');
    const novice = workspace.registerAgent('novice-bot');

    for (const index of [1, 2]) {
      archiveCandidate({
        id: `cnd_trusted_history_${index}`,
        type: 'decision',
        text: `Trusted history ${index}`,
        created_at: iso(12 + index),
        author: trusted.agent_name,
        author_id: trusted.agent_id,
        project_id: 'prj_review_test',
        tags: ['history'],
        status: 'accepted',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
        resolved_at: iso(6),
        resolved_by: workspace.currentAgent.agent_name,
      }, 'accepted', workspace.dir);
    }

    const candidates: Candidate[] = [
      {
        id: 'cnd_promote',
        type: 'handoff',
        text: 'Promotion-ready handoff',
        created_at: iso(3),
        author: workspace.currentAgent.agent_name,
        author_id: workspace.currentAgent.agent_id,
        project_id: 'prj_review_test',
        from: 'copilot',
        to: 'claude',
        tags: ['handoff'],
        status: 'pending',
        star_count: 3,
        starred_by: ['a', 'b', 'c'],
        usage_count: 0,
        usage_events: [],
      },
      {
        id: 'cnd_trusted_pending',
        type: 'decision',
        text: 'Trusted pending candidate',
        created_at: iso(2),
        author: trusted.agent_name,
        author_id: trusted.agent_id,
        project_id: 'prj_review_test',
        tags: ['queue'],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      },
      {
        id: 'cnd_novice_pending',
        type: 'decision',
        text: 'Novice pending candidate',
        created_at: iso(1),
        author: novice.agent_name,
        author_id: novice.agent_id,
        project_id: 'prj_review_test',
        tags: ['queue'],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      },
    ];
    for (const candidate of candidates) {
      saveCandidate(candidate, workspace.dir);
    }

    const logs = captureLogs(() => {
      runReview({ json: true, prioritized: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(logs.at(-1) as string);

    assert.equal(parsed[0].id, 'cnd_promote');
    assert.equal(parsed[0].promotion_recommended, true);
    assert.equal(parsed[0].promotion_stars, 3);
    const trustedIndex = parsed.findIndex((item: { id: string }) => item.id === 'cnd_trusted_pending');
    const noviceIndex = parsed.findIndex((item: { id: string }) => item.id === 'cnd_novice_pending');
    assert.ok(trustedIndex >= 0);
    assert.ok(noviceIndex >= 0);
    assert.ok(trustedIndex < noviceIndex);
  });

  it('filters overdue reviews and claims candidates in JSON mode', () => {
    const candidates: Candidate[] = [
      {
        id: 'cnd_old_unassigned',
        type: 'decision',
        text: 'Old unassigned item',
        created_at: iso(30),
        author: workspace.currentAgent.agent_name,
        author_id: workspace.currentAgent.agent_id,
        project_id: 'prj_review_test',
        tags: [],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      },
      {
        id: 'cnd_assigned_bob',
        type: 'decision',
        text: 'Assigned to bob',
        created_at: iso(4),
        author: workspace.currentAgent.agent_name,
        author_id: workspace.currentAgent.agent_id,
        project_id: 'prj_review_test',
        tags: ['assignee:bob'],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      },
      {
        id: 'cnd_recent_free',
        type: 'decision',
        text: 'Recent free item',
        created_at: iso(2),
        author: workspace.currentAgent.agent_name,
        author_id: workspace.currentAgent.agent_id,
        project_id: 'prj_review_test',
        tags: [],
        status: 'pending',
        star_count: 0,
        starred_by: [],
        usage_count: 0,
        usage_events: [],
      },
    ];
    for (const candidate of candidates) {
      saveCandidate(candidate, workspace.dir);
    }

    const overdueLogs = captureLogs(() => {
      runReview({ json: true, onlyOverdue: true, cwd: workspace.dir });
    });
    const overdue = JSON.parse(overdueLogs.at(-1) as string);
    assert.deepEqual(overdue.map((item: { id: string }) => item.id), ['cnd_old_unassigned']);

    const assigneeLogs = captureLogs(() => {
      runReview({ json: true, assignee: 'bob', cwd: workspace.dir });
    });
    const assignee = JSON.parse(assigneeLogs.at(-1) as string);
    assert.deepEqual(assignee.map((item: { id: string }) => item.id), ['cnd_assigned_bob']);

    const claimLogs = captureLogs(() => {
      runReview({ json: true, claim: 'alice', take: 2, cwd: workspace.dir });
    });
    const claimResult = JSON.parse(claimLogs.at(-1) as string);
    assert.equal(claimResult.claimed.length, 1);
    assert.equal(claimResult.claimed[0].id, 'cnd_old_unassigned');
    assert.equal(claimResult.claimed[0].review_assignee, 'alice');
    assert.equal(claimResult.skipped.length, 1);
    assert.equal(claimResult.skipped[0].id, 'cnd_assigned_bob');

    const stored = listCandidates('pending', workspace.dir);
    const claimed = stored.find((item) => item.id === 'cnd_old_unassigned');
    const untouched = stored.find((item) => item.id === 'cnd_assigned_bob');
    assert.ok(claimed?.tags.includes('assignee:alice'));
    assert.ok(untouched?.tags.includes('assignee:bob'));
  });
});
