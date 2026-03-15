import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkCircuitBreaker, buildCircuitBreakerSnapshot, resetCircuitBreaker } from '../../src/core/circuit-breaker.js';
import { saveCandidate, archiveCandidate } from '../../src/core/candidates.js';
import { createTestWorkspace } from '../helpers/workspace.js';
import type { TestWorkspace } from '../helpers/workspace.js';
import type { Candidate } from '../../src/core/schema.js';
import { nowISO } from '../../src/core/ids.js';

let candidateSeq = 0;

function makeRejectedCandidate(author: string, author_id?: string, daysAgo = 0): Candidate {
  const seq = ++candidateSeq;
  const resolvedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: `cnd_test${seq.toString().padStart(4, '0')}`,
    type: 'decision',
    text: `Rejected decision ${seq}`,
    created_at: resolvedAt,
    author,
    author_id,
    tags: [],
    status: 'rejected',
    resolved_at: resolvedAt,
    resolved_by: 'curator',
    star_count: 0,
    starred_by: [],
    usage_count: 0,
    usage_events: [],
  };
}

function seedRejections(workspace: TestWorkspace, author: string, count: number, daysAgo = 0): void {
  for (let i = 0; i < count; i++) {
    const c = makeRejectedCandidate(author, undefined, daysAgo);
    // Save as pending first, then archive as rejected
    saveCandidate({ ...c, status: 'pending', resolved_at: undefined, resolved_by: undefined }, workspace.dir);
    archiveCandidate(c, 'rejected', workspace.dir);
  }
}

describe('core/circuit-breaker — checkCircuitBreaker', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-cb-' });
  });

  it('returns tripped:false when no rejections exist', () => {
    const status = checkCircuitBreaker('agent-x', workspace.dir);
    assert.equal(status.tripped, false);
    assert.equal(status.rejection_count, 0);
    assert.equal(status.threshold, 5);
  });

  it('returns tripped:false when below threshold', () => {
    seedRejections(workspace, 'bad-agent', 4);
    const status = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(status.tripped, false);
    assert.equal(status.rejection_count, 4);
  });

  it('returns tripped:true when at threshold', () => {
    seedRejections(workspace, 'bad-agent', 5);
    const status = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(status.tripped, true);
    assert.equal(status.rejection_count, 5);
  });

  it('returns tripped:true when above threshold', () => {
    seedRejections(workspace, 'bad-agent', 8);
    const status = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(status.tripped, true);
    assert.equal(status.rejection_count, 8);
  });

  it('does not count rejections outside the window', () => {
    seedRejections(workspace, 'bad-agent', 5, 8); // 8 days ago, outside default 7-day window
    const status = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(status.tripped, false);
    assert.equal(status.rejection_count, 0);
  });

  it('only counts rejections for the queried agent', () => {
    seedRejections(workspace, 'innocent-agent', 3);
    seedRejections(workspace, 'bad-agent', 5);
    const innocent = checkCircuitBreaker('innocent-agent', workspace.dir);
    const bad = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(innocent.tripped, false);
    assert.equal(bad.tripped, true);
  });

  it('matches by author name case-insensitively', () => {
    seedRejections(workspace, 'BadAgent', 5);
    const status = checkCircuitBreaker('badagent', workspace.dir);
    assert.equal(status.tripped, true);
  });
});

describe('core/circuit-breaker — resetCircuitBreaker', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-cb-reset-' });
  });

  it('after reset, previously tripped agent is no longer tripped', () => {
    seedRejections(workspace, 'bad-agent', 5);
    assert.equal(checkCircuitBreaker('bad-agent', workspace.dir).tripped, true);

    resetCircuitBreaker('bad-agent', workspace.dir);

    const status = checkCircuitBreaker('bad-agent', workspace.dir);
    assert.equal(status.tripped, false);
    assert.equal(status.rejection_count, 0);
  });

  it('reset does not affect other agents', () => {
    seedRejections(workspace, 'bad-agent', 5);
    seedRejections(workspace, 'also-bad', 5);

    resetCircuitBreaker('bad-agent', workspace.dir);

    assert.equal(checkCircuitBreaker('bad-agent', workspace.dir).tripped, false);
    assert.equal(checkCircuitBreaker('also-bad', workspace.dir).tripped, true);
  });
});

describe('core/circuit-breaker — buildCircuitBreakerSnapshot', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-cb-snap-' });
  });

  it('returns empty arrays when no rejections', () => {
    const snap = buildCircuitBreakerSnapshot(workspace.dir);
    assert.equal(snap.tripped_agents.length, 0);
    assert.equal(snap.clear_agents.length, 0);
  });

  it('lists tripped agents correctly', () => {
    seedRejections(workspace, 'bad-agent', 5);
    seedRejections(workspace, 'ok-agent', 2);
    const snap = buildCircuitBreakerSnapshot(workspace.dir);
    assert.equal(snap.tripped_agents.length, 1);
    assert.equal(snap.tripped_agents[0]!.agent_key, 'bad-agent');
    assert.equal(snap.clear_agents.length, 1);
    assert.equal(snap.clear_agents[0]!.agent_key, 'ok-agent');
  });
});
