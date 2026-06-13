/**
 * pln#568 (phase 1.5) — registry/coordination families journal full
 * entity-state post-images.
 *
 * BEFORE: claim/assignment/agent_run reached the v2 journal envelope-only (0
 * payload) or not at all (trp_2a89ae97), so the observer could not rebuild them
 * from the journal. NOW each persist chokepoint emits a byte-faithful post-image
 * (emitRegistryPostImage) with a monotonic entity_rev, mirroring the memory
 * families. These tests prove: the post-image round-trips through materialize,
 * verify sees zero drift, the legacy envelope-only record is suppressed, and the
 * I2 journal-before-projection ordering holds under crash injection.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { acquireClaimScope, listClaims, releaseClaim } from '../../src/core/claims.js';
import { createAssignment } from '../../src/core/assignments.js';
import { createAgentRun } from '../../src/core/agentruns.js';
import { readJournalRecords } from '../../src/core/events/journal.js';
import { materializeRegistryFromJournal } from '../../src/core/events/materialize.js';
import { verifyRegistryAgainstJournal } from '../../src/core/events/verify.js';

let ws: TestWorkspace | undefined;
let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env.BRAINCLAW_JOURNAL_MODE;
  process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
  ws = createTestWorkspace({ prefix: 'bclaw-registry-postimage-', projectId: 'prj_reg_pi', currentAgent: 'tester' });
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
  ws?.cleanup();
  ws = undefined;
});

/** Seed one of each coordination family, returning their ids. */
function seedCoordinationEntities(dir: string): { claimId: string; assignmentId: string; runId: string } {
  const { claim } = acquireClaimScope({ scope: 'src/x', agent: 'tester', description: 'probe' }, dir);
  assert.ok(claim, 'claim acquired');
  const assignment = createAssignment({
    claim_id: claim!.id, agent: 'worker', dispatcher_agent: 'tester', scope: 'src/x', description: 'do work',
  }, dir);
  const run = createAgentRun({
    assignment_id: assignment.id, claim_id: claim!.id, agent: 'worker', transport: 'cli_spawn', scope: 'src/x', description: 'run work',
  }, dir);
  return { claimId: claim!.id, assignmentId: assignment.id, runId: run.id };
}

describe('registry post-images (pln#568 slice 1)', () => {
  it('journals full post-images that round-trip through materialize with zero verify drift', () => {
    const dir = ws!.dir;
    const { claimId, assignmentId, runId } = seedCoordinationEntities(dir);

    const registry = materializeRegistryFromJournal(dir);
    const claims = registry.get('claim') ?? [];
    const assignments = registry.get('assignment') ?? [];
    const runs = registry.get('agent_run') ?? [];

    assert.equal(claims.length, 1, 'one claim post-image in the journal');
    assert.equal(assignments.length, 1, 'one assignment post-image');
    assert.equal(runs.length, 1, 'one agent_run post-image');

    // Post-images carry the full document, not just an envelope.
    assert.equal(claims[0].item_id, claimId);
    assert.equal(claims[0].payload['scope'], 'src/x');
    assert.equal(assignments[0].payload['id'], assignmentId);
    assert.equal(assignments[0].payload['description'], 'do work');
    assert.equal(runs[0].payload['id'], runId);
    assert.equal(runs[0].payload['transport'], 'cli_spawn');

    // The dual-write is faithful: projection and journal agree.
    assert.deepEqual(verifyRegistryAgainstJournal(dir), []);
  });

  it('bumps entity_rev monotonically across updates of the same entity', () => {
    const dir = ws!.dir;
    const { claim } = acquireClaimScope({ scope: 'src/y', agent: 'tester', description: 'rev probe' }, dir);
    releaseClaim(claim!.id, dir); // second post-image for the same claim

    const claimRecords = readJournalRecords(dir).filter((r) => r.item_type === 'claim' && r.item_id === claim!.id);
    assert.ok(claimRecords.length >= 2, 'create + release each emit a post-image');
    const revs = claimRecords.map((r) => r.entity_rev);
    assert.ok(revs.every((r) => typeof r === 'number'), 'every registry post-image carries entity_rev');
    for (let i = 1; i < revs.length; i++) {
      assert.ok((revs[i] as number) > (revs[i - 1] as number), 'entity_rev strictly increases');
    }
    // The latest materialized post-image reflects the released status.
    const live = (materializeRegistryFromJournal(dir).get('claim') ?? []).find((e) => e.item_id === claim!.id);
    assert.equal(live?.payload['status'], 'released');
  });

  it('suppresses the legacy envelope-only lifecycle record (post-images only in the v2 journal)', () => {
    const dir = ws!.dir;
    seedCoordinationEntities(dir);

    const records = readJournalRecords(dir);
    for (const itemType of ['claim', 'assignment', 'agent_run']) {
      const fam = records.filter((r) => r.item_type === itemType);
      assert.ok(fam.length > 0, `${itemType} has journal records`);
      for (const r of fam) {
        // Only entity-state verbs (create/update) — never a registry-lifecycle
        // envelope (assignment_started, run_completed, claim, …).
        assert.ok(['create', 'update', 'delete'].includes(r.action), `${itemType} record uses an entity-state verb, got ${r.action}`);
        if (r.action !== 'delete') {
          assert.ok(r.payload && Object.keys(r.payload).length > 0, `${itemType} ${r.action} carries a payload`);
        }
      }
    }
  });

  it('honors I2: a crash after the journal emit leaves the journal ahead, projection behind', async () => {
    const dir = ws!.dir;
    const claimsUrl = new URL('../../src/core/claims.js', import.meta.url).href;
    const script = `
      import { acquireClaimScope } from ${JSON.stringify(claimsUrl)};
      acquireClaimScope({ scope: 'src/crash', agent: 'tester', description: 'crash probe' }, ${JSON.stringify(dir)});
    `;
    const status: number | null = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, BRAINCLAW_JOURNAL_MODE: 'dual', BRAINCLAW_FAULT_POINT: 'after_registry_journal' },
      });
      child.on('close', resolve);
    });
    assert.notEqual(status, 0, 'child must crash at the injected fault point');

    // Journal is AHEAD: the post-image was appended+fsync'd before the crash.
    const journalHasIt = readJournalRecords(dir).some((r) => r.item_type === 'claim' && r.payload?.['scope'] === 'src/crash');
    assert.equal(journalHasIt, true, 'journal must contain the post-image (emitted before the projection)');

    // Projection is BEHIND: the claim file write never ran.
    const projectionHasIt = listClaims(dir).some((c) => c.scope === 'src/crash');
    assert.equal(projectionHasIt, false, 'projection must NOT have the claim yet (recoverable direction)');
  });

  it('emits nothing to the journal when the mode is off', () => {
    const dir = ws!.dir;
    process.env.BRAINCLAW_JOURNAL_MODE = 'off';
    try {
      acquireClaimScope({ scope: 'src/off', agent: 'tester', description: 'off probe' }, dir);
      assert.equal(readJournalRecords(dir).length, 0, 'journal off → no records');
    } finally {
      process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    }
  });
});
