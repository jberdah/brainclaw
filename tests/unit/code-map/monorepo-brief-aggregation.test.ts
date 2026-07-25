import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { defaultConfig, saveConfig } from '../../../src/core/config.js';

/**
 * pln#631 PR2 — root-aggregated BRIEF across a multi-project workspace (symmetric to
 * the find aggregation in PR1). A brief at a multi-project root resolves the target in
 * every child store and contributes reading lists ONLY from the stores at the highest
 * match tier (exact > path > fuzzy) — so an exact definition in one package is never
 * diluted by fuzzy token-noise from siblings. Entries are workspace-relative +
 * project-tagged. A brief in a CHILD stays single-store (locality).
 */
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
});

function makeStore(dir: string, name: string, opts: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, { projectId: `prj_${name}`, ...opts }), dir);
}
function writeFile(p: string, source: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, source, 'utf-8');
}

/** Root workspace: app_a defines OrbitWidget (+ a consumer importing it); app_b has a
 *  DIFFERENT symbol sharing tokens with a fuzzy query, to prove no fuzzy dilution. */
async function build(): Promise<{ root: string; appA: string; appB: string; be: JsonlBackend }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bagg-'));
  cleanup.push(root);
  makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
  writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');

  const appA = path.join(root, 'applications', 'app_a');
  makeStore(appA, 'app_a');
  writeFile(path.join(appA, 'src', 'widget.ts'), 'export function orbitWidget(){return 1;}\n');
  writeFile(path.join(appA, 'src', 'consumer.ts'), "import { orbitWidget } from './widget';\nexport function useIt(){ return orbitWidget(); }\n");

  const appB = path.join(root, 'core_services', 'app_b');
  makeStore(appB, 'app_b');
  // Shares the 'orbit'/'widget' tokens with a fuzzy 'orbitWidget' query, but is NOT an
  // exact match — must be excluded when app_a has the exact definition.
  writeFile(path.join(appB, 'src', 'other.ts'), 'export function orbitWidgetFactory(){return 2;}\n');

  const be = new JsonlBackend();
  await be.refresh({ cwd: root, scope: 'all', cascade: true });
  return { root, appA, appB, be };
}

