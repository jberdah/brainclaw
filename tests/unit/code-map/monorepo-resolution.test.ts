import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { resolveEffectiveCwd } from '../../../src/core/store-resolution.js';
import { defaultConfig, saveConfig } from '../../../src/core/config.js';

/**
 * Coupling test (1.10.0 merge): Code Map resolves its project via
 * resolveEffectiveCwd (mcp.ts / cli.ts pass that cwd to the JsonlBackend). The
 * monorepo-safety F1 change must therefore route an anchored agent working in a
 * child project to THAT child's `.brainclaw/code/` index — not the monorepo
 * root. This locks the contract so a future change to the handler's cwd
 * resolution can't silently regress Code Map's per-project behavior.
 */
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
});

function makeStore(dir: string, name: string, opts: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, { projectId: `prj_${name}`, ...opts }), dir);
}

describe('code-map ↔ monorepo resolution (F1 coupling)', () => {
  it('an anchored agent inside a child queries the CHILD code map, not the root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cmmono-'));
    cleanup.push(root);
    makeStore(root, 'workspace', { projectMode: 'multi-project', projectStrategy: 'folder' });

    const child = path.join(root, 'apps', 'web');
    fs.mkdirSync(path.join(child, 'src'), { recursive: true });
    makeStore(child, 'web');
    fs.writeFileSync(
      path.join(child, 'src', 'widget.ts'),
      'export function uniqueChildWidget() { return 42; }\n',
      'utf-8',
    );

    const be = new JsonlBackend();
    const refreshed = await be.refresh({ cwd: child, scope: 'all' });
    assert.ok(refreshed.ran, 'child code-map refresh should run');

    const savedCwd = process.env.BRAINCLAW_CWD;
    const savedProject = process.env.BRAINCLAW_PROJECT;
    try {
      process.env.BRAINCLAW_CWD = root;       // anchor = monorepo root
      delete process.env.BRAINCLAW_PROJECT;   // no env override → cwd drives it

      // F1: an anchored agent physically inside the child resolves the child.
      const resolved = resolveEffectiveCwd({ baseCwd: child });
      assert.equal(resolved, path.resolve(child), 'anchored-in-child must resolve the child (F1)');

      // Code Map find via the resolved cwd hits the CHILD's index.
      const childFind = await be.find({ query: 'uniqueChildWidget', cwd: resolved });
      assert.ok(
        childFind.matches.some((m) => m.name === 'uniqueChildWidget'),
        'find via the resolved child cwd must surface the child symbol',
      );

      // The monorepo ROOT's OWN store has no code map → single-store (traversal:'project')
      // must NOT surface the child symbol. (This is the F1 contract — the anchored child
      // find above is what resolves the child; the root store itself is empty here.)
      const rootFind = await be.find({ query: 'uniqueChildWidget', cwd: root, traversal: 'project' });
      assert.ok(
        !rootFind.matches.some((m) => m.name === 'uniqueChildWidget'),
        'the root store (no index) must not surface the child symbol',
      );

      // pln#631: the DEFAULT (auto) now AGGREGATES at a multi-project root, so the same
      // root find WITHOUT forcing single-store DOES surface the child symbol — the gap
      // #3 closes (an agent at the root no longer gets nothing and falls back to grep).
      const rootAggregated = await be.find({ query: 'uniqueChildWidget', cwd: root });
      assert.ok(
        rootAggregated.matches.some((m) => m.name === 'uniqueChildWidget'),
        'auto-traversal at the root aggregates the child store (pln#631)',
      );
    } finally {
      if (savedCwd === undefined) delete process.env.BRAINCLAW_CWD; else process.env.BRAINCLAW_CWD = savedCwd;
      if (savedProject === undefined) delete process.env.BRAINCLAW_PROJECT; else process.env.BRAINCLAW_PROJECT = savedProject;
    }
  });
});
