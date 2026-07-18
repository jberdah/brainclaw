import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchTick, parseChildCommsByPpid, type WatchTickInput } from '../../src/commands/dispatch-watch.js';

/**
 * Each case replays a real scenario from the 2026-06-10 coordination session —
 * the day the heuristics were hand-validated by five ad-hoc bash monitors.
 */

function tick(overrides: Partial<WatchTickInput>): WatchTickInput {
  return {
    health: 'healthy',
    runStatus: 'running',
    laneResultStatus: undefined,
    pidAlive: true,
    agentChildAlive: true,
    commitsAhead: 0,
    dirtyTracked: 0,
    fsActivityMs: 60 * 60_000, // stale by default; freshness is opt-in per case
    ...overrides,
  };
}

describe('dispatch watch — evaluateWatchTick decision core', () => {
  it('healthy in-flight worker keeps running', () => {
    assert.equal(evaluateWatchTick(tick({ dirtyTracked: 12 })), 'running');
  });

  it('LANE-RESULT completed wins over everything (sandboxed codex, asgn_b0169fd8)', () => {
    assert.equal(
      evaluateWatchTick(tick({ laneResultStatus: 'completed', pidAlive: false, agentChildAlive: false })),
      'lane-result',
    );
  });

  it('LANE-RESULT failed reports failure even with commits present', () => {
    assert.equal(
      evaluateWatchTick(tick({ laneResultStatus: 'failed', commitsAhead: 3 })),
      'failed',
    );
  });

  it('committed-clean: the claude -p delivered-but-end-stalled pattern (agent-writers d2078e8)', () => {
    // Everything on the branch, tree clean, worker quiescent (child gone, fs stale).
    assert.equal(
      evaluateWatchTick(tick({ commitsAhead: 1, dirtyTracked: 0, agentChildAlive: false })),
      'committed-clean',
    );
  });

  it('clean tree BETWEEN incremental commits with a live worker is still running (stp_a1fe2b76 false positive)', () => {
    assert.equal(
      evaluateWatchTick(tick({ commitsAhead: 1, dirtyTracked: 0, agentChildAlive: true })),
      'running',
    );
  });

  it('clean tree between steps with fresh fs activity is still running (unobservable child)', () => {
    assert.equal(
      evaluateWatchTick(tick({ commitsAhead: 2, dirtyTracked: 0, agentChildAlive: undefined, fsActivityMs: 30_000 })),
      'running',
    );
  });

  it('commits + dirty tree is still running (mid-work, incremental commits)', () => {
    assert.equal(
      evaluateWatchTick(tick({ commitsAhead: 2, dirtyTracked: 5 })),
      'running',
    );
  });

  it('worker-process-gone: wrapper alive, agent child dead, work uncommitted (sprint-1.5 worker)', () => {
    assert.equal(
      evaluateWatchTick(tick({ pidAlive: true, agentChildAlive: false, dirtyTracked: 41 })),
      'worker-process-gone',
    );
  });

  it('worker-process-gone: instant death with zero work (agent-ux attempt 1)', () => {
    assert.equal(
      evaluateWatchTick(tick({ pidAlive: true, agentChildAlive: false })),
      'worker-process-gone',
    );
  });

  it('whole tree dead with nothing delivered is worker-process-gone', () => {
    assert.equal(
      evaluateWatchTick(tick({ pidAlive: false, agentChildAlive: false })),
      'worker-process-gone',
    );
  });

  it('failed child-probe observation is NEVER treated as death (undefined ≠ false)', () => {
    assert.equal(
      evaluateWatchTick(tick({ agentChildAlive: undefined, dirtyTracked: 3 })),
      'running',
    );
  });

  it('administrative run status completed converges without lane-result', () => {
    assert.equal(evaluateWatchTick(tick({ runStatus: 'completed' })), 'completed');
  });

  it('administrative failed/timed_out converge to failed', () => {
    assert.equal(evaluateWatchTick(tick({ runStatus: 'failed' })), 'failed');
    assert.equal(evaluateWatchTick(tick({ runStatus: 'timed_out' })), 'failed');
  });

  it('fresh fs activity vetoes process-gone: stale tracked pid after manual respawn (agent-ux attempt 2)', () => {
    // The run record still points at the dead attempt-1 wrapper, but the
    // respawned worker is visibly writing — pln#527 veto applied to the watch.
    assert.equal(
      evaluateWatchTick(tick({ pidAlive: false, agentChildAlive: false, dirtyTracked: 8, commitsAhead: 1, fsActivityMs: 30_000 })),
      'running',
    );
  });

  it('git evidence beats administrative interrupted status (expired-while-working, can_948acfd6)', () => {
    // Run relabeled interrupted by the acceptance-TTL sweep while the worker
    // had actually delivered and gone quiescent: commits clean → done, not failed.
    assert.equal(
      evaluateWatchTick(tick({ runStatus: 'interrupted', commitsAhead: 5, dirtyTracked: 0, agentChildAlive: false })),
      'committed-clean',
    );
  });
});

// trp_3b096bf4 — the child-pid probe filters `ps -A -o ppid=,comm=` output by
// ppid in JS (BSD `ps` on macOS rejects the GNU `--ppid` flag). Cover the parse
// directly so the fix is validated regardless of the platform the test runs on.
describe('dispatch watch — parseChildCommsByPpid (cross-platform child probe)', () => {
  it('filters by parent pid and lowercases the command (Linux bare comm)', () => {
    const out = '  501 codex\n  501 node\n    1 systemd\n  777 bash\n';
    assert.deepEqual(parseChildCommsByPpid(out, 501), ['codex', 'node']);
  });

  it('handles macOS full-path comm (so AGENT_CHILD_NAMES .includes still matches)', () => {
    const out = '  902 /usr/local/bin/CODEX\n  902 /usr/bin/node\n    1 /sbin/launchd\n';
    const comms = parseChildCommsByPpid(out, 902);
    assert.deepEqual(comms, ['/usr/local/bin/codex', '/usr/bin/node']);
    assert.ok(comms.some((c) => c.includes('codex')), 'a full-path codex child is still detectable');
  });

  it('returns empty for a ppid with no children, and ignores blank/malformed lines', () => {
    const out = '  501 codex\n\n   garbage-no-ppid\n    1 systemd\n';
    assert.deepEqual(parseChildCommsByPpid(out, 999), []);
  });

  it('does not match a pid that only appears as a child pid, only as ppid', () => {
    // "  501 codex" — 501 is the PARENT here; querying for a different ppid must
    // not return it, and the command token (codex) is never mistaken for a ppid.
    const out = '  501 codex\n 1234 node\n';
    assert.deepEqual(parseChildCommsByPpid(out, 1234), ['node']);
  });
});