describe('pln#631 PR2 root-aggregated brief (traversal)', () => {
  it('a root brief surfaces the defining child’s reading list, project-tagged + workspace-relative', async () => {
    const { root, be } = await build();
    const brief = await be.brief({ target: 'orbitWidget', cwd: root, traversal: 'auto' });
    const paths = brief.suggested_files_to_read.map((f) => f.path);
    assert.ok(paths.includes('applications/app_a/src/widget.ts'), 'defining file surfaces, workspace-relative');
    const defEntry = brief.suggested_files_to_read.find((f) => f.path === 'applications/app_a/src/widget.ts')!;
    assert.equal(defEntry.project, 'applications/app_a', 'entry carries the owning project');
    assert.equal(brief.freshness_badge.details.traversal, 'workspace');
    assert.ok(brief.freshness_badge.coarse, 'coarse rollup present');
  });

  it('does NOT dilute an exact match with a sibling’s fuzzy token match', async () => {
    const { root, be } = await build();
    const brief = await be.brief({ target: 'orbitWidget', cwd: root, traversal: 'auto' });
    const paths = brief.suggested_files_to_read.map((f) => f.path);
    // app_a has the EXACT orbitWidget; app_b only fuzzy-matches (orbitWidgetFactory) →
    // must be excluded (exact tier wins).
    assert.ok(
      !paths.some((p) => p.startsWith('core_services/app_b')),
      `app_b (fuzzy only) must not appear: ${paths.join(', ')}`,
    );
  });

  it('a brief in a CHILD cwd stays single-store (locality)', async () => {
    const { appA, be } = await build();
    const brief = await be.brief({ target: 'orbitWidget', cwd: appA, traversal: 'auto' });
    assert.notEqual(brief.freshness_badge.details.traversal, 'workspace', 'no aggregation from a child');
    // Its own symbol still resolves, and paths are store-relative (no package prefix).
    const paths = brief.suggested_files_to_read.map((f) => f.path);
    assert.ok(paths.includes('src/widget.ts'), 'child-local path stays store-relative');
  });

  it('a same-named symbol defined in two packages briefs BOTH (exact tier)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bagg2-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');
    const a = path.join(root, 'pkgs', 'a');
    makeStore(a, 'a');
    writeFile(path.join(a, 'src', 'reg.ts'), 'export function sharedRegistry(){return 1;}\n');
    const b = path.join(root, 'pkgs', 'b');
    makeStore(b, 'b');
    writeFile(path.join(b, 'src', 'reg.ts'), 'export function sharedRegistry(){return 2;}\n');

    const be = new JsonlBackend();
    await be.refresh({ cwd: root, scope: 'all', cascade: true });
    const brief = await be.brief({ target: 'sharedRegistry', cwd: root, traversal: 'auto' });
    const projects = new Set(brief.suggested_files_to_read.map((f) => f.project));
    assert.ok(projects.has('pkgs/a') && projects.has('pkgs/b'), `both packages brief: ${[...projects].join(', ')}`);
  });

  it('traversal:project forces single-store even at a root', async () => {
    const { root, be } = await build();
    const brief = await be.brief({ target: 'orbitWidget', cwd: root, traversal: 'project' });
    assert.notEqual(brief.freshness_badge.details.traversal, 'workspace');
    // The root store (child-scoped) does not define orbitWidget → no child leakage.
    const paths = brief.suggested_files_to_read.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith('applications/app_a')), 'no aggregation → child files absent');
  });

  it('surfaces a cross-package importer (sibling importing the defining package) — PR3', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-xpkg-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');
    // Defining package @mono/core exports coreRegistry.
    const core = path.join(root, 'packages', 'core');
    makeStore(core, 'core');
    writeFile(path.join(core, 'package.json'), JSON.stringify({ name: '@mono/core' }));
    writeFile(path.join(core, 'src', 'registry.ts'), 'export function coreRegistry(){return 1;}\n');
    // Sibling @mono/api imports coreRegistry from @mono/core (cross-package).
    const api = path.join(root, 'packages', 'api');
    makeStore(api, 'api');
    writeFile(path.join(api, 'package.json'), JSON.stringify({ name: '@mono/api' }));
    writeFile(path.join(api, 'src', 'server.ts'), "import { coreRegistry } from '@mono/core';\nexport function boot(){ return coreRegistry(); }\n");

    const be = new JsonlBackend();
    await be.refresh({ cwd: root, scope: 'all', cascade: true });
    const brief = await be.brief({ target: 'coreRegistry', cwd: root, traversal: 'auto' });

    // The defining file is present...
    assert.ok(
      brief.suggested_files_to_read.some((f) => f.path === 'packages/core/src/registry.ts'),
      'defining file surfaces',
    );
    // ...and the sibling importer surfaces as a cross_package row, name-level.
    const cross = brief.suggested_files_to_read.find((f) => f.path === 'packages/api/src/server.ts');
    assert.ok(cross, `cross-package importer must surface: ${brief.suggested_files_to_read.map((f) => f.path).join(', ')}`);
    assert.equal(cross!.cross_package, true, 'flagged cross_package');
    assert.equal(cross!.project, 'packages/api');
    assert.match(cross!.reason, /cross-package/);
    assert.match(cross!.reason, /coreRegistry/, 'name-level: reason cites the imported symbol');
  });

  it('briefs an imported-but-not-defined name via the importer heuristic (review F1 parity)', async () => {
    // No store DEFINES `axios`, but a child imports it — a single-store brief surfaces
    // the importer via rankFiles' specifier heuristic, so the aggregate must too (not []).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bagg3-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');
    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'client.ts'), "import axios from 'axios';\nexport function call(){ return axios; }\n");

    const be = new JsonlBackend();
    await be.refresh({ cwd: root, scope: 'all', cascade: true });
    const brief = await be.brief({ target: 'axios', cwd: root, traversal: 'auto' });
    const paths = brief.suggested_files_to_read.map((f) => f.path);
    assert.ok(
      paths.includes('applications/app_a/src/client.ts'),
      `the importer must surface via aggregation, got: ${paths.join(', ')}`,
    );
  });
});
