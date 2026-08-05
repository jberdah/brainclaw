/**
 * pln#649 step 2 — locating the store that owns an entity, by id.
 *
 * The cost pins matter as much as the correctness pins: this function sits on the
 * routing path of every entity-discriminated mutation, so "how many stores did it
 * touch" is part of its contract. They count FS PROBES (`result.probed`), not wall
 * clock — a timing assertion measures the machine's load, not the code.
 *
 * The ambiguity pin is the one step 4 depends on: two stores holding the same id
 * must surface as `ambiguous` with both matches, never be silently resolved by
 * first-wins. That is the divergence the hard refusal exists for.
 *
 * @module
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { createAssignment } from '../../src/core/assignments.js';
import { enumerateCandidateStores, locateEntity } from '../../src/core/entity-locator.js';

const ENV_KEYS = ['BRAINCLAW_CWD', 'BRAINCLAW_PROJECT', 'BRAINCLAW_SESSION_ID', 'BRAINCLAW_STORE_BOUNDARY'];
let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function withCleanEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function store(dir: string, name: string, projectId: string, opts: { workspace?: boolean } = {}): string {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(
    defaultConfig(name, { projectId, ...(opts.workspace ? { projectMode: 'multi-project', projectStrategy: 'folder' } : {}) }),
    dir,
  );
  if (opts.workspace) {
    // `store_type` is read from the YAML by the store-chain walk but is not part of
    // the typed Config surface — the store-resolution tests write it raw for the
    // same reason. Appending keeps this fixture honest without widening the type.
    const configPath = path.join(dir, '.brainclaw', 'config.yaml');
    fs.appendFileSync(configPath, '\nstore_type: workspace\n', 'utf-8');
  }
  return dir;
}

function monorepo(): { ws: string; api: string; web: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-'));
  cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
  store(ws, 'workspace', 'prj_ws', { workspace: true });
  const api = store(path.join(ws, 'apps', 'api'), 'api', 'prj_api');
  const web = store(path.join(ws, 'apps', 'web'), 'web', 'prj_web');
  return { ws, api, web };
}

function seedAssignment(cwd: string, id: string): void {
  createAssignment({
    id,
    short_label: id,
    claim_id: 'clm_locator',
    agent: 'worker',
    dispatcher_agent: 'coordinator',
    scope: 'src/x.ts',
    description: 'locator fixture',
  }, cwd);
}

describe('core/entity-locator (pln#649 step 2)', () => {
  // review P1-1, reproduced by the reviewer: resolveEntityDir picks the canonical
  // directory as soon as it holds ANY file, which made a legacy record invisible in
  // a mid-migration store. Both layouts must be probed by FILE.
  it('MIXED LAYOUT: a legacy record is found even when the canonical dir has content', () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-mixed-'));
    cleanups.push(() => fs.rmSync(solo, { recursive: true, force: true }));
    store(solo, 'solo', 'prj_mixed');
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: solo }, () => {
      seedAssignment(solo, 'asgn_canonical');           // lands in coordination/assignments
      const legacyDir = path.join(solo, '.brainclaw', 'assignments');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'asgn_legacy.json'), '{"id":"asgn_legacy"}', 'utf-8');

      assert.equal(locateEntity('assignment', 'asgn_canonical', solo).status, 'found');
      assert.equal(
        locateEntity('assignment', 'asgn_legacy', solo).status,
        'found',
        'a pre-migration record must stay routable',
      );
    });
  });

  it('COST: a single-project store costs exactly ONE record probe (enumeration is extra — see the type doc)', () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-solo-'));
    cleanups.push(() => fs.rmSync(solo, { recursive: true, force: true }));
    store(solo, 'solo', 'prj_solo');
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: solo }, () => {
      seedAssignment(solo, 'asgn_solo');
      const result = locateEntity('assignment', 'asgn_solo', solo);
      assert.equal(result.status, 'found');
      assert.deepEqual(result.probed, [path.resolve(solo)], 'the common case must not walk siblings');
    });
  });

  // Title corrected after review P2-4: the caller store is probed FIRST, but the
  // loop does NOT stop there — every candidate is probed by design so a duplicate
  // elsewhere still surfaces as `ambiguous`. Claiming "never pays for the
  // workspace" was false, and a test title that overstates its assertion is how a
  // cost guarantee gets believed without being held.
  it('probes the CALLER store first (without short-circuiting — duplicates must still surface)', () => {
    const { ws, api } = monorepo();
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, () => {
      seedAssignment(api, 'asgn_local');
      const result = locateEntity('assignment', 'asgn_local', api);
      assert.equal(result.status, 'found');
      assert.equal(result.probed[0], path.resolve(api));
      assert.equal(result.location?.project_id, 'prj_api');
    });
  });

  it('finds an entity that lives in a SIBLING project (the worker case)', () => {
    const { ws, api } = monorepo();
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, () => {
      seedAssignment(api, 'asgn_sibling');
      // Called from the workspace root — where ambient resolution would have
      // landed a worker with no session.
      const result = locateEntity('assignment', 'asgn_sibling', ws);
      assert.equal(result.status, 'found');
      assert.equal(result.location?.cwd, path.resolve(api));
      assert.equal(result.location?.project_id, 'prj_api');
      assert.equal(result.location?.project_name, 'api');
    });
  });

  it('AMBIGUOUS: the same id in two stores is reported, never resolved by first-wins', () => {
    const { ws, api, web } = monorepo();
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, () => {
      seedAssignment(api, 'asgn_dup');
      seedAssignment(web, 'asgn_dup');
      const result = locateEntity('assignment', 'asgn_dup', ws);
      assert.equal(result.status, 'ambiguous', 'step 4 refuses on exactly this');
      assert.equal(result.matches.length, 2);
      assert.equal(result.location, undefined, 'no winner may be invented');
      const ids = result.matches.map((m) => m.project_id).sort();
      assert.deepEqual(ids, ['prj_api', 'prj_web']);
    });
  });

  it('not_found is a status, not a throw — and the probe stays bounded', () => {
    const { ws } = monorepo();
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, () => {
      const result = locateEntity('assignment', 'asgn_nowhere', ws);
      assert.equal(result.status, 'not_found');
      assert.equal(result.matches.length, 0);
      // ws + api + web, each probed at most once.
      assert.equal(new Set(result.probed).size, result.probed.length, 'no candidate probed twice');
      assert.ok(result.probed.length <= 3, `expected ≤3 probes, got ${result.probed.length}`);
    });
  });

  it('enumeration rejects paths that are not stores, and never repeats one', () => {
    const { ws, api, web } = monorepo();
    fs.mkdirSync(path.join(ws, 'apps', 'not-a-project'), { recursive: true });
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, () => {
      const candidates = enumerateCandidateStores(ws);
      assert.equal(new Set(candidates).size, candidates.length);
      for (const c of candidates) {
        assert.ok(fs.existsSync(path.join(c, '.brainclaw', 'config.yaml')), `${c} must be a real store`);
      }
      assert.ok(candidates.includes(path.resolve(api)));
      assert.ok(candidates.includes(path.resolve(web)));
      assert.ok(!candidates.some((c) => c.endsWith('not-a-project')));
    });
  });

  // review P2-3, reproduced by the reviewer: `path.resolve` is lexical, so a
  // junction/symlink/case alias of a store already enumerated survived as a SECOND
  // candidate, the same record was found twice, and the result was `ambiguous` — a
  // false positive that blocks a healthy mutation.
  //
  // Asserted on the ALIAS-AWARE DEDUP DIRECTLY, with an explicit candidate list, so
  // the pin costs two stats instead of a full enumeration. An earlier version of
  // this test called enumerateCandidateStores against a tmpdir-rooted workspace and
  // took 130 SECONDS — see DEFAULT_SCAN_DEPTH.
  it('ALIAS: two spellings of ONE physical store collapse instead of faking ambiguity', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-real-'));
    cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }));
    store(real, 'solo', 'prj_alias');
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-alias-'));
    cleanups.push(() => fs.rmSync(aliasParent, { recursive: true, force: true }));
    const alias = path.join(aliasParent, 'link');
    try {
      fs.symlinkSync(real, alias, 'junction');
    } catch {
      return; // junction creation not permitted in this environment — nothing to assert
    }
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: real }, () => {
      seedAssignment(real, 'asgn_alias');
      // Feed BOTH spellings as candidates: pre-fix this yielded two matches.
      const result = locateEntity('assignment', 'asgn_alias', real, { candidates: [real, alias] });
      assert.equal(result.status, 'found', 'an alias of the same store is not a divergence');
      assert.equal(result.matches.length, 1);
    });
  });

  // review P1-1, his exact reproduction: a store BELOW the ceiling with nothing in
  // between. The old heuristic (deepest RESULT near the ceiling) reported
  // completeness here, so the handler emitted a CONFIDENT not_found. Truncation now
  // comes from the walk, which sees the branch being cut whether or not it found
  // anything.
  it('DEPTH: a store below the ceiling yields not_found flagged as INCOMPLETE, never a confident miss', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-depth-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    store(root, 'root', 'prj_depth_root', { workspace: true });
    const deep = path.join(root, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7');
    fs.mkdirSync(deep, { recursive: true });
    store(deep, 'buried', 'prj_buried');
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: root }, () => {
      seedAssignment(deep, 'asgn_depth7');
      const result = locateEntity('assignment', 'asgn_depth7', root);
      assert.equal(result.status, 'not_found');
      assert.equal(
        result.enumeration_incomplete,
        true,
        'a cut branch must be reported, or a refusal downstream would be built on a lie',
      );
    });
  });

  it('an uninitialised caller store yields no candidates instead of throwing', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-locator-bare-'));
    cleanups.push(() => fs.rmSync(bare, { recursive: true, force: true }));
    withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: bare }, () => {
      assert.deepEqual(enumerateCandidateStores(bare), []);
      const result = locateEntity('assignment', 'asgn_x', bare);
      assert.equal(result.status, 'not_found');
      assert.deepEqual(result.probed, []);
    });
  });
});
