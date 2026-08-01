/**
 * pln#636 — claim liveness must honour FILE evidence (trp_4d0fc2ef).
 *
 * THE ASYMMETRY THIS CLOSES. A spawned sandboxed worker cannot reach MCP, so it
 * cannot maintain any server-side liveness record. The project's answer is
 * filesystem evidence: the dispatcher injects a "Liveness — DO THIS FIRST" step
 * into every brief and the worker writes/refreshes a heartbeat in the one place a
 * sandbox can write — its own worktree. `assignment-sweeper` already trusts that
 * evidence. `assessClaimLiveness` did not, so the same worker kept its ASSIGNMENT
 * alive while its CLAIM aged out on wall-clock alone.
 *
 * Worse for the case that matters: a coordinator-created claim carries no
 * `session_id`, so it fell straight to the age-only branch. The exact shape of a
 * dispatched sandboxed worker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessClaimLiveness } from '../../src/core/claims.js';
import { getWorktreeHeartbeatPath } from '../../src/core/runtime-signals.js';
import type { Claim } from '../../src/core/schema.js';

const HOUR = 3_600_000;

function coordinatorClaim(overrides: Partial<Claim> = {}): Claim {
  // The shape createCoordinatorClaim actually produces: no session_id.
  return {
    id: 'clm_test',
    agent: 'codex',
    scope: 'src/core',
    description: 'dispatched work',
    created_at: new Date(Date.now() - 30 * HOUR).toISOString(),
    status: 'active',
    assignment_id: 'asgn_test',
    ...overrides,
  } as Claim;
}

/**
 * FIXTURE NOTE, learned the hard way while writing this file.
 *
 * It deliberately uses a RAW temp dir instead of `createTestWorkspace`. Two
 * separate concurrency hazards bit, and both are worth recording:
 *
 *  1. Under `--test-isolation=none` node runs a suite's tests concurrently
 *     (visible in a failure trace as `at async Promise.all`), so a `beforeEach`
 *     that reassigns a shared fixture variable lets one test stomp another's.
 *     `concurrency: false` fixes that — and is kept below.
 *  2. Node also runs test FILES concurrently in the same process, and
 *     `createTestWorkspace` mutates process-wide state (HOME, BRAINCLAW_AGENT*,
 *     BRAINCLAW_STORE_BOUNDARY). Another file's setup/teardown interleaving with
 *     this one produced a DIFFERENT failure set on each run while the
 *     implementation was provably correct in isolation.
 *
 * This suite never resolves an identity or a store — it only needs a directory —
 * so importing that env mutation bought nothing and cost determinism.
 */
