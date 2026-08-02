/**
 * pln#638 PR-4 — the brief never ASSERTS a capability it cannot verify.
 *
 * ## The production incident this is built from
 *
 * During pln#638's own ideation, a codex critic ran with `runtime.mcp_direct=true`
 * and **no reachable MCP**. Its 3654-character critique survived because that
 * brief spelled out a file fallback by hand.
 *
 * Precise about the gap, because the first draft of this file overstated it:
 * `buildProtocolSection` HAS emitted a fallback since pln#526 — but only for
 * full-mode briefs that carry an assignment id. A compact-mode brief, or one
 * without an assignment id, got nothing. And no path told a declared-MCP worker
 * what to do when the declaration turns out false.
 *
 * `runtime.mcp_direct` is a STATIC flag. It says nothing about whether the config
 * exists on this machine, whether the server started, or whether stdio came up.
 * So the brief states an EXPECTATION and names the fallback; the worker decides
 * from what it observes.
 *
 * ## WHY THIS FILE TESTS THE BUILDERS, NOT JUST THE HELPER
 *
 * The first draft tested `buildTransportSection` alone. Reverting the emission
 * back to `!dispatchHasMcp` would have left the whole suite green — the exact
 * shape of the `base_sha` failure (a green unit test on a mechanism no surface
 * reaches). Review caught it. The emission assertions below are the ones that
 * matter; the helper assertions merely localise a failure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransportSection,
  generateDispatchBrief,
  laneResultShape,
} from '../../src/core/dispatcher.js';

describe('pln#638 PR-4 — transport section', () => {
  it('a DECLARED-MCP agent gets a conditional fallback, not a promise', () => {
    // The gap the incident exposed. Before this, hasMcp:true produced NO section.
    const s = buildTransportSection({ hasMcp: true, assignmentId: 'asgn_x' });
    assert.match(s, /DECLARATION, not a verified fact/, 'the brief must not assert the capability');
    assert.match(s, /If `bclaw_\*` tools respond/, 'the MCP branch must be conditional');
    assert.match(s, /If they are unavailable or error/, 'the failure branch must exist');
    assert.match(s, /LANE-RESULT\.json/, 'the fallback must be named, not implied');
    assert.match(s, /asgn_x/, 'the assignment id must be interpolated so the worker need not guess it');
  });

  it('a declared-MCP agent is told to KEEP its work, not to stop', () => {
    // The behaviour that saved 3654 characters: "do not stop and do not discard".
    const s = buildTransportSection({ hasMcp: true });
    assert.match(s, /do not stop and do not discard your work/i);
  });

  it('an MCP-less agent still gets the hard file-only protocol', () => {
    const s = buildTransportSection({ hasMcp: false, assignmentId: 'asgn_y' });
    assert.match(s, /no MCP \(file protocol only\)/);
    assert.match(s, /Do NOT call bclaw_\* tools/, 'tier C must be told the tools are unavailable');
    assert.match(s, /asgn_y/);
  });

  it('naming the store path is fine — NOT saying to create it is not', () => {
    // This assertion replaces a WRONG one. The first draft asserted that neither
    // variant may mention `.brainclaw/`, on the inference that a gitignored path
    // "does not exist in the worktree". That inference was wrong, and review
    // caught it: gitignored means not CHECKED OUT, not uncreatable — and a real
    // shipped consumer reads exactly that directory inside worker worktrees
    // (collectWorktreeCandidateFiles, harvest.ts:191-205, exposed as
    // bclaw_harvest_candidates). Removing the instruction orphaned the channel.
    //
    // The genuine invariant: a tier-C brief may name the path, but must tell the
    // worker to create it, because a fresh worktree will not have it.
    const tierC = buildTransportSection({ hasMcp: false });
    assert.match(tierC, /\.brainclaw\/coordination\/inbox\//, 'the candidate channel must be named for a file-protocol worker');
    assert.match(tierC, /create the directory if it does not exist/, 'a fresh worktree lacks it, so the instruction must say so');

    // The declared-MCP variant has no business naming the store: it either uses
    // MCP or writes LANE-RESULT at the worktree root.
    assert.doesNotMatch(buildTransportSection({ hasMcp: true }), /\.brainclaw\//);
  });

  it('both variants ask for a `body`, so a substantial output has somewhere to land', () => {
    // trp_8efdbf9d: three substantial reviews were once reduced to a one-line
    // summary because the contract had nowhere to put the reasoning.
    for (const hasMcp of [true, false]) {
      const s = buildTransportSection({ hasMcp });
      assert.match(s, /"body":/, `hasMcp=${hasMcp}: the LANE-RESULT shape must include body`);
    }
  });

  it('falls back to a placeholder assignment id rather than emitting "undefined"', () => {
    const s = buildTransportSection({ hasMcp: false });
    assert.match(s, /<assignment_id>/);
    assert.doesNotMatch(s, /undefined/);
  });

  it('ONE LANE-RESULT shape, quoted by every brief that mentions it', () => {
    // There were two: buildProtocolSection asked for {summary, files_changed,
    // artifacts} with no `body`, the transport section asked for `body`. A
    // full-mode worker got both and had to guess — and guessing the older one
    // recreated trp_8efdbf9d.
    const shape = laneResultShape('asgn_z');
    assert.match(shape, /"body":/);
    assert.match(shape, /"artifacts":/);
    assert.match(shape, /asgn_z/);
    const brief = generateDispatchBrief({ task: 'do a thing', agent: 'codex', assignmentId: 'asgn_z' });
    assert.ok(brief.includes(shape), 'the brief must quote the shared shape verbatim, not a variant of it');
  });
});

/**
 * THE ASSERTIONS THAT ACTUALLY PIN THE FIX — on the delivered brief.
 *
 * Every test above could pass while no brief emitted a transport section at all.
 * These cannot.
 */
describe('pln#638 PR-4 — the section is EMITTED by the brief builder', () => {
  const brief = (agent: string): string =>
    generateDispatchBrief({ task: 'review the thing', agent, assignmentId: 'asgn_e', worktreePath: '/tmp/wt' });

  it('a declared-MCP agent (codex) receives the conditional section', () => {
    // The revert-detector: putting the `!dispatchHasMcp` gate back makes THIS fail.
    const b = brief('codex');
    assert.match(b, /Transport: MCP expected, file fallback if not/);
    assert.match(b, /DECLARATION, not a verified fact/);
    assert.match(b, /LANE-RESULT\.json/);
  });

  it('a declared-MCP agent is NOT told its runtime has no MCP', () => {
    // Guards the opposite regression: emitting the tier-C wording to codex would
    // contradict the rest of its brief (dec#133).
    assert.doesNotMatch(brief('codex'), /no MCP \(file protocol only\)/);
  });

  it('a tier-C agent receives the hard file-only section, with the candidate channel', () => {
    const b = brief('nanoclaw');
    assert.match(b, /no MCP \(file protocol only\)/);
    assert.match(b, /Do NOT call bclaw_\* tools/);
    // The instruction whose removal orphaned harvest.ts:191-205. It must name the
    // path AND tell the worker to create it, since a fresh worktree lacks it.
    assert.match(b, /\.brainclaw\/coordination\/inbox\//);
    assert.match(b, /create the directory if it does not exist/);
  });

  it('an UNKNOWN agent gets the conditional section, never silence', () => {
    // Gating on a resolved profile left an unknown agent with an MCP-asserting
    // brief and no fallback — the case the whole principle exists for.
    const b = brief('some-agent-we-have-never-seen');
    assert.match(b, /Transport: MCP expected, file fallback if not/);
  });
});
