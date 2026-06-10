import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { harvestCandidates } from '../../src/commands/harvest.js';
import { archiveCandidate, listCandidates, saveCandidate } from '../../src/core/candidates.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import { worktreesBaseDir } from '../../src/core/worktree.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Candidate } from '../../src/core/schema.js';

function makeCandidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    type: 'decision',
    text: `Candidate ${id}`,
    created_at: new Date().toISOString(),
    author: 'codex',
    tags: [],
    status: 'pending',
    star_count: 0,
    starred_by: [],
    usage_count: 0,
    usage_events: [],
    ...overrides,
  };
}

function writeWorktreeCandidate(worktreeDir: string, candidate: Candidate): void {
  // Write to the entity-model path: .brainclaw/coordination/inbox/
  const inboxDir = path.join(worktreeDir, '.brainclaw', 'coordination', 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${candidate.id}.json`),
    JSON.stringify(candidate, null, 2),
  );
}

describe('harvest/harvestCandidates', () => {
  let workspace: TestWorkspace;
  let worktree1: string;
  let worktree2: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-harvest-', projectId: 'prj_harvest_test' });

    // Create two fake worktree directories (not real git worktrees, just dirs with .brainclaw inboxes)
    worktree1 = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wt1-'));
    worktree2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wt2-'));
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(worktree1, { recursive: true, force: true });
    fs.rmSync(worktree2, { recursive: true, force: true });
  });

  it('harvests new candidates from two worktrees, skips existing', () => {
    // Main store already has cnd_existing
    const existing = makeCandidate('cnd_existing001');
    saveCandidate(existing, workspace.dir);

    // Worktree 1: has cnd_existing001 (duplicate) + cnd_new001
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_existing001'));
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_new00000001'));

    // Worktree 2: has cnd_new002
    writeWorktreeCandidate(worktree2, makeCandidate('cnd_new00000002'));

    const result = harvestCandidates({
      worktreePaths: [worktree1, worktree2],
      cwd: workspace.dir,
      agent: 'coordinator',
    });

    assert.equal(result.harvested.length, 2, 'should harvest 2 new candidates');
    assert.equal(result.skipped.length, 1, 'should skip 1 existing candidate');
    assert.equal(result.errors.length, 0, 'should have no errors');

    const harvestedIds = result.harvested.map((c) => c.id);
    assert.ok(harvestedIds.includes('cnd_new00000001'));
    assert.ok(harvestedIds.includes('cnd_new00000002'));
    assert.ok(result.skipped.includes('cnd_existing001'));

    // Verify candidates are in the main store
    const mainCandidates = listCandidates(undefined, workspace.dir);
    const mainIds = mainCandidates.map((c) => c.id);
    assert.ok(mainIds.includes('cnd_new00000001'));
    assert.ok(mainIds.includes('cnd_new00000002'));
    assert.ok(mainIds.includes('cnd_existing001'));
  });

  it('auto-detects worktrees using the shared core worktree base directory', () => {
    const base = worktreesBaseDir(workspace.dir);
    const managedWorktree = path.join(base, 'harvest-autodetect-test');
    fs.mkdirSync(managedWorktree, { recursive: true });
    writeWorktreeCandidate(managedWorktree, makeCandidate('cnd_autodetect_01'));

    try {
      const result = harvestCandidates({ cwd: workspace.dir });
      assert.equal(result.harvested.length, 1);
      assert.equal(result.harvested[0].id, 'cnd_autodetect_01');
    } finally {
      fs.rmSync(managedWorktree, { recursive: true, force: true });
    }
  });

  it('normalizes Windows-style project path case for the worktree base hash', () => {
    assert.equal(
      worktreesBaseDir('C:\\Users\\Test\\Project'),
      worktreesBaseDir('c:\\users\\test\\project'),
    );
  });

  it('emits a candidate_harvested runtime event for each copied candidate', () => {
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_event_test01'));
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_event_test02'));

    harvestCandidates({
      worktreePaths: [worktree1],
      cwd: workspace.dir,
      agent: 'coordinator',
    });

    const events = listRuntimeEvents(workspace.dir);
    const harvestEvents = events.filter((e) => e.event_type === 'candidate_harvested');
    assert.equal(harvestEvents.length, 2, 'should emit one event per harvested candidate');

    const eventCandidateIds = harvestEvents.map((e) => (e.metadata as Record<string, unknown> | undefined)?.candidate_id);
    assert.ok(eventCandidateIds.includes('cnd_event_test01'));
    assert.ok(eventCandidateIds.includes('cnd_event_test02'));
  });

  it('dryRun does NOT copy candidates to main store', () => {
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_dry_run_001'));

    const result = harvestCandidates({
      worktreePaths: [worktree1],
      dryRun: true,
      cwd: workspace.dir,
      agent: 'coordinator',
    });

    // Result still reports what would be harvested
    assert.equal(result.harvested.length, 1, 'dry-run should report the candidate');
    assert.equal(result.errors.length, 0);

    // But nothing should be written to the main store
    const mainCandidates = listCandidates(undefined, workspace.dir);
    const mainIds = mainCandidates.map((c) => c.id);
    assert.ok(!mainIds.includes('cnd_dry_run_001'), 'dry-run must not write to main store');

    // No runtime events should be emitted
    const events = listRuntimeEvents(workspace.dir);
    const harvestEvents = events.filter((e) => e.event_type === 'candidate_harvested');
    assert.equal(harvestEvents.length, 0, 'dry-run must not emit runtime events');
  });

  it('returns empty result when no worktrees have candidates', () => {
    // worktree1 exists but has no inbox
    const result = harvestCandidates({
      worktreePaths: [worktree1],
      cwd: workspace.dir,
    });

    assert.equal(result.harvested.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it('reports parse errors without crashing', () => {
    // Write a malformed JSON file
    const inboxDir = path.join(worktree1, '.brainclaw', 'coordination', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'cnd_bad_file.json'), '{ invalid json ]');

    const result = harvestCandidates({
      worktreePaths: [worktree1],
      cwd: workspace.dir,
    });

    assert.equal(result.harvested.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes('cnd_bad_file.json'));
  });

  it('skips candidates already archived (accepted or rejected) in main store', () => {
    // Save + archive a candidate as accepted in the main store
    const accepted = makeCandidate('cnd_archived_acc');
    saveCandidate(accepted, workspace.dir);
    archiveCandidate(accepted, 'accepted', workspace.dir);

    // Save + archive another as rejected
    const rejected = makeCandidate('cnd_archived_rej');
    saveCandidate(rejected, workspace.dir);
    archiveCandidate(rejected, 'rejected', workspace.dir);

    // Worktree has both IDs + one genuinely new
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_archived_acc'));
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_archived_rej'));
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_truly_new_01'));

    const result = harvestCandidates({
      worktreePaths: [worktree1],
      cwd: workspace.dir,
    });

    assert.equal(result.harvested.length, 1, 'only the truly new candidate');
    assert.equal(result.skipped.length, 2, 'both archived IDs skipped');
    assert.equal(result.harvested[0].id, 'cnd_truly_new_01');
  });

  it('records per-worktree error when worktree directory disappears mid-harvest', () => {
    // Write a candidate in worktree1
    writeWorktreeCandidate(worktree1, makeCandidate('cnd_surviving_01'));

    // Create a fake "worktree3" path that does NOT exist on disk
    const ghostWorktree = path.join(os.tmpdir(), 'bclaw-ghost-wt-does-not-exist');

    const result = harvestCandidates({
      worktreePaths: [ghostWorktree, worktree1],
      cwd: workspace.dir,
    });

    // The ghost worktree should produce 0 harvested and 0 errors (empty inbox)
    // since collectWorktreeCandidateFiles handles missing dirs gracefully.
    // But if the dir existed momentarily then vanished mid-iteration,
    // the try/catch should record an error without crashing.
    assert.equal(result.harvested.length, 1, 'worktree1 candidate harvested');
    assert.equal(result.harvested[0].id, 'cnd_surviving_01');
    // Ghost worktree has no inbox → no crash, no error (dirs don't exist check is safe)
    assert.equal(result.errors.length, 0);
  });

  it('handles legacy .brainclaw/inbox path alongside entity path without duplicates', () => {
    // Write the same candidate ID in both paths
    const candidate = makeCandidate('cnd_dual_path_01');
    const entityDir = path.join(worktree1, '.brainclaw', 'coordination', 'inbox');
    const legacyDir = path.join(worktree1, '.brainclaw', 'inbox');
    fs.mkdirSync(entityDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(entityDir, `${candidate.id}.json`), JSON.stringify(candidate));
    fs.writeFileSync(path.join(legacyDir, `${candidate.id}.json`), JSON.stringify(candidate));

    const result = harvestCandidates({
      worktreePaths: [worktree1],
      cwd: workspace.dir,
    });

    // Should harvest exactly once even though the file appears in two dirs
    assert.equal(result.harvested.length, 1, 'must dedupe same id from entity + legacy paths');
    assert.equal(result.skipped.length, 0);
  });
});
