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
 * The backward-compatibility pin is not decoration either: the field is optional so
 * records written before it existed stay LOADABLE — a required field would make
 * every pre-existing record fail schema.parse and drop out of the loaded state.
 * (An earlier version of this docblock said such records are DELETED by
 * syncDirectory. That is false for the current code — state.ts preserves
 * unparseable files precisely so a parse failure cannot corrupt data, trp#126.
 * Corrected after review P2-3; the conclusion "optional is required" stands, the
 * stated reason was wrong.)
 *
 * There is deliberately NO caller override of the owner (review P1-1): a record
 * saved in store A while declaring owner B would be read as a divergence by the
 * step-4 refusal and reject a correctly routed mutation. A forgeable owner is worse
 * than no owner, so the pin below proves the DESTINATION STORE wins.
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
import { defaultConfig, resolveOwnerProjectId, saveConfig } from '../../src/core/config.js';
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

  // Replaces a pin that asserted a caller override WINS — i.e. it pinned the
  // forgery as a feature (review P1-1). What must hold is the opposite: whichever
  // store the record lands in is the owner, and no caller can claim otherwise.
  it('TWO STORES: the owner is the store written to, and a forged claim cannot override it', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-owner-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-owner-b-'));
    try {
      saveConfig(defaultConfig('alpha', { projectId: 'prj_store_a' }), a);
      saveConfig(defaultConfig('beta', { projectId: 'prj_store_b' }), b);

      // Pass a bogus owner through the options bag: the interface no longer
      // declares it, so a caller doing this at runtime must still be ignored.
      const inA = createAssignment({
        claim_id: 'clm_owner_test',
        agent: 'worker',
        dispatcher_agent: 'coordinator',
        scope: 'src/x.ts',
        description: 'destination store wins',
        project_id: 'prj_store_b',
      } as unknown as Parameters<typeof createAssignment>[0], a);

      assert.equal(inA.project_id, 'prj_store_a', 'the write cwd is the owner, not the caller claim');
      assert.equal(loadAssignment(inA.id, a)?.project_id, 'prj_store_a');
      // And the record is genuinely in A, not B — the owner is not just a label.
      assert.equal(loadAssignment(inA.id, b), undefined);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
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

  // Symmetric to the assignment pin above: AgentRunSchema changed too, so its
  // legacy records need the same guarantee (review P2-4).
  it('BACKWARD COMPAT: an agent_run record with NO project_id still loads', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-owner-', projectId: 'prj_owner_delta' });
    const assignment = newAssignment(ws.dir);
    const run = createAgentRun({
      assignment_id: assignment.id,
      claim_id: 'clm_owner_test',
      agent: 'worker',
      transport: 'cli_spawn',
      scope: 'src/x.ts',
      description: 'legacy run pin',
    }, ws.dir);
    const file = path.join(resolveEntityDir('runs', ws.dir, 'read'), `${run.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    delete raw.project_id;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');

    const reloaded = loadAgentRun(run.id, ws.dir);
    assert.ok(reloaded, 'a pre-existing run must remain loadable');
    assert.equal(reloaded.project_id, undefined);
  });

  // review P1-2: a corrupt config must NOT degrade to "no owner". Silently
  // producing an ownerless entity would make step 4 treat it as legacy and skip
  // the refusal — handing back the guarantee this field exists to provide.
  it('a MALFORMED config throws instead of yielding an ownerless entity', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-owner-broken-'));
    try {
      fs.mkdirSync(path.join(broken, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(broken, '.brainclaw', 'config.yaml'), 'project_name: [unclosed\n', 'utf-8');
      assert.throws(() => resolveOwnerProjectId(broken), 'a corrupt store must be loud, not ownerless');
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
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
