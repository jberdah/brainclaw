/**
 * Baseline acceptance bar for the VS Code extension (pln#393 stp_7a2ace04).
 *
 * Each test in this file encodes one clause of the Lane D definition of
 * done. The assertions are source-level invariants that can't regress
 * silently: if someone reverts the awaited refresh on an action handler,
 * or re-introduces a fire-and-forget CLI exec for a mutating path, the
 * corresponding test fails.
 *
 * Clauses:
 *   A. Clean load      — package.json declares every command we register,
 *                        and extension.ts registers every command it
 *                        declares (no orphans either way).
 *   B. Reliable refresh — every state-mutating tree action handler is
 *                        async AND awaits the provider call.
 *   C. No silent no-op — every placeholder has been replaced with a real
 *                        MCP call (viewMemory in particular must no
 *                        longer just print "Searching memory for scope").
 *   D. E2E review flow — accept/reject/release/approve/reject-action are
 *                        wired to the published v1 MCP tools.
 *
 * Runtime activation and live refresh checks need the @vscode/test-electron
 * harness; see the MANUAL E2E notes printed by the suite below.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8')) as {
  contributes: { commands: Array<{ command: string }> };
};
const declaredCommands = pkgJson.contributes.commands.map((c) => c.command);
const extensionSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf-8');
const boardTreeSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'board-tree.ts'), 'utf-8');
const fileDecorationsSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'file-decorations.ts'), 'utf-8');

// Internal commands registered in board-tree that aren't meant for the palette
// (no package.json entry needed) — keep this list narrow and explicit.
const INTERNAL_COMMANDS = new Set<string>([
  'brainclaw.retryProjectBoard',
]);

describe('acceptance — A. clean load: command manifest consistency', () => {
  it('every package.json command is registered in extension.ts', () => {
    const missing = declaredCommands.filter((cmd) => !extensionSrc.includes(`'${cmd}'`));
    assert.deepEqual(missing, [], 'declared commands with no registration');
  });

  it('every registerCommand in extension.ts is declared in package.json (or internal)', () => {
    const regex = /registerCommand\(\s*['"]([^'"]+)['"]/g;
    const registered = new Set<string>();
    for (const match of extensionSrc.matchAll(regex)) {
      registered.add(match[1]!);
    }
    const orphans = [...registered].filter((cmd) =>
      !declaredCommands.includes(cmd) && !INTERNAL_COMMANDS.has(cmd),
    );
    assert.deepEqual(orphans, [], 'registered commands with no manifest entry');
  });

  it('tree provider and file-decoration provider are both registered', () => {
    assert.match(extensionSrc, /registerTreeDataProvider\('brainclaw\.agentBoard'/);
    assert.match(extensionSrc, /registerFileDecorationProvider/);
  });
});

describe('acceptance — B. reliable refresh: state-mutating handlers are awaited', () => {
  const mutatingCommands = [
    'brainclaw.acceptCandidate',
    'brainclaw.rejectCandidate',
    'brainclaw.releaseClaim',
    'brainclaw.approveAction',
    'brainclaw.rejectAction',
    'brainclaw.dispatchPlan',
    'brainclaw.claimScope',
    'brainclaw.addTrap',
  ];

  for (const cmd of mutatingCommands) {
    it(`${cmd} handler is async and awaits the provider`, () => {
      // Match the entire `registerCommand('x', <handler>)` block up to the
      // closing brace of the handler body.
      const pattern = new RegExp(
        `registerCommand\\(\\s*['"]${cmd.replace(/\./g, '\\.')}['"]\\s*,\\s*async[\\s\\S]*?treeProvider\\?\\.[\\s\\S]*?\\}`,
      );
      const match = extensionSrc.match(pattern);
      assert.ok(match, `${cmd}: handler must be async`);
      assert.match(match![0], /await\s+treeProvider\?\./, `${cmd}: must await treeProvider call`);
    });
  }

  it('_execViaMcp refreshes the board after successful mutation', () => {
    const pattern = /private async _execViaMcp[\s\S]*?await client\.callTool\([\s\S]*?this\.refresh\(\)/;
    assert.match(boardTreeSrc, pattern, '_execViaMcp must call this.refresh() after callTool');
  });

  it('_execViaMcp triggers file-decoration refresh on claim mutations', () => {
    assert.match(
      boardTreeSrc,
      /tool === 'bclaw_release_claim' \|\| tool === 'bclaw_claim'[\s\S]*?_fileDecoRefresh/,
    );
  });
});

describe('acceptance — C. no silent no-op actions', () => {
  it('viewMemory no longer prints the "Searching memory for scope" placeholder', () => {
    assert.ok(
      !/Searching memory for scope/.test(extensionSrc),
      'placeholder message must be replaced by real bclaw_search output',
    );
  });

  it('viewMemory handler delegates to provider.viewMemoryForScope', () => {
    assert.match(extensionSrc, /brainclaw\.viewMemory[\s\S]*?viewMemoryForScope\(/);
  });

  it('viewMemoryForScope actually calls bclaw_search', () => {
    assert.match(
      boardTreeSrc,
      /viewMemoryForScope[\s\S]*?callTool\('bclaw_search'/,
    );
  });

  it('claimScope / addTrap explorer commands go through MCP (no shell exec)', () => {
    // The prior implementation used `treeProvider?.exec('claim create "..."')`
    // which bypassed MCP and swallowed errors. Guard against regression by
    // extracting each handler block by its registerCommand boundaries.
    function handlerBody(commandId: string): string {
      const start = extensionSrc.indexOf(`registerCommand('${commandId}'`);
      assert.ok(start >= 0, `${commandId} handler not found`);
      // Scan forward to the matching '})' at the right depth.
      let depth = 0;
      let i = start;
      for (; i < extensionSrc.length; i++) {
        const ch = extensionSrc[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) return extensionSrc.slice(start, i + 1);
        }
      }
      throw new Error(`unbalanced registerCommand for ${commandId}`);
    }

    const claimScopeBody = handlerBody('brainclaw.claimScope');
    assert.ok(
      !/treeProvider\?\.exec\(/.test(claimScopeBody),
      'claimScope must not fall back to exec()',
    );
    assert.match(claimScopeBody, /treeProvider\?\.claimScope\(/);

    const addTrapBody = handlerBody('brainclaw.addTrap');
    assert.ok(
      !/treeProvider\?\.exec\(/.test(addTrapBody),
      'addTrap must not fall back to exec()',
    );
    assert.match(addTrapBody, /treeProvider\?\.addTrap\(/);
  });

  it('_execViaMcp surfaces errors via showErrorMessage (no silent swallows)', () => {
    const pattern = /private async _execViaMcp[\s\S]*?catch[\s\S]*?showErrorMessage/;
    assert.match(boardTreeSrc, pattern);
  });
});

describe('acceptance — D. end-to-end review flow via MCP-backed tools', () => {
  // Each entry: the CLI head token that branches _mapCommandToMcpTool, the
  // expected MCP tool name, and an optional second positional token check.
  const mappings: Array<{ head: string; tool: string; second?: string }> = [
    { head: 'accept', tool: 'bclaw_transition' },
    { head: 'reject', tool: 'bclaw_transition' },
    { head: 'claim', second: 'release', tool: 'bclaw_release_claim' },
    { head: 'approve-action', tool: 'bclaw_assignment_action' },
    { head: 'reject-action', tool: 'bclaw_assignment_action' },
  ];
  for (const { head, tool, second } of mappings) {
    const label = second ? `${head} ${second}` : head;
    it(`CLI verb "${label}" maps to MCP tool "${tool}"`, () => {
      const pieces = [`parts\\[0\\]\\s*===\\s*['"]${head}['"]`];
      if (second) pieces.push(`parts\\[1\\]\\s*===\\s*['"]${second}['"]`);
      pieces.push(tool);
      const regex = new RegExp(pieces.join('[\\s\\S]*?'));
      assert.match(boardTreeSrc, regex, `no mapping for ${label} → ${tool}`);
    });
  }

  it('Review queue pulls server-computed next-action hints (bclaw_context workflow_hints)', () => {
    assert.match(
      boardTreeSrc,
      /case SECTION\.ATTENTION[\s\S]*?bclaw_context[\s\S]*?workflow_hints/,
    );
  });

  it('candidate review queue uses server-side auto_generated filter', () => {
    assert.match(
      boardTreeSrc,
      /_findEntities\([\s\S]*?['"]candidate['"][\s\S]*?auto_generated:\s*false/,
    );
  });

  it('uses v1 published board/context and canonical entity tools instead of removed catalog names', () => {
    const toolName = (suffix: string) => `bclaw_${suffix}`;
    const removedNames = [
      toolName('get_agent_board_summary'),
      toolName('get_agent_board'),
      toolName('get_context'),
      toolName('dispatch_analysis'),
      toolName('list_plans'),
      toolName('list_candidates'),
      toolName('list_claims'),
      toolName('list_actions'),
      toolName('list_assignments'),
      toolName('list_runs'),
      toolName('list_sequences'),
      toolName('accept'),
      toolName('reject'),
    ];

    for (const name of removedNames) {
      assert.ok(!boardTreeSrc.includes(`'${name}'`), `board-tree must not call removed tool ${name}`);
      assert.ok(!fileDecorationsSrc.includes(`'${name}'`), `file-decorations must not call removed tool ${name}`);
    }
    assert.match(boardTreeSrc, /bclaw_context[\s\S]*?kind:\s*['"]board_summary['"]/);
    assert.match(boardTreeSrc, /bclaw_context[\s\S]*?kind:\s*['"]board['"]/);
    assert.match(boardTreeSrc, /bclaw_find/);
  });
});

describe('acceptance — manual E2E residuals (document, do not enforce)', () => {
  it.skip('[MANUAL] VS Code activates extension on workspace containing .brainclaw/', () => {
    // Requires @vscode/test-electron. Validated manually:
    // 1. Open a folder with .brainclaw/ in VS Code.
    // 2. Observe "Brainclaw" status-bar item + activity-bar icon appear.
    // 3. Open the Brainclaw view — tree renders without "no data provider" error.
  });

  it.skip('[MANUAL] Refresh button updates the tree within 1s', () => {
    // Trigger a write via CLI (brainclaw create trap ...) and click the
    // Refresh button on the board — the new row must appear.
  });

  it.skip('[MANUAL] MCP failure surfaces an error toast and does not hang the tree', () => {
    // Kill the brainclaw mcp subprocess mid-operation — the next action
    // should surface "Brainclaw: MCP server process exited" and a
    // retry affordance via the per-project error entry.
  });

  it.skip('[MANUAL] Accept candidate removes it from the Review queue after refresh', () => {
    // Create a non-auto candidate, click Accept, confirm the node
    // disappears from Attention/Review queue.
  });
});
