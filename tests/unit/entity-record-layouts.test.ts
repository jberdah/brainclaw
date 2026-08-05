/**
 * pln#649 — the per-record layout primitive (`entityRecordDirs` / `entityRecordPaths`).
 *
 * WHY THIS FILE EXISTS. `resolveEntityDir(mode='read')` answers a DIRECTORY question
 * ("where do records of this kind generally live") with a `hasContent` heuristic.
 * Every by-id loader used it for a FILE question ("where is THIS record"), and in a
 * store mid-migration one file in the canonical directory makes every legacy record
 * invisible. Three code reviews found that same defect at three different call sites,
 * one after the other, because each was patched locally instead of fixing the
 * primitive. These pins cover the primitive and EVERY by-id loader at once, so the
 * fourth site cannot regress silently.
 *
 * The claim and agent_run cases were latent — found by a Fable audit predicting the
 * next field report ("claim bloqué actif") before it happened.
 *
 * @module
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { entityRecordDirs, entityRecordPaths } from '../../src/core/io.js';
import { createAssignment, loadAssignment } from '../../src/core/assignments.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function store(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-layout-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig('layout', { projectId: 'prj_layout' }), dir);
  return dir;
}

/** Move a record from the canonical layout to the pre-migration flat one. */
function demote(cwd: string, subdir: string, id: string): void {
  const [canonical, legacy] = entityRecordDirs(subdir, cwd);
  assert.ok(legacy, `${subdir} must have a legacy layout to demote into`);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.renameSync(path.join(canonical, `${id}.json`), path.join(legacy, `${id}.json`));
}

describe('core/io entity record layouts (pln#649)', () => {
  it('the primitive lists canonical FIRST, then legacy, and never duplicates', () => {
    const cwd = store();
    for (const subdir of ['assignments', 'claims', 'runs', 'plans']) {
      const list = entityRecordDirs(subdir, cwd);
      assert.equal(list.length, 2, `${subdir} should expose both layouts`);
      assert.match(list[0], /coordination/, `${subdir}: canonical must come first`);
      assert.equal(list[1], path.join(cwd, '.brainclaw', subdir));
      assert.equal(new Set(list).size, list.length);
    }
    // An unmapped kind has only its own directory — no invented canonical path.
    assert.deepEqual(entityRecordDirs('not-a-kind', cwd), [path.join(cwd, '.brainclaw', 'not-a-kind')]);
    assert.deepEqual(
      entityRecordPaths('assignments', 'asgn_x', cwd),
      entityRecordDirs('assignments', cwd).map((d) => path.join(d, 'asgn_x.json')),
    );
  });

  it('loadAssignment finds a legacy record while the canonical dir has content', () => {
    const cwd = store();
    createAssignment({
      id: 'asgn_legacy', claim_id: 'clm_x', agent: 'w', dispatcher_agent: 'c',
      scope: 's', description: 'd',
    }, cwd);
    createAssignment({
      id: 'asgn_canonical', claim_id: 'clm_x', agent: 'w', dispatcher_agent: 'c',
      scope: 's', description: 'd',
    }, cwd);
    demote(cwd, 'assignments', 'asgn_legacy');
    assert.ok(loadAssignment('asgn_legacy', cwd), 'legacy assignment must stay loadable');
    assert.ok(loadAssignment('asgn_canonical', cwd));
  });

  // Latent until a Fable audit predicted it: claimDirs looked like it covered both
  // layouts (a Set of write+read dirs) and collapsed to one as soon as the canonical
  // directory held a file.
  it('loadClaim finds a legacy record while the canonical dir has content', () => {
    const cwd = store();
    const base = {
      agent: 'w', scope: 's', description: 'd', created_at: new Date().toISOString(),
      status: 'active' as const,
    };
    saveClaim({ ...base, id: 'clm_legacy' }, cwd);
    saveClaim({ ...base, id: 'clm_canonical' }, cwd);
    demote(cwd, 'claims', 'clm_legacy');
    assert.equal(loadClaim('clm_legacy', cwd).id, 'clm_legacy', 'legacy claim must stay loadable');
    assert.equal(loadClaim('clm_canonical', cwd).id, 'clm_canonical');
  });

  it('loadAgentRun finds a legacy record while the canonical dir has content', () => {
    const cwd = store();
    const base = {
      assignment_id: 'asgn_x', claim_id: 'clm_x', agent: 'w',
      transport: 'cli_spawn' as const, scope: 's', description: 'd',
    };
    createAgentRun({ ...base, id: 'run_legacy' }, cwd);
    createAgentRun({ ...base, id: 'run_canonical' }, cwd);
    demote(cwd, 'runs', 'run_legacy');
    assert.ok(loadAgentRun('run_legacy', cwd), 'legacy agent_run must stay loadable');
    assert.ok(loadAgentRun('run_canonical', cwd));
  });
});
