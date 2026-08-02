/**
 * pln#638 PR-3 — one capability verdict per agent, everywhere a brief is built.
 *
 * ## What the ideation loop actually found
 *
 * The plan said "two renderers compute the capability independently — give them a
 * shared transport object". Reading the code changed that:
 *
 *  - `buildCoordinateBrief` is a thin wrapper that DELEGATES to
 *    `generateDispatchBrief`, so those two cannot diverge at all.
 *  - `hasMcp` vs `runtime.mcp_direct` disagree on **0 of 19** profiles, so a
 *    reconciliation layer would have been complexity bought against a case that
 *    does not exist.
 *
 * The real divergence was narrower and concrete: `generateBrief` receives
 * `briefMode` from its CALLER but resolves the capability profile itself from
 * `options.agent` — and the `--dry-run` path called it WITHOUT `agent` while the
 * real dispatch path passed it. So a preview claimed `canCommit: true` for a
 * sandboxed worker, dropped the MCP-less LANE-RESULT section, and lost the
 * `sandboxed` liveness flag. A preview that lies about the shipped artifact.
 *
 * These tests pin the invariant rather than the plumbing: whatever a brief says
 * about an agent's capabilities must be the same on every path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  DEFAULT_CAPABILITY_PROFILES,
  dispatchCanCommit,
  dispatchHasMcp,
  getCapabilityProfile,
  resolveBriefMode,
} from '../../src/core/agent-capability.js';

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found from ${import.meta.dirname}`);
}

describe('pln#638 PR-3 — capability coherence across brief paths', () => {
  it('every generateBrief callsite passes `agent` (the dry-run bug)', () => {
    // AST, NOT regex — and that is not a style preference, it is the second time
    // in one session a regex guard turned out vacuous. The first draft of THIS
    // test matched `generateBrief\(([\s\S]*?)\n\s*\);`, which requires the call to
    // end on its own line. The buggy dry-run call was a SINGLE line, so the guard
    // matched only the already-correct multi-line callsite: 1 of 2, and blind to
    // exactly the defect it existed for.
    const file = path.join(findRepoRoot(), 'src/core/dispatcher.ts');
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.ESNext, true);

    const offenders: string[] = [];
    let seen = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'generateBrief') {
        seen += 1;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        // The options bag is the last argument; find an object literal among the
        // arguments rather than assuming a fixed position, so adding a parameter
        // upstream does not silently blind this check.
        const bag = node.arguments.find(ts.isObjectLiteralExpression);
        const passesAgent = bag?.properties.some((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
          && ts.isIdentifier(p.name) && p.name.text === 'agent') ?? false;
        if (!passesAgent) offenders.push(`dispatcher.ts:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    assert.ok(seen >= 2, `expected at least 2 generateBrief callsites, found ${seen} — the AST walk went blind`);
    assert.deepEqual(
      offenders, [],
      'these generateBrief callsites omit `agent`, so the brief cannot resolve capability and '
      + `silently claims canCommit:true, drops the MCP-less fallback, and loses the sandboxed flag:\n${offenders.join('\n')}`,
    );
  });

  it('the two capability fields agree on EVERY shipped profile', () => {
    // The latent risk the loop measured at 0/19. Kept as a guard rather than
    // engineered around: if a profile ever makes them disagree, that is a design
    // decision that must be made consciously, not discovered in a brief.
    //
    // They are semantically distinct on purpose — `hasMcp` = "the agent supports
    // MCP", `runtime.mcp_direct` = "a spawned run reaches it" — so this test is
    // NOT saying they should be merged. It says: no profile diverges today, and
    // one that starts to must announce itself here.
    const diverging = Object.values(DEFAULT_CAPABILITY_PROFILES)
      .filter((p) => p.hasMcp !== p.runtime.mcp_direct)
      .map((p) => `${p.name}: hasMcp=${p.hasMcp} runtime.mcp_direct=${p.runtime.mcp_direct}`);
    assert.deepEqual(
      diverging, [],
      'a profile now makes the two MCP fields disagree. resolveBriefMode reads hasMcp while the '
      + `dispatch path reads runtime.mcp_direct, so this WILL produce two verdicts for one agent:\n${diverging.join('\n')}`,
    );
  });

  it('a sandboxed profile is never told it may commit', () => {
    // The user-visible half of the dry-run bug: codex runs
    // `--sandbox workspace-write`, whose .git is read-only.
    const codex = getCapabilityProfile('codex');
    assert.ok(codex, 'codex profile must exist');
    assert.equal(dispatchCanCommit(codex), false, 'a sandboxed spawn cannot commit');
    assert.equal(dispatchHasMcp(codex), true, 'the sandbox does not sever MCP — only .git');
  });

  it('tier-C profiles report no MCP, so the file fallback is reachable', () => {
    // These are the profiles the LANE-RESULT branch exists for. If any of them
    // ever reports MCP, that branch stops being emitted for them.
    for (const name of ['nanoclaw', 'nemoclaw', 'picoclaw', 'zeroclaw']) {
      const p = getCapabilityProfile(name);
      assert.ok(p, `${name} profile must exist`);
      assert.equal(dispatchHasMcp(p), false, `${name} must report no MCP so the LANE-RESULT fallback is emitted`);
    }
  });

  it('resolveBriefMode never promises `full` capability to an unknown agent silently', () => {
    // Documented behaviour: unknown → 'full'. Pinned so the fallback is a
    // decision on record rather than an accident — the loop flagged that a brief
    // must never ASSERT a capability it cannot verify, and an unknown agent is
    // the case where that matters most.
    assert.equal(resolveBriefMode('definitely-not-a-real-agent'), 'full');
  });
});
