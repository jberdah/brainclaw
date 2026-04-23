/**
 * Source-level invariants for the entity preview feature (pln#456).
 *
 * The content provider itself can't be unit-tested without spinning up VS Code
 * and a brainclaw MCP server, so we pin the contract at the source level: the
 * scheme is registered, the two commands are wired, and every supported
 * entity type has a dedicated markdown renderer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..');
const providerSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'content-provider.ts'), 'utf-8');
const extensionSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf-8');
const boardTreeSrc = fs.readFileSync(path.join(extensionRoot, 'src', 'board-tree.ts'), 'utf-8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8')) as {
  contributes: { commands: Array<{ command: string }>; menus: Record<string, any[]> };
};

const SUPPORTED_ENTITIES = ['plan', 'claim', 'trap', 'handoff', 'agent'] as const;

describe('content-provider — scheme + commands', () => {
  it('declares a brainclaw: URI scheme', () => {
    assert.match(providerSrc, /export const BRAINCLAW_SCHEME = 'brainclaw'/);
  });

  it('registers the content provider in extension.ts', () => {
    assert.match(extensionSrc, /registerTextDocumentContentProvider\(\s*BRAINCLAW_SCHEME/);
  });

  it('registers both brainclaw.openEntity and brainclaw.refreshEntityPreview commands', () => {
    assert.match(extensionSrc, /registerCommand\(\s*['"]brainclaw\.openEntity['"]/);
    assert.match(extensionSrc, /registerCommand\(\s*['"]brainclaw\.refreshEntityPreview['"]/);
  });

  it('openEntity routes to markdown.showPreview with locked:true (preview that stacks as tabs)', () => {
    assert.match(extensionSrc, /executeCommand\(\s*['"]markdown\.showPreview['"]/);
    assert.match(extensionSrc, /locked:\s*true/);
  });

  it('both new commands are declared in package.json', () => {
    const declared = pkgJson.contributes.commands.map((c) => c.command);
    assert.ok(declared.includes('brainclaw.openEntity'), 'brainclaw.openEntity missing from manifest');
    assert.ok(declared.includes('brainclaw.refreshEntityPreview'), 'brainclaw.refreshEntityPreview missing from manifest');
  });

  it('both new commands are hidden from the palette (when: false)', () => {
    const palette = pkgJson.contributes.menus.commandPalette ?? [];
    const hiddenCommands = palette
      .filter((entry: any) => entry.when === 'false')
      .map((entry: any) => entry.command);
    assert.ok(hiddenCommands.includes('brainclaw.openEntity'), 'openEntity should be hidden from palette');
    assert.ok(hiddenCommands.includes('brainclaw.refreshEntityPreview'), 'refreshEntityPreview should be hidden from palette');
  });
});

describe('content-provider — renderers', () => {
  for (const entity of SUPPORTED_ENTITIES) {
    it(`has a dedicated renderer for ${entity}`, () => {
      const cap = entity[0]!.toUpperCase() + entity.slice(1);
      assert.match(providerSrc, new RegExp(`function render${cap}\\(`), `render${cap} missing`);
      assert.match(providerSrc, new RegExp(`case '${entity}': return render${cap}\\(`), `${entity} dispatch case missing`);
    });
  }
});

describe('content-provider — tree item wiring', () => {
  for (const entity of SUPPORTED_ENTITIES) {
    it(`${entity} tree items call attachEntityPreview`, () => {
      assert.match(
        boardTreeSrc,
        new RegExp(`attachEntityPreview\\([^)]*?['"]${entity}['"]`),
        `${entity} builder should wire attachEntityPreview`,
      );
    });
  }

  it('attachEntityPreview sets both command and MarkdownString tooltip', () => {
    assert.match(boardTreeSrc, /function attachEntityPreview\b/);
    // In the same function body, both item.command and item.tooltip must be set
    // and the tooltip must be built from MarkdownString (so command links are live).
    const body = boardTreeSrc.match(/function attachEntityPreview[\s\S]*?^\}/m);
    assert.ok(body, 'attachEntityPreview body not found');
    assert.match(body![0], /item\.command\s*=/);
    assert.match(body![0], /new vscode\.MarkdownString/);
    assert.match(body![0], /isTrusted\s*=\s*true/);
  });
});
