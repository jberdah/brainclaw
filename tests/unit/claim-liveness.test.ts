/**
 * Regression tests for session-aware claim liveness logic.
 *
 * Covers:
 *  - assessClaimLiveness: all five status codes
 *  - isClaimStale: live session prevents release
 *  - releaseStaleClaimsFromOtherAgents: skips live/young, releases stale/orphaned/never-adopted
 *  - Long-running sessions (>24h) are not auto-released while alive
 *  - Crash recovery: orphaned claims (adopted + dead session)
 *  - Never-adopted coordinator claims
 *  - Dispatch adoption edge cases (session_id without adopted_at)
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptClaimSession,
  assessClaimLiveness,
  isClaimStale,
  loadClaim,
  releaseStaleClaimsFromOtherAgents,
  saveClaim,
  listClaims,
} from '../../src/core/claims.js';
import { saveCurrentSession } from '../../src/core/identity.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Claim } from '../../src/core/schema.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function makeClaim(overrides: Partial<Claim> & { id: string }): Claim {
  return {
    agent: 'test-agent',
    scope: 'src/test',
    description: 'test claim',
    created_at: hoursAgo(30), // old by default
    status: 'active',
    ...overrides,
  };
}

/** Write a session file using the real saveCurrentSession helper. */
function writeSession(
  sessionId: string,
  cwd: string,
  lastSeenAgoMs = 0,
): void {
  saveCurrentSession(
    {
      session_id: sessionId,
      started_at: hoursAgo(2),
      last_seen_at: new Date(Date.now() - lastSeenAgoMs).toISOString(),
      agent: 'test-agent',
      agent_id: 'agt_test',
      host_id: 'host_test',
    },
    cwd,
  );
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('assessClaimLiveness', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-liveness-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  describe('young claims', () => {
    it('returns young for a claim created 10 minutes ago (no session)', () => {
      const claim = makeClaim({ id: 'clm_young', created_at: minutesAgo(10) });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir });
      assert.equal(result.status, 'young');
    });

    it('returns young for a claim created 25 minutes ago (no session)', () => {
      const claim = makeClaim({ id: 'clm_young2', created_at: minutesAgo(25) });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir });
      assert.equal(result.status, 'young');
    });

    it('returns young for a claim within threshold but past 30m (no session)', () => {
      // 2h old, threshold 24h — too young to call stale
      const claim = makeClaim({ id: 'clm_mid', created_at: hoursAgo(2) });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir });
      assert.equal(result.status, 'young');
    });
  });

  describe('live session', () => {
    it('returns live when session last_seen_at is recent', () => {
      const sessionId = 'sess_live_001';
      writeSession(sessionId, workspace.dir, 0); // just now
      const claim = makeClaim({
        id: 'clm_live',
        session_id: sessionId,
        // No adopted_at — direct agent claim pattern
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'live');
      assert.ok(result.sessionAgeMs !== undefined && result.sessionAgeMs < 5_000, `sessionAgeMs should be < 5s, got ${result.sessionAgeMs}`);
    });

    it('returns live for a long-running session (36h old claim, session alive)', () => {
      // KEY REGRESSION: 36h claim should NOT be released if session is live
      const sessionId = 'sess_long_001';
      writeSession(sessionId, workspace.dir, 5 * 60_000); // last seen 5min ago
      const claim = makeClaim({
        id: 'clm_longrun',
        created_at: hoursAgo(36), // past the 24h threshold
        session_id: sessionId,
        adopted_at: hoursAgo(36),
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        thresholdHours: 24,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'live', `Long-running live session should be 'live', got '${result.status}': ${result.reason}`);
    });

    it('isClaimStale returns false for a claim with a live session', () => {
      const sessionId = 'sess_live_002';
      writeSession(sessionId, workspace.dir, 0);
      const claim = makeClaim({ id: 'clm_live2', created_at: hoursAgo(48), session_id: sessionId });
      // Without session awareness this would return true (48h > 24h threshold)
      assert.equal(isClaimStale(claim, 24, workspace.dir), false);
    });
  });

  describe('orphaned claims (crash recovery)', () => {
    it('returns orphaned when adopted session is dead', () => {
      const sessionId = 'sess_dead_001';
      // Session last seen 8h ago, TTL is 4h → dead
      writeSession(sessionId, workspace.dir, 8 * 3_600_000);
      const claim = makeClaim({
        id: 'clm_orphaned',
        session_id: sessionId,
        adopted_at: hoursAgo(8),
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'orphaned');
      assert.ok(result.reason.includes('adopted'), `Reason should mention 'adopted': ${result.reason}`);
    });

    it('returns orphaned when session file is missing entirely (process killed)', () => {
      // No session file written — simulates a process that was SIGKILL'd before cleanup
      const claim = makeClaim({
        id: 'clm_killed',
        session_id: 'sess_ghost_001',
        adopted_at: hoursAgo(10),
      });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir, sessionTtlMs: 4 * 3_600_000 });
      assert.equal(result.status, 'orphaned');
    });

    it('isClaimStale returns true for orphaned claims', () => {
      const sessionId = 'sess_dead_002';
      writeSession(sessionId, workspace.dir, 8 * 3_600_000);
      const claim = makeClaim({
        id: 'clm_orphaned2',
        session_id: sessionId,
        adopted_at: hoursAgo(8),
      });
      assert.equal(isClaimStale(claim, 24, workspace.dir), true);
    });
  });

  describe('stale claims (direct agent, session ended)', () => {
    it('returns stale when session_id set but no adopted_at and session is dead', () => {
      const sessionId = 'sess_ended_001';
      writeSession(sessionId, workspace.dir, 8 * 3_600_000); // 8h ago, TTL 4h
      const claim = makeClaim({
        id: 'clm_stale',
        session_id: sessionId,
        // No adopted_at — this is a direct bclaw_claim from an agent
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        thresholdHours: 24,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'stale');
    });

    it('pln#388 stp_168b7bfb: stale immediately when session file is missing (session ended cleanly)', () => {
      // Claim is 2h old — past the 30min YOUNG floor but well under the 24h
      // legacy threshold. With the session-aware fix we no longer require
      // wall-clock age once the session is confirmed gone.
      const claim = makeClaim({
        id: 'clm_session_gone',
        created_at: hoursAgo(2),
        session_id: 'sess_ended_cleanly',
        // No session file written — simulates session-end having deleted it.
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        thresholdHours: 24,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'stale', `expected stale, got ${result.status}: ${result.reason}`);
      assert.match(result.reason, /record is gone/);
    });

    it('pln#388 stp_168b7bfb: young when session last_seen_at is just past TTL (brief disconnect grace)', () => {
      // Session last_seen 4h ago (TTL 4h) — right at the boundary, short
      // grace window before declaring stale so a reconnecting session can
      // update its heartbeat.
      const sessionId = 'sess_briefly_dead';
      writeSession(sessionId, workspace.dir, 4 * 3_600_000 + 10_000); // ~4h01s
      const claim = makeClaim({
        id: 'clm_brief_dip',
        created_at: hoursAgo(2),
        session_id: sessionId,
      });
      const result = assessClaimLiveness(claim, {
        cwd: workspace.dir,
        thresholdHours: 24,
        sessionTtlMs: 4 * 3_600_000,
      });
      assert.equal(result.status, 'young', `expected young within grace, got ${result.status}: ${result.reason}`);
    });
  });

  describe('never-adopted claims (coordinator claims not dispatched)', () => {
    it('returns never-adopted for old claim with no session_id', () => {
      const claim = makeClaim({
        id: 'clm_never',
        created_at: hoursAgo(30),
        // No session_id — coordinator claim that was never dispatched
      });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir, thresholdHours: 24 });
      assert.equal(result.status, 'never-adopted');
      assert.ok(result.reason.includes('threshold'));
    });

    it('isClaimStale returns true for never-adopted old claims', () => {
      const claim = makeClaim({ id: 'clm_never2', created_at: hoursAgo(48) });
      assert.equal(isClaimStale(claim, 24, workspace.dir), true);
    });
  });

  describe('ageMs is accurate', () => {
    it('reports ageMs within 1 second of expected value', () => {
      const claim = makeClaim({ id: 'clm_age', created_at: hoursAgo(5) });
      const result = assessClaimLiveness(claim, { cwd: workspace.dir });
      const expectedMs = 5 * 3_600_000;
      assert.ok(
        Math.abs(result.ageMs - expectedMs) < 2_000,
        `ageMs should be ~${expectedMs}ms, got ${result.ageMs}`,
      );
    });
  });
});

