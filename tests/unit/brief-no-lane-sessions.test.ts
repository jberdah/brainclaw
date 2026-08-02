/**
 * pln#638 PR-6a — a dispatched lane's brief never instructs a session.
 *
 * Decided by ideation lop_2d838a638b1e2956 (design of record:
 * pln638-pr6-and-claim-convergence-synthesis.md). A session is an AGENT's
 * lifecycle, and its effects overflow the lane:
 *
 *  - `session-end --auto-release` releases ALL of the agent's active claims
 *    (session-end.ts) — one finishing lane could tear down its siblings' work;
 *  - the session handoff aggregates ALL the agent's commits and claims;
 *  - the engine already scrubs SESSION_ID from the worker env
 *    (execution-profile.ts) — the design said "no session here" long before the
 *    brief text caught up.
 *
 * Yet the claim-only and no-claim branches of buildProtocolSection told every
 * dispatched worker to call bclaw_session_start and bclaw_session_end — and no
 * test pinned it, which is how it survived: removing the instructions left
 * 411/411 green.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolSection, generateDispatchBrief } from '../../src/core/dispatcher.js';

describe('pln#638 PR-6a — no session lifecycle in dispatched-lane briefs', () => {
  it('the claim-only branch neither starts nor ends a session', () => {
    const s = buildProtocolSection({ claimId: 'clm_x', worktreePath: '/tmp/wt' });
    assert.doesNotMatch(s, /Call bclaw_session_start/, 'a lane must not be told to start a session');
    assert.doesNotMatch(s, /Call bclaw_session_end/, 'session_end tears down claims beyond the lane');
    // The claim lifecycle survives untouched.
    assert.match(s, /bclaw_release_claim\(id: "clm_x"/);
  });

  it('the no-claim branch neither starts nor ends a session', () => {
    const s = buildProtocolSection({});
    assert.doesNotMatch(s, /Call bclaw_session_start/);
    assert.doesNotMatch(s, /Call bclaw_session_end/);
    assert.match(s, /bclaw_claim to claim the scope/);
  });

  it('both branches say WHY, so the next editor does not "fix" the omission', () => {
    // An unexplained absence reads as an oversight and gets reverted. The brief
    // must carry the reason: sessions belong to interactive agents.
    for (const opts of [{ claimId: 'clm_x' }, {}]) {
      const s = buildProtocolSection(opts);
      assert.match(s, /Do NOT call bclaw_session_start \/ bclaw_session_end/);
      assert.match(s, /sessions belong to interactive agents/);
    }
  });

  it('the session tools are no longer advertised in Available tools', () => {
    const s = buildProtocolSection({ claimId: 'clm_x' });
    assert.doesNotMatch(
      s, /- bclaw_session_start, bclaw_session_end \(session lifecycle\)/,
      'listing the tools invites the calls the protocol just forbade',
    );
  });

  it('the assignment branch is unchanged — it never instructed sessions', () => {
    const s = buildProtocolSection({ assignmentId: 'asgn_x', claimId: 'clm_x', worktreePath: '/tmp/wt' });
    assert.match(s, /bclaw_assignment_update\(assignment_id: "asgn_x", status: "accepted"\)/);
    assert.doesNotMatch(s, /Call bclaw_session_start/);
  });

  it('EMISSION: the delivered dispatch brief carries the prohibition', () => {
    // Surface, not helper — the session's standing rule.
    const brief = generateDispatchBrief({ task: 'do the thing', agent: 'codex', claimId: 'clm_y' });
    assert.doesNotMatch(brief, /Call bclaw_session_start/);
    assert.match(brief, /Do NOT call bclaw_session_start/);
  });
});