describe('claim liveness — fresh file evidence proves life', { concurrency: false }, () => {
  let root: string;
  let worktree: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-claim-evidence-'));
    worktree = path.join(root, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function writeWorktreeHeartbeat(assignmentId: string, ageMs = 0): void {
    const hb = getWorktreeHeartbeatPath(worktree, assignmentId);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, `work_loop_reached ${assignmentId}`);
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(hb, when, when);
    }
  }

  it('a 30h-old coordinator claim with a FRESH heartbeat is live, not stale', () => {
    // The headline case: no session_id, way past the 24h threshold, but the
    // worker is demonstrably working. Before this change it aged out.
    writeWorktreeHeartbeat('asgn_test');
    const verdict = assessClaimLiveness(
      coordinatorClaim({ worktree_path: worktree }),
      { cwd: root },
    );
    assert.equal(verdict.status, 'live');
    assert.match(verdict.reason, /file evidence/i);
    assert.ok(verdict.evidenceAgeMs !== undefined, 'the evidence age must be reported');
  });

  it('a STALE heartbeat does not keep the claim alive', () => {
    // Evidence must be fresh, not merely present — otherwise a worker that died
    // right after step 0 would hold its claim forever.
    writeWorktreeHeartbeat('asgn_test', 90 * 60_000); // 90 min old, TTL is 30
    const verdict = assessClaimLiveness(
      coordinatorClaim({ worktree_path: worktree }),
      { cwd: root },
    );
    assert.notEqual(verdict.status, 'live');
  });

  it('evidence outranks a DEAD session — a sandboxed worker has no live session', () => {
    // A claim can carry a session_id it never refreshes (last_seen_at is stamped
    // once at session start and nothing bumps it). Evidence has to win, or the
    // session reasoning silently overrides the only signal a sandbox can emit.
    writeWorktreeHeartbeat('asgn_test');
    const verdict = assessClaimLiveness(
      coordinatorClaim({
        worktree_path: worktree,
        session_id: 'sess_long_dead',
        adopted_at: new Date(Date.now() - 29 * HOUR).toISOString(),
      }),
      { cwd: root, sessionTtlMs: 1 },
    );
    assert.equal(verdict.status, 'live', 'fresh evidence must outrank a dead session record');
  });

  it('filesystem activity in the worktree counts, not just the heartbeat file', () => {
    // pln#527's point: a worker can be actively editing while its heartbeat is
    // frozen (written once at step 0 and never refreshed).
    fs.writeFileSync(path.join(worktree, 'edited.ts'), 'export const x = 1;\n');
    const verdict = assessClaimLiveness(
      coordinatorClaim({ worktree_path: worktree }),
      { cwd: root },
    );
    assert.equal(verdict.status, 'live');
  });

  it('no assignment_id means no evidence to read — falls back unchanged', () => {
    // A hand-made claim has nothing to correlate; behaviour must be exactly what
    // it was before this change.
    const verdict = assessClaimLiveness(
      coordinatorClaim({ assignment_id: undefined }),
      { cwd: root },
    );
    assert.notEqual(verdict.status, 'live');
    assert.equal(verdict.evidenceAgeMs, undefined);
  });

  it('a young claim is still young — the evidence branch never overrides that', () => {
    writeWorktreeHeartbeat('asgn_test');
    const verdict = assessClaimLiveness(
      coordinatorClaim({
        worktree_path: worktree,
        created_at: new Date().toISOString(),
      }),
      { cwd: root },
    );
    assert.equal(verdict.status, 'young', 'the <30min guard must keep precedence');
  });

  it('ignores GROSSLY future-dated evidence rather than inventing liveness', () => {
    // The heartbeat is the only file in the worktree, so discarding it leaves no
    // evidence at all — no need to neuter the TTL to make the point.
    writeWorktreeHeartbeat('asgn_test');
    const hb = getWorktreeHeartbeatPath(worktree, 'asgn_test');
    const future = new Date(Date.now() + 10 * HOUR);
    fs.utimesSync(hb, future, future);
    const verdict = assessClaimLiveness(
      coordinatorClaim({ worktree_path: worktree }),
      { cwd: root },
    );
    assert.notEqual(verdict.status, 'live');
    assert.equal(verdict.evidenceAgeMs, undefined, 'an untrustworthy timestamp must yield no evidence');
  });

  it('a SLIGHTLY future timestamp counts as just-now, not as skew', () => {
    // THE REGRESSION THIS PINS. NTFS mtime is sub-millisecond while Date.now()
    // is coarser, so evidence written microseconds ago stats as newer than now.
    // A naive `age < 0 → discard` therefore threw away the freshest evidence
    // possible, and the verdict flipped between `live` and `never-adopted`
    // depending on machine load. 2s ahead stands in for that artefact.
    writeWorktreeHeartbeat('asgn_test');
    const hb = getWorktreeHeartbeatPath(worktree, 'asgn_test');
    const soon = new Date(Date.now() + 2_000);
    fs.utimesSync(hb, soon, soon);
    const verdict = assessClaimLiveness(
      coordinatorClaim({ worktree_path: worktree }),
      { cwd: root },
    );
    assert.equal(verdict.status, 'live');
    assert.equal(verdict.evidenceAgeMs, 0, 'a slightly-future timestamp clamps to age 0');
  });

  it('never throws when the worktree path is gone', () => {
    assert.doesNotThrow(() => assessClaimLiveness(
      coordinatorClaim({ worktree_path: path.join(root, 'does-not-exist') }),
      { cwd: root },
    ));
  });
});
