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
import { createAssignment, deleteAssignment, listAssignments, loadAssignment, saveAssignment } from '../../src/core/assignments.js';
import { createAgentRun, listAgentRuns, loadAgentRun } from '../../src/core/agentruns.js';
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

/**
 * pln#649 — the LIST/SAVE/DELETE half of the same asymmetry, from a Fable audit.
 *
 * The by-id loaders were fixed to read both layouts while the LISTS still read one
 * directory chosen by the `hasContent` heuristic, and the saves/deletes only ever touched
 * the canonical one. So three layers gave three answers about one store.
 *
 * SEVERITY, STATED HONESTLY: assignments and agent runs POSTDATE the partitioned layout,
 * so brainclaw has never written them flat — measured legacy=0 in the field, and these
 * pins have to MANUFACTURE the state with `demote()`. That is why this is internal
 * consistency rather than a field fix, and why it is pinned at the surface where the
 * consequence is observable rather than on the list helpers.
 */
describe('core — list/save/delete converge both layouts (pln#649)', () => {
  it('listAssignments sees a legacy record, not just the canonical directory', () => {
    const cwd = store();
    createAssignment({ id: 'asgn_canon', short_label: 'asgn_canon', claim_id: 'clm_l', agent: 'w', dispatcher_agent: 'c', scope: 's', description: 'd' }, cwd);
    createAssignment({ id: 'asgn_old', short_label: 'asgn_old', claim_id: 'clm_l', agent: 'w', dispatcher_agent: 'c', scope: 's', description: 'd' }, cwd);
    demote(cwd, 'assignments', 'asgn_old');

    const ids = listAssignments(cwd).map((a) => a.id);
    assert.ok(ids.includes('asgn_old'), `a legacy record must be listed — got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('asgn_canon'), 'the canonical record must still be listed');
    assert.equal(new Set(ids).size, ids.length, 'a record present in both layouts must appear ONCE');
  });

  it('saving a demoted record CONVERGES it instead of leaving a stale twin', () => {
    const cwd = store();
    const created = createAssignment({ id: 'asgn_conv', short_label: 'asgn_conv', claim_id: 'clm_l', agent: 'w', dispatcher_agent: 'c', scope: 's', description: 'd' }, cwd);
    demote(cwd, 'assignments', 'asgn_conv');

    // A save must not produce two copies with different contents.
    saveAssignment({ ...created, description: 'updated after demotion' }, cwd);

    const present = entityRecordPaths('assignments', 'asgn_conv', cwd).filter((p) => fs.existsSync(p));
    assert.equal(present.length, 1, `exactly one copy must survive a save — got ${JSON.stringify(present)}`);
    assert.match(present[0], /coordination/, 'the surviving copy must be the canonical one');
    assert.equal(loadAssignment('asgn_conv', cwd)?.description, 'updated after demotion');
  });

  it('deleting a legacy-only record really deletes it — one layout is not the record', () => {
    const cwd = store();
    createAssignment({ id: 'asgn_del', short_label: 'asgn_del', claim_id: 'clm_l', agent: 'w', dispatcher_agent: 'c', scope: 's', description: 'd' }, cwd);
    // A second canonical record so the `hasContent` heuristic keeps pointing at canonical.
    createAssignment({ id: 'asgn_keep', short_label: 'asgn_keep', claim_id: 'clm_l', agent: 'w', dispatcher_agent: 'c', scope: 's', description: 'd' }, cwd);
    demote(cwd, 'assignments', 'asgn_del');

    assert.ok(loadAssignment('asgn_del', cwd), 'precondition: the by-id loader can see it');
    assert.equal(deleteAssignment('asgn_del', cwd), true, 'a record the loader can find must be deletable');
    assert.equal(loadAssignment('asgn_del', cwd), undefined, 'and must be GONE — not resurrected from the other layout');
    assert.ok(loadAssignment('asgn_keep', cwd), 'the untouched record must survive');
  });

  it('a demoted run does not make the next attempt index restart at 1', () => {
    const cwd = store();
    const first = createAgentRun({ assignment_id: 'asgn_attempt', claim_id: 'clm_l', agent: 'w', transport: 'cli_spawn', scope: 's', description: 'd' }, cwd);
    assert.equal(first.attempt_index, 1, 'precondition: the first attempt is 1');
    demote(cwd, 'runs', first.id);

    // Pinned through the real entry point: `nextAttemptIndex` is private, and what matters
    // is that a retry created the normal way cannot collide with the invisible attempt.
    const second = createAgentRun({ assignment_id: 'asgn_attempt', claim_id: 'clm_l', agent: 'w', transport: 'cli_spawn', scope: 's', description: 'd' }, cwd);
    assert.equal(second.attempt_index, 2, 'the demoted attempt must still count — a restart at 1 collides with it');
    assert.ok(listAgentRuns(cwd, { assignment_id: 'asgn_attempt' }).some((r) => r.id === first.id),
      'and the demoted run must be listed');
  });
});
