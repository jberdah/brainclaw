/**
 * Source-level invariants for the incremental tree refresh (pln#457).
 *
 * The refresh path can't be unit-tested without spinning up VS Code, so we
 * pin the contract at the source level: every leaf builder must pass a
 * stable treeId so VS Code can reconcile items across refreshes, and the
 * refresh driver must go through the diff-and-fire helper instead of
 * blindly firing the root.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..');
const boardTreeSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'board-tree.ts'), 'utf-8');

describe('refresh-diff — stable leaf IDs', () => {
  // Each leaf builder is expected to pass a treeId string as the last arg to
  // the BrainclawTreeItem constructor. The treeId carries the entity kind
  // and either the entity id or a deterministic fallback (index, rank, name).
  const builderExpectations: Array<{ builder: string; idPrefix: string }> = [
    { builder: '_buildPlanItems', idPrefix: 'plan:' },
    { builder: '_buildTrapItems', idPrefix: 'trap:' },
    { builder: '_buildClaims', idPrefix: 'claim:' },
    { builder: '_buildAssignmentItems', idPrefix: 'assignment:' },
    { builder: '_buildRunItems', idPrefix: 'run:' },
    { builder: '_buildActions', idPrefix: 'action:' },
    { builder: '_buildHandoffs', idPrefix: 'handoff:' },
    { builder: '_buildCandidateItems', idPrefix: 'candidate:' },
    { builder: '_buildAgents', idPrefix: 'agent:' },
    { builder: '_buildActivity', idPrefix: 'note:' },
    { builder: '_buildCrossProject', idPrefix: 'linked-project:' },
    { builder: '_buildSprint', idPrefix: 'sprint-' },
  ];

  for (const { builder, idPrefix } of builderExpectations) {
    it(`${builder} assigns treeIds prefixed with "${idPrefix}"`, () => {
      // Grab the method body to test in isolation so we don't match other
      // builders that happen to share the same prefix.
      const methodRegex = new RegExp(`private ${builder}\\b[\\s\\S]*?\\n  \\}`, 'm');
      const match = methodRegex.exec(boardTreeSrc);
      assert.ok(match, `could not locate ${builder}`);
      assert.match(match![0], new RegExp(`\`${idPrefix}`));
    });
  }

  it('_buildWorkflowHintItems keeps its existing stable id', () => {
    assert.match(boardTreeSrc, /`workflow-hint:\$\{projectPath\}:\$\{index\}`/);
  });

  it('signal items in _buildCrossProject also carry a treeId', () => {
    // Second branch of the same builder — test separately so a regression
    // on only the signal branch still fails loudly.
    assert.match(boardTreeSrc, /`signal:\$\{projectPath\}:\$\{signal\.id\}`/);
  });
});

describe('refresh-diff — section caching + targeted fire', () => {
  it('declares _sectionItems and _sectionSignatures maps', () => {
    assert.match(boardTreeSrc, /_sectionItems = new Map<string, BrainclawTreeItem>/);
    assert.match(boardTreeSrc, /_sectionSignatures = new Map<string, string>/);
  });

  it('exposes _ensureSectionItem so section instances are cached', () => {
    assert.match(boardTreeSrc, /private _ensureSectionItem\(/);
  });

  it('_refreshBoards delegates to _fireChangedSections (no unconditional root fire)', () => {
    // Locate _refreshBoards's body and assert it routes through the helper.
    const bodyRegex = /private async _refreshBoards\(\)[\s\S]*?\n {2}\}/;
    const match = bodyRegex.exec(boardTreeSrc);
    assert.ok(match, 'could not locate _refreshBoards');
    const body = match![0];
    assert.match(body, /_fireChangedSections\(\)/);
    // The only fire() in the refresh path should be inside the helper —
    // the main refresh body must not call fire() directly any more.
    assert.ok(
      !/_onDidChangeTreeData\.fire\(\)/.test(body),
      '_refreshBoards still contains an unconditional _onDidChangeTreeData.fire()',
    );
  });

  it('_fireChangedSections uses signatures as a gate and only fires when something changed', () => {
    const bodyRegex = /private _fireChangedSections\(\)[\s\S]*?\n {2}\}/;
    const match = bodyRegex.exec(boardTreeSrc);
    assert.ok(match, 'could not locate _fireChangedSections');
    const body = match![0];
    assert.match(body, /_computeSectionSignature\(/);
    assert.match(body, /_sectionSignatures\.set\(/);
    // Must guard the fire with a change flag so no-op refreshes are truly no-op.
    assert.match(body, /if \(firstRender \|\| anyChanged\)/);
  });

  it('_fireChangedSections evicts signatures for sections that dropped out of scope', () => {
    // Protects against stale cache when a project is removed from the workspace.
    const bodyRegex = /private _fireChangedSections\(\)[\s\S]*?\n {2}\}/;
    const match = bodyRegex.exec(boardTreeSrc);
    assert.ok(match);
    assert.match(match![0], /_sectionSignatures\.delete\(/);
    assert.match(match![0], /_sectionItems\.delete\(/);
  });

  it('_computeSectionSignature covers all refreshable sections', () => {
    const methodRegex = /private _computeSectionSignature\([\s\S]*?\n {2}\}/;
    const match = methodRegex.exec(boardTreeSrc);
    assert.ok(match, 'could not locate _computeSectionSignature');
    const body = match![0];
    for (const section of ['ATTENTION', 'IN_PROGRESS', 'SPRINTS', 'BACKLOG', 'SYSTEM']) {
      assert.match(body, new RegExp(`SECTION\\.${section}`), `signature missing branch for ${section}`);
    }
  });

  it('loads backlog plans by active status before applying per-query limits', () => {
    // Anchor on the loader's distinctive destructuring + sort, not on a
    // `case SECTION.BACKLOG:` label (the loader is not under that case) nor on
    // an exact `}` indentation — that source-regex was brittle (cf. trp#371).
    const methodRegex = /\[\s*todoPlans\s*,\s*inProgressPlans[\s\S]{0,800}sortBacklogPlans\([\s\S]{0,200}return board;/;
    const match = methodRegex.exec(boardTreeSrc);
    assert.ok(match, 'could not locate backlog section loader');
    const body = match![0];
    assert.match(body, /status: 'todo'/);
    assert.match(body, /status: 'in_progress'/);
    assert.match(body, /sortBacklogPlans/);
  });

  it('REFRESHABLE_SECTION_IDS lists the five outcome sections', () => {
    const regex = /REFRESHABLE_SECTION_IDS[\s\S]*?\];/;
    const match = regex.exec(boardTreeSrc);
    assert.ok(match);
    const body = match![0];
    for (const section of ['ATTENTION', 'IN_PROGRESS', 'SPRINTS', 'BACKLOG', 'SYSTEM']) {
      assert.match(body, new RegExp(`SECTION\\.${section}`));
    }
  });
});
