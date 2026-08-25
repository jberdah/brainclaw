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
    assert.ok(alpha.freshness_badge.freshness, 'coarse rollup present');
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

  it('an unindexed child makes workspace coverage partial without hiding indexed matches', async () => {
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
    assert.equal(res.freshness_badge.status, 'partial', 'incomplete workspace coverage must never report fresh');
    assert.equal(res.freshness_badge.freshness, 'partial');
    assert.equal(res.freshness_badge.details.unindexed_project_count, 1);
    assert.deepEqual(res.freshness_badge.details.unindexed_projects, ['core_services/app_b'], 'the unindexed child is reported');
    assert.equal((res.freshness_badge.details.project_status_counts as Record<string, number>).missing_index, 1);
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

  it('two child stores sharing a project_id do NOT drop each other’s matches (review F1)', async () => {
    // Copied-config scenario: pkgs/a and pkgs/b carry the SAME project_id, each with a
    // src/util.ts defining dupHelper at the same line → identical node_id/file_id. The
    // dedup + shared memo must be scoped by STORE (cwd), not project_id, or b's match is
    // silently dropped / served with a's freshness verdict.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-aggdup-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function ledgerRoot(){return 0;}\n');
    const a = path.join(root, 'pkgs', 'a');
    makeStore(a, 'a', { projectId: 'prj_dup' });
    writeFile(path.join(a, 'src', 'util.ts'), 'export function dupHelper(){return 1;}\n');
    const b = path.join(root, 'pkgs', 'b');
    makeStore(b, 'b', { projectId: 'prj_dup' });
    writeFile(path.join(b, 'src', 'util.ts'), 'export function dupHelper(){return 2;}\n');

    const be = new JsonlBackend();
    await be.refresh({ cwd: root, scope: 'all', cascade: true });
    const res = await be.find({ query: 'dupHelper', cwd: root, traversal: 'auto' });
    const hits = res.matches.filter((m) => m.name === 'dupHelper');
    assert.equal(hits.length, 2, 'both packages’ dupHelper surface despite the shared project_id');
    assert.deepEqual(
      hits.map((h) => h.path).sort(),
      ['pkgs/a/src/util.ts', 'pkgs/b/src/util.ts'],
      'each is disambiguated by its workspace-relative path',
    );
  });

  it('flags a child whose index HEAD lags the workspace HEAD (review F3)', async () => {
    const { root, appB } = await buildWorkspace();
    // Patch app_b's manifest to a STALE commit; the root/app_a stay null (no drift).
    const mpath = path.join(appB, '.brainclaw', 'code', 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mpath, 'utf-8')) as { git?: Record<string, unknown> };
    m.git = { ...(m.git ?? {}), head: 'OLDSHA000' };
    fs.writeFileSync(mpath, JSON.stringify(m));

    // Query with an injected reader returning a DIFFERENT current HEAD.
    const be2 = new JsonlBackend({ gitHeadReader: () => 'NEWSHA111' });
    const res = await be2.find({ query: 'craterBeta', cwd: root, traversal: 'auto' });
    assert.equal(res.freshness_badge.freshness, 'stale', 'a lagging child drags the coarse rollup to stale');
    assert.equal(
      (res.freshness_badge.details.non_fresh_projects as Array<{ path: string; status: string }>).find((p) => p.path === 'core_services/app_b')?.status,
      'stale_git_head',
      'the lagging child is flagged stale_git_head in the compact exception list',
    );
    // The fresh children are NOT falsely flagged (null manifest head → no drift).
    assert.notEqual(
      (res.freshness_badge.details.non_fresh_projects as Array<{ path: string; status: string }>).find((p) => p.path === 'applications/app_a')?.status,
      'stale_git_head',
    );
  });

  it('resolveTraversal: workspace from a CHILD walks up to the root + flags the local store (PR4)', async () => {
    const { appA } = await buildWorkspace();
    const t = resolveTraversal(appA, 'workspace');
    assert.equal(t.workspace, true, 'explicit workspace from a child aggregates the whole workspace');
    assert.equal(t.stores.length, 3, 'root + 2 children');
    const local = t.stores.filter((s) => s.isLocal);
    assert.equal(local.length, 1, 'exactly one store flagged local');
    assert.equal(local[0]!.relPath, 'applications/app_a', 'the caller package is the local one');
    // `auto` from a child must NOT walk up (single-store), only explicit `workspace` does.
    assert.equal(resolveTraversal(appA, 'auto').workspace, false, 'auto from a child stays single-store');
  });

  it('find from a child with traversal:workspace surfaces siblings + ranks the local package first (PR4)', async () => {
    const { appA, be } = await buildWorkspace();
    // A sibling symbol (craterBeta lives in app_b) is now reachable from app_a via an
    // EXPLICIT workspace scope — the agent no longer has to cd to the root.
    const beta = await be.find({ query: 'craterBeta', cwd: appA, traversal: 'workspace' });
    assert.ok(
      beta.matches.some((m) => m.name === 'craterBeta' && m.project === 'core_services/app_b'),
      'sibling package symbol reachable from a child via workspace scope',
    );
    // Locality tiebreak: sharedPulse is defined in BOTH app_a and app_b; from app_a the
    // LOCAL one ranks first (same score → locality breaks the tie).
    const shared = await be.find({ query: 'sharedPulse', cwd: appA, traversal: 'workspace' });
    const hits = shared.matches.filter((m) => m.name === 'sharedPulse');
    assert.ok(hits.length >= 2, 'both packages’ sharedPulse present');
    assert.equal(hits[0]!.project, 'applications/app_a', 'the caller-local hit ranks first');
    assert.equal(hits[0]!.local, true, 'the local hit is flagged local');
  });

  it('locality works from a SUBDIR of the caller package, not just the package root (review fix)', async () => {
    const { appA, be } = await buildWorkspace();
    // The common case: the agent stands in a src/ subdir, NOT exactly at the package root.
    // Locality is by containment, so the caller's package must still win the tiebreak.
    const subdir = path.join(appA, 'src');
    const shared = await be.find({ query: 'sharedPulse', cwd: subdir, traversal: 'workspace' });
    const hits = shared.matches.filter((m) => m.name === 'sharedPulse');
    assert.ok(hits.length >= 2, 'both packages present from a subdir');
    assert.equal(hits[0]!.project, 'applications/app_a', 'caller package ranks first from a src/ subdir');
    assert.equal(hits[0]!.local, true, 'the local flag is set from a subdir (containment, not ===)');
  });
});
