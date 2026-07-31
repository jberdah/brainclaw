import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { defaultConfig, saveConfig } from '../../../src/core/config.js';

/**
 * DGX Finding 2 (2026-06-22): `code-map refresh --cascade` at a multi-project
 * workspace root must index EVERY nested brainclaw project into its own store
 * and scope the root store to the files no child owns — zero double-indexing,
 * including under nesting. Opt-in: plain refresh stays single-project.
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

describe('code-map cascade (DGX Finding 2 — monorepo-native refresh)', () => {
  it('refreshes every nested project + a child-scoped root with zero double-indexing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-casc-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function rootThing(){return 0;}\n');

    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'a.ts'), 'export function alphaThing(){return 1;}\n');

    const appB = path.join(root, 'core_services', 'app_b');
    makeStore(appB, 'app_b');
    writeFile(path.join(appB, 'src', 'b.ts'), 'export function betaThing(){return 2;}\n');

    // A project nested INSIDE app_b — proves the no-double-index rule under nesting.
    const nested = path.join(appB, 'pkgs', 'nested_pkg');
    makeStore(nested, 'nested_pkg');
    writeFile(path.join(nested, 'src', 'n.ts'), 'export function nestedThing(){return 3;}\n');

    const be = new JsonlBackend();
    const result = await be.refresh({ cwd: root, scope: 'all', cascade: true });

    assert.ok(result.cascade, 'cascade result must be present');
    assert.equal(result.cascade!.children_refreshed, 3, 'all 3 nested projects refreshed');
    assert.equal(result.cascade!.root_result.files_parsed, 1, 'root indexes only the file no child owns');
    // Lock state is propagated per project and aggregated (codex review): with no
    // competing writers every project acquired its lock, so the top-level cascade
    // reports lock_acquired=true and no lock_status — not a masked partial.
    assert.equal(result.lock_acquired, true, 'all locks acquired → top-level lock_acquired');
    assert.equal(result.lock_status, undefined, 'no skipped-project lock_status when all acquired');
    assert.ok(result.cascade!.root_result.lock_acquired, 'root lock_acquired propagated');
    assert.ok(result.cascade!.children.every((c) => c.lock_acquired), 'each child lock_acquired propagated');

    // Each symbol must resolve in EXACTLY ONE store — the most specific project.
    // traversal:'project' (pln#631) keeps each find SINGLE-STORE so this tests the
    // refresh SCOPING (per-store ownership); the default 'auto' would aggregate at
    // the multi-project root and (correctly) surface every child symbol.
    const stores: Record<string, string> = { root, app_a: appA, app_b: appB, nested_pkg: nested };
    const expectedOwner: Record<string, string> = {
      rootThing: 'root', alphaThing: 'app_a', betaThing: 'app_b', nestedThing: 'nested_pkg',
    };
    for (const [sym, owner] of Object.entries(expectedOwner)) {
      const owners: string[] = [];
      for (const [label, cwd] of Object.entries(stores)) {
        const found = await be.find({ query: sym, cwd, traversal: 'project' });
        if (found.matches.some((m) => m.name === sym)) owners.push(label);
      }
      assert.deepEqual(owners, [owner], `${sym} must be owned by exactly ${owner}, got [${owners}]`);
    }
  });

  it('status --cascade reports per-child store presence + a child-scoped root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cascstat-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function rootThing(){return 0;}\n');
    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'a.ts'), 'export function alphaThing(){return 1;}\n');
    const appB = path.join(root, 'applications', 'app_b');
    makeStore(appB, 'app_b'); // intentionally NOT refreshed → stays missing_index

    const be = new JsonlBackend();
    // Single-project refreshes (no cascade) so app_b is left without a code
    // index — the recap must surface it as missing_index.
    await be.refresh({ cwd: root, scope: 'all' });
    await be.refresh({ cwd: appA, scope: 'all' });

    const status = await be.status({ cwd: root, cascade: true });
    assert.ok(status.cascade, 'cascade recap present');
    assert.equal(status.cascade!.total_children, 2, 'two child projects discovered');
    assert.equal(status.cascade!.indexed_children, 1, 'only app_a has a built index');
    const byPath = new Map(status.cascade!.children.map((c) => [c.path, c]));
    assert.equal(byPath.get('applications/app_a')?.freshness, 'fresh');
    assert.equal(byPath.get('applications/app_b')?.freshness, 'missing_index');
    assert.equal(byPath.get('applications/app_b')?.files_indexed, null);
  });

  it('migrates a prior monolithic root index — cascade --all compacts child files out of the root store', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cascmig-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function rootThing(){return 0;}\n');
    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'a.ts'), 'export function alphaThing(){return 1;}\n');

    const be = new JsonlBackend();
    // Pre-fix state: a plain root refresh indexes the WHOLE tree (root + child).
    await be.refresh({ cwd: root, scope: 'all' });
    const mono = await be.status({ cwd: root });
    assert.equal(mono.stats?.files_indexed, 2, 'monolithic root indexes both files');

    // Migrating with a cascade --all must compact the child file back out of the
    // root store (so the stale monolith self-heals, not lingers as a duplicate).
    await be.refresh({ cwd: root, scope: 'all', cascade: true });
    const after = await be.status({ cwd: root });
    assert.equal(after.stats?.files_indexed, 1, 'root store now scoped to the file no child owns');
    // Single-store (pln#631): assert the root STORE was compacted; the default 'auto'
    // would aggregate the child store back in (the intended workspace behavior).
    const rootFind = await be.find({ query: 'alphaThing', cwd: root, traversal: 'project' });
    assert.ok(!rootFind.matches.some((m) => m.name === 'alphaThing'), 'child symbol no longer in the root store');
  });

  // Codex review (DGX Finding 2): the DEFAULT cascade scope is --changed, whose
  // cheap compaction only removes git-proven deletes — so a prior monolithic root
  // would keep the now-ignored child shards unless the cascade explicitly compacts
  // newly-ignored files. Lock that the default scope migrates cleanly too.
  it('migrates a prior monolithic root index on the default cascade --changed too', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cascmigchg-'));
    cleanup.push(root);
    makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
    writeFile(path.join(root, 'src', 'rootlib.ts'), 'export function rootThing(){return 0;}\n');
    const appA = path.join(root, 'applications', 'app_a');
    makeStore(appA, 'app_a');
    writeFile(path.join(appA, 'src', 'a.ts'), 'export function alphaThing(){return 1;}\n');

    const be = new JsonlBackend();
    await be.refresh({ cwd: root, scope: 'all' });
    assert.equal((await be.status({ cwd: root })).stats?.files_indexed, 2, 'monolithic root starts with root + child');

    await be.refresh({ cwd: root, scope: 'changed', cascade: true });

    assert.equal((await be.status({ cwd: root })).stats?.files_indexed, 1, 'default cascade compacts child-owned files out of root');
    const owners: string[] = [];
    for (const [label, cwd] of Object.entries({ root, app_a: appA })) {
      const found = await be.find({ query: 'alphaThing', cwd, traversal: 'project' });
      if (found.matches.some((m) => m.name === 'alphaThing')) owners.push(label);
    }
    assert.deepEqual(owners, ['app_a'], 'child symbol must remain only in the child store');
  });

  it('is a no-op in a single-project repo (cascade falls back to a normal refresh)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cascsolo-'));
    cleanup.push(repo);
    makeStore(repo, 'solo'); // default project_mode = auto (not multi-project)
    writeFile(path.join(repo, 'src', 'only.ts'), 'export function onlyThing(){return 1;}\n');

    const be = new JsonlBackend();
    const result = await be.refresh({ cwd: repo, scope: 'all', cascade: true });
    assert.equal(result.cascade, undefined, 'no cascade outside a multi-project workspace');
    assert.ok(result.ran, 'still performs the normal single-project refresh');
    const found = await be.find({ query: 'onlyThing', cwd: repo });
    assert.ok(found.matches.some((m) => m.name === 'onlyThing'));
  });
});
