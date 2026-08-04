/**
 * pln#649 step 1 (dec#153) — the OWNER project must be persisted on execution
 * entities at creation, so entity-authoritative routing has something to compare
 * against instead of re-deriving the project from ambient state.
 *
 * These pins exist because the field's WHOLE value is that it is actually filled.
 * `ClaimSchema` has carried a `project_id` for a long time while `claims.ts`
 * never wrote one — a declared-but-inert field, which is the model-data variant
 * of trp#1275 (a guard that verifies less than it announces). A schema field with
 * no writer and no test looks exactly like a working feature.
 *
 * The backward-compatibility pin is not decoration either: the field is optional
 * so that records written before it existed stay schema-valid. A zod-invalid
 * record is silently DELETED on the next syncDirectory (trp#d5595086), so making
 * this field required would quietly destroy every pre-existing assignment.
 *
 * @module
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssignment, loadAssignment } from '../../src/core/assignments.js';
import { createAgentRun, loadAgentRun } from '../../src/core/agentruns.js';
import { resolveOwnerProjectId } from '../../src/core/config.js';
import { resolveEntityDir } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace | undefined;

afterEach(() => {
  ws?.cleanup();
  ws = undefined;
});

function newAssignment(cwd: string, overrides: Record<string, unknown> = {}) {
  return createAssignment({
    claim_id: 'clm_owner_test',
    agent: 'worker',
    dispatcher_agent: 'coordinator',
    scope: 'src/x.ts',
    description: 'owner project pin',
    ...overrides,
  } as Parameters<typeof createAssignment>[0], cwd);
}

describe('core/owner project id (pln#649 step 1)', () => {
  it('createAssignment stamps the project_id of the store it is written into', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-owner-', projectId: 'prj_owner_alpha' });
    const assignment = newAssignment(ws.dir);
    assert.equal(assignment.project_id, 'prj_owner_alpha');
    // …and it SURVIVES the round-trip to disk — an in-memory-only field would
    // pass a naive assertion while persisting nothing.
    assert.equal(loadAssignment(assignment.id, ws.dir)?.project_id, 'prj_owner_alpha');
  });

  it('createAgentRun stamps the same owner, and it survives the round-trip', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-owner-', projectId: 'prj_owner_beta' });
    const assignment = newAssignment(ws.dir);
    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: 'clm_owner_test',
      agent: 'worker',
      transport: 'cli_spawn',
      scope: 'src/x.ts',
      description: 'owner project pin',
    }, ws.dir);
    assert.equal(run.project_id, 'prj_owner_beta');
    assert.equal(loadAgentRun(run.id, ws.dir)?.project_id, 'prj_owner_beta');
  });

  it('an explicit owner override wins over the store (cross-project creation, tests)', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-owner-', projectId: 'prj_owner_local' });
    const assignment = newAssignment(ws.dir, { project_id: 'prj_owner_elsewhere' });
    assert.equal(assignment.project_id, 'prj_owner_elsewhere');
  });

  // THE LOAD-BEARING COMPAT PIN — see the module docblock. If this ever fails
  // because someone made the field required, every assignment written by an
  // earlier version becomes zod-invalid and is deleted on the next sync.
  it('BACKWARD COMPAT: an assignment record with NO project_id still loads', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-owner-', projectId: 'prj_owner_gamma' });
    const assignment = newAssignment(ws.dir);
    const file = path.join(resolveEntityDir('assignments', ws.dir, 'read'), `${assignment.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    delete raw.project_id;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');

    const reloaded = loadAssignment(assignment.id, ws.dir);
    assert.ok(reloaded, 'a pre-existing record must remain loadable, not vanish');
    assert.equal(reloaded.project_id, undefined, 'absent owner means "legacy", never "refuse"');
  });

  it('an uninitialised store yields no owner instead of throwing', () => {
    // Entity creation must never fail because a store has no readable config —
    // resolveOwnerProjectId swallows and returns undefined.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-owner-bare-'));
    try {
      assert.equal(resolveOwnerProjectId(bare), undefined);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
