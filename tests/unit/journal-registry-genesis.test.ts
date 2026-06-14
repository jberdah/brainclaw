/**
 * pln#568 slice 3 — registry genesis supplement + cutover marker.
 *
 * `runRegistryGenesisSupplement` backfills the registry/coordination families
 * into the journal and emits the `registry_genesis` marker so a store that was
 * journal-enabled BEFORE pln#568 (its registry entities have no post-images)
 * becomes journal-authoritative without a disruptive re-genesis. These tests
 * prove the backfill is complete (zero verify drift), idempotent, dry-run safe,
 * and that `migrate --enable-journal` wires it in.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { acquireClaimScope } from '../../src/core/claims.js';
import { createAssignment } from '../../src/core/assignments.js';
import { createSequence } from '../../src/core/sequence.js';
import { runMigrate } from '../../src/commands/migrate.js';
import { hasRegistryGenesis, runRegistryGenesisSupplement } from '../../src/core/events/genesis.js';
import { materializeRegistryFromJournal } from '../../src/core/events/materialize.js';
import { verifyRegistryAgainstJournal } from '../../src/core/events/verify.js';
import { readJournalRecords } from '../../src/core/events/journal.js';
import { loadConfig } from '../../src/core/config.js';

let ws: TestWorkspace | undefined;
let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env.BRAINCLAW_JOURNAL_MODE;
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE; else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
  ws?.cleanup();
  ws = undefined;
});

/** Create registry entities with the journal OFF, so they have NO post-images
 *  (the pre-pln#568 / pre-cutover state the supplement must repair). */
function seedRegistryEntitiesWithoutJournal(dir: string): { claimId: string; assignmentId: string; sequenceId: string } {
  delete process.env.BRAINCLAW_JOURNAL_MODE; // journal off
  const { claim } = acquireClaimScope({ scope: 'src/leg', agent: 'tester', description: 'legacy' }, dir);
  const assignment = createAssignment({ claim_id: claim!.id, agent: 'worker', dispatcher_agent: 'tester', scope: 'src/leg', description: 'legacy work' }, dir);
  const { id: sequenceId } = createSequence({ name: 'legacy-seq', owner: 'tester', author: 'tester' }, dir);
  return { claimId: claim!.id, assignmentId: assignment.id, sequenceId };
}

describe('registry genesis supplement (pln#568 slice 3)', () => {
  it('backfills pre-existing registry entities and emits the cutover marker', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-reg-genesis-', projectId: 'prj_rg', currentAgent: 'tester' });
    const dir = ws.dir;
    const { claimId, assignmentId, sequenceId } = seedRegistryEntitiesWithoutJournal(dir);

    // Journal off → these entities have no post-images yet.
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    assert.equal(hasRegistryGenesis(dir), false);
    assert.equal((materializeRegistryFromJournal(dir).get('claim') ?? []).length, 0, 'no claim post-image before supplement');

    const result = runRegistryGenesisSupplement({ cwd: dir });
    assert.equal(result.status, 'migrated');
    assert.ok(result.backfilled >= 3, 'claim + assignment + sequence backfilled');

    assert.equal(hasRegistryGenesis(dir), true, 'cutover marker emitted');
    const reg = materializeRegistryFromJournal(dir);
    assert.ok((reg.get('claim') ?? []).some((e) => e.item_id === claimId), 'claim backfilled');
    assert.ok((reg.get('assignment') ?? []).some((e) => e.item_id === assignmentId), 'assignment backfilled');
    assert.ok((reg.get('sequence') ?? []).some((e) => e.item_id === sequenceId), 'sequence backfilled');

    // The backfill is faithful: doctor --verify-journal sees zero registry drift.
    assert.deepEqual(verifyRegistryAgainstJournal(dir), []);
  });

  it('is idempotent — a second supplement no-ops and keeps a single marker', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-reg-genesis-', projectId: 'prj_rg2', currentAgent: 'tester' });
    const dir = ws.dir;
    seedRegistryEntitiesWithoutJournal(dir);
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';

    runRegistryGenesisSupplement({ cwd: dir });
    const second = runRegistryGenesisSupplement({ cwd: dir });
    assert.equal(second.status, 'already_present');
    assert.equal(second.backfilled, 0);

    const markers = readJournalRecords(dir).filter(
      (r) => r.action === 'journal_note' && (r.payload as { kind?: string } | undefined)?.kind === 'registry_genesis',
    );
    assert.equal(markers.length, 1, 'exactly one cutover marker');
  });

  it('dry-run writes nothing', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-reg-genesis-', projectId: 'prj_rg3', currentAgent: 'tester' });
    const dir = ws.dir;
    seedRegistryEntitiesWithoutJournal(dir);
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';

    const planned = runRegistryGenesisSupplement({ cwd: dir, dryRun: true });
    assert.equal(planned.status, 'dry_run');
    assert.ok(planned.backfilled >= 3, 'dry-run reports the would-be backfill count');
    assert.equal(hasRegistryGenesis(dir), false, 'dry-run emitted no marker');
  });

  it('migrate --enable-journal emits the registry cutover marker', () => {
    ws = createTestWorkspace({ prefix: 'bclaw-reg-genesis-', projectId: 'prj_rg4', currentAgent: 'tester' });
    const dir = ws.dir;
    seedRegistryEntitiesWithoutJournal(dir);

    runMigrate({ enableJournal: true, cwd: dir });

    assert.equal(loadConfig(dir).store?.journal?.mode, 'dual');
    assert.equal(hasRegistryGenesis(dir), true, 'enable-journal ran the registry supplement');
    assert.deepEqual(verifyRegistryAgainstJournal(dir), []);
  });
});
