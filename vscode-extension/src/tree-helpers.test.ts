/**
 * Unit tests for the extension's pure tree helpers (pln#393 stp_92cd2775).
 *
 * These exercise candidate classification, staleness thresholds, freshness
 * classification, and time formatting. The functions have no vscode deps so
 * they run under plain `node --test` against the compiled output.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  STALE_MS,
  agentFreshness,
  formatRelativeAge,
  isAutoCandidate,
  isStale,
  timeAgo,
} from './tree-helpers';

function isoMinutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}
function isoHoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}
function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86_400_000).toISOString();
}

describe('tree-helpers — timeAgo', () => {
  it('returns "just now" for timestamps under a minute', () => {
    assert.equal(timeAgo(new Date().toISOString()), 'just now');
  });
  it('returns minute precision under an hour', () => {
    assert.equal(timeAgo(isoMinutesAgo(30)), '30m ago');
  });
  it('returns hour precision under a day', () => {
    assert.equal(timeAgo(isoHoursAgo(5)), '5h ago');
  });
  it('returns day precision beyond a day', () => {
    assert.equal(timeAgo(isoDaysAgo(3)), '3d ago');
  });
});

describe('tree-helpers — formatRelativeAge', () => {
  it('clamps future timestamps to 0m', () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    assert.equal(formatRelativeAge(future), '0m');
  });
  it('uses "d ago" beyond 14 days', () => {
    assert.equal(formatRelativeAge(isoDaysAgo(30)), '30d ago');
  });
  it('uses "d" without suffix for 1–13 days', () => {
    assert.equal(formatRelativeAge(isoDaysAgo(5)), '5d');
  });
});

describe('tree-helpers — isStale', () => {
  it('returns false for undefined date', () => {
    assert.equal(isStale(undefined, STALE_MS.claim), false);
  });
  it('returns false when age is below threshold', () => {
    assert.equal(isStale(isoHoursAgo(1), STALE_MS.claim), false);
  });
  it('returns true when age exceeds threshold', () => {
    assert.equal(isStale(isoHoursAgo(5), STALE_MS.claim), true);
  });
  it('assignment threshold is 30 minutes', () => {
    assert.equal(isStale(isoMinutesAgo(31), STALE_MS.assignment), true);
    assert.equal(isStale(isoMinutesAgo(29), STALE_MS.assignment), false);
  });
});

describe('tree-helpers — agentFreshness', () => {
  // pln#559 step 5 — agentFreshness is now evidence-based: open sessions and
  // claim_count alone no longer force 'active'. A crashed worker with a
  // dangling claim must NOT show a green dot (2026-06-10 calibration).
  it('is "stale" when last_active is decades old, even with an open session', () => {
    assert.equal(
      agentFreshness({ has_open_session: true, last_active: isoDaysAgo(30) }),
      'stale',
    );
  });
  it('is "stale" when last_active is decades old, even with held claims (crashed worker pattern)', () => {
    assert.equal(
      agentFreshness({ claim_count: 2, last_active: isoDaysAgo(30) }),
      'stale',
    );
  });
  it('is "stale" when last_active is missing and no session/claims', () => {
    assert.equal(agentFreshness({}), 'stale');
  });
  it('is "stale" when last_active is missing even with an open session (no liveness evidence)', () => {
    assert.equal(agentFreshness({ has_open_session: true }), 'stale');
  });
  it('is "active" when last_active is under an hour old', () => {
    assert.equal(agentFreshness({ last_active: isoMinutesAgo(30) }), 'active');
  });
  it('is "idle" between 1h and 6h', () => {
    assert.equal(agentFreshness({ last_active: isoHoursAgo(3) }), 'idle');
  });
  it('is "stale" beyond 6h', () => {
    assert.equal(agentFreshness({ last_active: isoHoursAgo(12) }), 'stale');
  });
});

describe('tree-helpers — isAutoCandidate', () => {
  it('matches server-side source=auto (authoritative signal)', () => {
    assert.equal(isAutoCandidate({ source: 'auto' }), true);
  });
  it('does not match source=agent', () => {
    assert.equal(isAutoCandidate({ source: 'agent' }), false);
  });
  it('does not match source=human', () => {
    assert.equal(isAutoCandidate({ source: 'human' }), false);
  });
  it('falls back to legacy origin=session-end-* for candidates predating source', () => {
    assert.equal(isAutoCandidate({ origin: 'session-end-auto' }), true);
    assert.equal(isAutoCandidate({ origin: 'session-end' }), true);
  });
  it('returns false for candidates with no source and non-session-end origin', () => {
    assert.equal(isAutoCandidate({ origin: 'agent-handoff' }), false);
  });
  it('returns false for empty candidate (legacy default is human)', () => {
    assert.equal(isAutoCandidate({}), false);
  });
});