describe('releaseStaleClaimsFromOtherAgents', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-release-stale-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('does NOT release a claim with a live session (long-running work protection)', () => {
    const sessionId = 'sess_live_r01';
    writeSession(sessionId, workspace.dir, 2 * 60_000); // 2min ago
    saveClaim(
      makeClaim({ id: 'clm_live_r', agent: 'other-agent', created_at: hoursAgo(36), session_id: sessionId, adopted_at: hoursAgo(36) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 0, 'Live session claim must not be released');

    const remaining = listClaims(workspace.dir).filter(c => c.status === 'active');
    assert.equal(remaining.length, 1);
  });

  it('does NOT release a young claim (no session yet)', () => {
    saveClaim(
      makeClaim({ id: 'clm_young_r', agent: 'other-agent', created_at: minutesAgo(15) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 0, 'Young claim must not be released');
  });

  it('releases an orphaned claim (crash recovery)', () => {
    const sessionId = 'sess_dead_r01';
    writeSession(sessionId, workspace.dir, 8 * 3_600_000); // dead
    saveClaim(
      makeClaim({ id: 'clm_orphaned_r', agent: 'other-agent', session_id: sessionId, adopted_at: hoursAgo(8) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]!.id, 'clm_orphaned_r');
    assert.equal(listClaims(workspace.dir).find(c => c.id === 'clm_orphaned_r')?.status, 'released');
  });

  it('releases a never-adopted coordinator claim', () => {
    saveClaim(
      makeClaim({ id: 'clm_never_r', agent: 'other-agent', created_at: hoursAgo(30) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]!.id, 'clm_never_r');
  });

  it('skips own claims (current agent) without currentSessionId — legacy compat', () => {
    saveClaim(
      makeClaim({ id: 'clm_own_r', agent: 'current-agent', created_at: hoursAgo(48) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 0, 'Own claims must never be auto-released in legacy mode');
  });

  it('pln#388 stp_e2b10ab4: same-agent crash recovery — releases prior-session claims when currentSessionId is provided', () => {
    // Prior session (crashed — no file written, so session is missing).
    // Claim belongs to the same agent but a different session than the
    // caller's current one → must be released.
    saveClaim(
      makeClaim({
        id: 'clm_own_prior',
        agent: 'current-agent',
        created_at: hoursAgo(2),
        session_id: 'sess_crashed',
        adopted_at: hoursAgo(2),
      }),
      workspace.dir,
    );
    // Current session's claim — must be preserved.
    saveClaim(
      makeClaim({
        id: 'clm_own_current',
        agent: 'current-agent',
        created_at: hoursAgo(1),
        session_id: 'sess_current',
        adopted_at: hoursAgo(1),
      }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir, 'sess_current');
    const releasedIds = result.released.map((c) => c.id);
    assert.deepEqual(releasedIds, ['clm_own_prior']);
  });

  it('handles mixed claims: releases stale, keeps live', () => {
    const liveSession = 'sess_live_mix';
    writeSession(liveSession, workspace.dir, 1_000); // 1s ago — alive

    saveClaim(
      makeClaim({ id: 'clm_mix_live', agent: 'agent-a', created_at: hoursAgo(40), session_id: liveSession, adopted_at: hoursAgo(40) }),
      workspace.dir,
    );
    saveClaim(
      makeClaim({ id: 'clm_mix_stale', agent: 'agent-b', created_at: hoursAgo(30) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]!.id, 'clm_mix_stale');

    const active = listClaims(workspace.dir).filter(c => c.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, 'clm_mix_live');
  });

  it('dispatch adoption edge case: session_id set but never formally adopted — treated as stale when old', () => {
    // Before dispatch completes: session_id is set on coordinator claim but no adopted_at yet.
    // If this is old, it should be stale (not orphaned — no crash occurred).
    const deadSessionId = 'sess_predispatch';
    writeSession(deadSessionId, workspace.dir, 10 * 3_600_000); // dead
    saveClaim(
      makeClaim({
        id: 'clm_predispatch',
        agent: 'other-agent',
        session_id: deadSessionId,
        // adopted_at intentionally absent
      }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]!.id, 'clm_predispatch');
  });

  // ── Additional regressions (pln#388 stp_a24b1871) ───────────────────────────

  it('doctor-mode sweep (no currentAgent, no currentSessionId) releases all stale claims', () => {
    // Cleanup path used by `brainclaw doctor` or ad-hoc sweeps — caller owns no
    // claims and wants the global stale floor cleared.
    saveClaim(
      makeClaim({ id: 'clm_doc_a', agent: 'agent-a', created_at: hoursAgo(30) }),
      workspace.dir,
    );
    saveClaim(
      makeClaim({ id: 'clm_doc_b', agent: 'agent-b', created_at: hoursAgo(48) }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents(undefined, workspace.dir);
    const ids = result.released.map((c) => c.id).sort();
    assert.deepEqual(ids, ['clm_doc_a', 'clm_doc_b']);
  });

  it('currentSessionId preserves multiple claims from the same session (one agent, many scopes)', () => {
    // A single worker legitimately holds claims on several adjacent files
    // under one session. The sweeper must not touch any of them.
    saveClaim(
      makeClaim({
        id: 'clm_multi_a',
        agent: 'current-agent',
        created_at: hoursAgo(3),
        session_id: 'sess_alive',
        adopted_at: hoursAgo(3),
      }),
      workspace.dir,
    );
    saveClaim(
      makeClaim({
        id: 'clm_multi_b',
        agent: 'current-agent',
        created_at: hoursAgo(2),
        session_id: 'sess_alive',
        adopted_at: hoursAgo(2),
      }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir, 'sess_alive');
    assert.equal(result.released.length, 0);
    const remainingIds = listClaims(workspace.dir)
      .filter((c) => c.status === 'active')
      .map((c) => c.id)
      .sort();
    assert.deepEqual(remainingIds, ['clm_multi_a', 'clm_multi_b']);
  });

  it('currentSessionId preserves live other-agent claim while releasing dead other-agent claim', () => {
    // Combined scenario: caller names its session; one other agent is alive,
    // one is crashed. Session-aware liveness must dominate the sweep.
    const liveSession = 'sess_other_live';
    writeSession(liveSession, workspace.dir, 30_000); // 30s ago
    saveClaim(
      makeClaim({
        id: 'clm_other_live',
        agent: 'agent-alive',
        created_at: hoursAgo(50),
        session_id: liveSession,
        adopted_at: hoursAgo(50),
      }),
      workspace.dir,
    );
    saveClaim(
      makeClaim({
        id: 'clm_other_dead',
        agent: 'agent-dead',
        created_at: hoursAgo(3),
        session_id: 'sess_other_dead',
        adopted_at: hoursAgo(3),
      }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir, 'sess_current');
    const releasedIds = result.released.map((c) => c.id);
    assert.deepEqual(releasedIds, ['clm_other_dead']);
  });

  it('coordinator claim that is still young is preserved (never-adopted path under threshold)', () => {
    // Dispatch has been issued but the worker hasn't come online yet — the
    // coordinator's claim is only minutes old and must survive the sweep.
    saveClaim(
      makeClaim({
        id: 'clm_coord_fresh',
        agent: 'other-agent',
        created_at: minutesAgo(10),
        // No session_id — coordinator is pre-dispatch
      }),
      workspace.dir,
    );

    const result = releaseStaleClaimsFromOtherAgents('current-agent', workspace.dir);
    assert.equal(result.released.length, 0, 'young coordinator claim must not be released');
    assert.equal(
      listClaims(workspace.dir).find((c) => c.id === 'clm_coord_fresh')?.status,
      'active',
    );
  });
});

// ── Long-running session regressions (pln#388 stp_a24b1871) ────────────────

describe('assessClaimLiveness — extreme long-running sessions', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-longrun-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('72h-old claim with fresh heartbeat is still live', () => {
    const sessionId = 'sess_72h';
    writeSession(sessionId, workspace.dir, 10_000); // 10s ago
    const claim = makeClaim({
      id: 'clm_72h',
      created_at: hoursAgo(72),
      session_id: sessionId,
      adopted_at: hoursAgo(72),
    });
    const result = assessClaimLiveness(claim, {
      cwd: workspace.dir,
      thresholdHours: 24,
      sessionTtlMs: 4 * 3_600_000,
    });
    assert.equal(result.status, 'live', `72h claim with live session must be live, got ${result.status}: ${result.reason}`);
  });

  it('7-day claim with fresh heartbeat is still live (no wall-clock cap on liveness)', () => {
    const sessionId = 'sess_week';
    writeSession(sessionId, workspace.dir, 60_000); // 1min ago
    const claim = makeClaim({
      id: 'clm_week',
      created_at: hoursAgo(24 * 7),
      session_id: sessionId,
      adopted_at: hoursAgo(24 * 7),
    });
    assert.equal(
      assessClaimLiveness(claim, { cwd: workspace.dir, sessionTtlMs: 4 * 3_600_000 }).status,
      'live',
    );
    assert.equal(isClaimStale(claim, 24, workspace.dir), false);
  });

  it('session TTL boundary: exactly at TTL is treated as dead (enters grace window)', () => {
    // A session whose last_seen_at sits right at the TTL boundary must not be
    // classified as 'live'. We accept either 'young' (grace) or 'stale' here
    // because the exact boundary depends on ms-level timing; both are safe
    // outcomes (do-not-release for grace, release for stale).
    const sessionId = 'sess_boundary';
    writeSession(sessionId, workspace.dir, 4 * 3_600_000); // exactly TTL
    const claim = makeClaim({
      id: 'clm_boundary',
      created_at: hoursAgo(2),
      session_id: sessionId,
    });
    const result = assessClaimLiveness(claim, {
      cwd: workspace.dir,
      thresholdHours: 24,
      sessionTtlMs: 4 * 3_600_000,
    });
    assert.notEqual(result.status, 'live', `boundary session must not be 'live', got '${result.status}'`);
  });
});

// ── adoptClaimSession regression (pln#388 stp_a24b1871) ────────────────────

describe('adoptClaimSession — dispatch adoption edge cases', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-adopt-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('idempotent: same session re-adopting its own claim succeeds and refreshes adopted_at', () => {
    const sessionId = 'sess_self';
    writeSession(sessionId, workspace.dir, 0);
    const originalAdopt = hoursAgo(1);
    saveClaim(
      makeClaim({
        id: 'clm_idem',
        session_id: sessionId,
        adopted_at: originalAdopt,
      }),
      workspace.dir,
    );

    const result = adoptClaimSession('clm_idem', sessionId, workspace.dir);
    assert.equal(result.adopted, true, 're-adoption by same session must succeed');

    const reloaded = loadClaim('clm_idem', workspace.dir);
    assert.equal(reloaded.session_id, sessionId);
    assert.ok(reloaded.adopted_at, 'adopted_at remains set');
    assert.notEqual(reloaded.adopted_at, originalAdopt, 'adopted_at is refreshed on re-adoption');
  });

  it('refuses adoption when claim is not active (already released)', () => {
    saveClaim(
      {
        ...makeClaim({ id: 'clm_released', created_at: hoursAgo(1) }),
        status: 'released',
        released_at: new Date().toISOString(),
      },
      workspace.dir,
    );

    const result = adoptClaimSession('clm_released', 'sess_new', workspace.dir);
    assert.equal(result.adopted, false);
    assert.match(result.reason, /not active/);
  });

  it('adopts a fresh coordinator claim (no session_id yet) — happy path for dispatch', () => {
    // Classic dispatch flow: coordinator creates the claim with no session_id,
    // worker starts up and calls adoptClaimSession with its own session.
    saveClaim(
      makeClaim({
        id: 'clm_fresh_coord',
        agent: 'worker-agent',
        created_at: minutesAgo(5),
        // No session_id, no adopted_at — coordinator hasn't linked a worker
      }),
      workspace.dir,
    );

    const result = adoptClaimSession('clm_fresh_coord', 'sess_worker', workspace.dir);
    assert.equal(result.adopted, true);

    const reloaded = loadClaim('clm_fresh_coord', workspace.dir);
    assert.equal(reloaded.session_id, 'sess_worker');
    assert.ok(reloaded.adopted_at, 'adopted_at is set on first adoption');
  });

  it('Codex r1: sequential adoption race on a dead-session claim — second call sees first session and refuses if live', () => {
    // Both reconnecting workers observe the same dead prior session.
    // The atomic adopt wraps load/decide/save in one mutate(); after the
    // FIRST adoption, a LIVE session file is written for sess_reclaim_a,
    // so the second call must observe the live session and refuse.
    saveClaim(
      makeClaim({
        id: 'clm_race',
        created_at: hoursAgo(2),
        session_id: 'sess_crashed',
        adopted_at: hoursAgo(2),
      }),
      workspace.dir,
    );

    const resultA = adoptClaimSession('clm_race', 'sess_reclaim_a', workspace.dir);
    assert.equal(resultA.adopted, true, 'first adopter wins');

    // After adopter A owns the claim, its session goes live (worker starts
    // emitting heartbeats). A straggler adopter B that was still looking at
    // the OLD dead session file must be refused once it contends.
    writeSession('sess_reclaim_a', workspace.dir, 0);

    const resultB = adoptClaimSession('clm_race', 'sess_reclaim_b', workspace.dir);
    assert.equal(resultB.adopted, false, 'second adopter refused because winner is now live');
    assert.match(resultB.reason, /live session/);

    // Claim still belongs to A.
    const reloaded = loadClaim('clm_race', workspace.dir);
    assert.equal(reloaded.session_id, 'sess_reclaim_a');
  });
});
