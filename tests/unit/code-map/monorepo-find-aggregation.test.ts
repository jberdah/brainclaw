import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { resolveTraversal } from '../../../src/core/code-map/aggregate.js';
import { defaultConfig, saveConfig } from '../../../src/core/config.js';

/**
 * pln#631 PR1 — root-aggregated find across a multi-project workspace.
 *
 * A find at a multi-project ROOT must surface symbols from EVERY nested child store
 * (not just the child-scoped root store), tagged with their owning project and
 * workspace-relative paths, behind `traversal:'auto'` (default). A find in a CHILD
 * stays single-store (the F1 locality guardrail). Mirrors cascade.test.ts's fixture.
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

// Token-DISJOINT symbol names: find() gathers by shared sub-tokens, so names must
// not share a token (e.g. all ending "Thing" would cross-match at score 1). These
// share nothing, so a query resolves to exactly the intended symbol.
async function buildWorkspace(): Promise<{ root: string; appA: string; appB: string; be: JsonlBackend }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agg-'));
  cleanup.push(root);
  makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
  writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');

  const appA = path.join(root, 'applications', 'app_a');
  makeStore(appA, 'app_a');
  writeFile(path.join(appA, 'src', 'a.ts'), 'export function orbitAlpha(){return 1;}\n');
  // Same store-relative filename as app_b's, with a distinct symbol + a same-NAMED
  // symbol — exercises the workspace-relative path rewrite + (project_id,node_id) dedupe.
  writeFile(path.join(appA, 'src', 'widget.ts'), 'export function orbitWidget(){return 10;}\nexport function sharedPulse(){return 1;}\n');

  const appB = path.join(root, 'core_services', 'app_b');
  makeStore(appB, 'app_b');
  writeFile(path.join(appB, 'src', 'b.ts'), 'export function craterBeta(){return 2;}\n');
  writeFile(path.join(appB, 'src', 'widget.ts'), 'export function craterWidget(){return 20;}\nexport function sharedPulse(){return 2;}\n');

  const be = new JsonlBackend();
  await be.refresh({ cwd: root, scope: 'all', cascade: true });
  return { root, appA, appB, be };
}

describe('pln#631 root-aggregated find (traversal)', () => {
  it('a root find surfaces symbols from EVERY child store, tagged + workspace-relative', async () => {
    const { root, be } = await buildWorkspace();

    const alpha = await be.find({ query: 'orbitAlpha', cwd: root, traversal: 'auto' });
    assert.ok(alpha.matches.some((m) => m.name === 'orbitAlpha'), 'child app_a symbol surfaces at the root');
    const m = alpha.matches.find((x) => x.name === 'orbitAlpha')!;
    assert.equal(m.project, 'applications/app_a', 'match carries the owning project (workspace-relative)');
    assert.equal(m.project_id, 'prj_app_a');
    assert.equal(m.path, 'applications/app_a/src/a.ts', 'path is rewritten workspace-root-relative');

    const beta = await be.find({ query: 'craterBeta', cwd: root, traversal: 'auto' });
    assert.ok(beta.matches.some((x) => x.name === 'craterBeta' && x.project === 'core_services/app_b'), 'app_b symbol surfaces too');

    const rootSym = await be.find({ query: 'ledgerRoot', cwd: root, traversal: 'auto' });
    const rm = rootSym.matches.find((x) => x.name === 'ledgerRoot')!;
    assert.equal(rm.project, '', 'root project has empty relPath');
    assert.equal(rm.path, 'src/rootlib.ts', 'root-owned path stays store-relative');

    // Freshness badge: workspace coverage present.
    assert.equal(alpha.freshness_badge.details.traversal, 'workspace');
    assert.equal(alpha.freshness_badge.details.projects_total, 3, 'root + 2 children');
    assert.equal(alpha.freshness_badge.details.projects_indexed, 3);
    assert.ok(alpha.freshness_badge.coarse, 'coarse rollup present');
  });

  it('a same-named symbol in two packages is NOT merged (distinct project_id,node_id)', async () => {
    const { root, be } = await buildWorkspace();
    const res = await be.find({ query: 'sharedPulse', cwd: root, traversal: 'auto' });
    const hits = res.matches.filter((x) => x.name === 'sharedPulse');
    assert.equal(hits.length, 2, 'both packages’ sharedPulse appear');
    const projects = hits.map((h) => h.project).sort();
    assert.deepEqual(projects, ['applications/app_a', 'core_services/app_b']);
    // The same store-relative widget.ts in both packages → distinct workspace paths.
    const paths = hits.map((h) => h.path).sort();
    assert.deepEqual(paths, ['applications/app_a/src/widget.ts', 'core_services/app_b/src/widget.ts']);
  });

  it('a find in a CHILD cwd stays single-store (locality guardrail F1)', async () => {
    const { appA, be } = await buildWorkspace();
    // app_a is not a multi-project root → auto = single-store.
    const inChild = await be.find({ query: 'craterBeta', cwd: appA, traversal: 'auto' });
    assert.equal(inChild.matches.length, 0, 'app_a find does not reach into app_b');
    assert.notEqual(inChild.freshness_badge.details.traversal, 'workspace', 'no workspace aggregation from a child');
    const own = await be.find({ query: 'orbitAlpha', cwd: appA, traversal: 'auto' });
    assert.ok(own.matches.some((x) => x.name === 'orbitAlpha'), 'its own symbols still resolve');
  });

  it('traversal:project forces single-store even at a root', async () => {
    const { root, be } = await buildWorkspace();
    const forced = await be.find({ query: 'orbitAlpha', cwd: root, traversal: 'project' });
    assert.equal(forced.matches.length, 0, 'child symbol not surfaced when aggregation is forced off');
    assert.notEqual(forced.freshness_badge.details.traversal, 'workspace');
  });

  it('an unindexed child contributes to coverage but does NOT drag the badge to missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agg2-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');
    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'a.ts'), 'export function orbitAlpha(){return 1;}\n');
    const appB = path.join(root, 'core_services', 'app_b');
    makeStore(appB, 'app_b'); // store created but never refreshed → missing_index
    writeFile(path.join(appB, 'src', 'b.ts'), 'export function craterBeta(){return 2;}\n');

    const be = new JsonlBackend();
    // Single-project refreshes (NO cascade) so app_b keeps missing_index.
    await be.refresh({ cwd: root, scope: 'all' });
    await be.refresh({ cwd: appA, scope: 'all' });

    const res = await be.find({ query: 'orbitAlpha', cwd: root, traversal: 'auto' });
    assert.ok(res.matches.some((m) => m.name === 'orbitAlpha'), 'indexed child still surfaces');
    assert.notEqual(res.freshness_badge.status, 'missing_index', 'aggregate is NOT missing when some stores are indexed');
    assert.notEqual(res.freshness_badge.coarse, 'missing');
    assert.deepEqual(res.freshness_badge.details.unindexed_projects, ['core_services/app_b'], 'the unindexed child is reported');
  });

  it('resolveTraversal: auto at a root → workspace; auto at a child → single', async () => {
    const { root, appA } = await buildWorkspace();
    const atRoot = resolveTraversal(root, 'auto');
    assert.equal(atRoot.workspace, true);
    assert.equal(atRoot.stores.length, 3, 'root + 2 children');
    const atChild = resolveTraversal(appA, 'auto');
    assert.equal(atChild.workspace, false);
    assert.equal(atChild.stores.length, 1);
  });
});
