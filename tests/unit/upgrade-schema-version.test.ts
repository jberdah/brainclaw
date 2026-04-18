import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPLICIT_BASELINE_VERSION,
  SCHEMA_VERSION_FILE,
  SchemaVersionFileSchema,
  V1_TARGET_SCHEMA_VERSION,
  bumpSchemaVersion,
  readSchemaVersion,
} from '../../src/core/upgrades/schema-version.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

describe('core/upgrades/schema-version', () => {
  let workspace: TestWorkspace;
  const fixedNow = () => new Date('2026-04-18T17:00:00.000Z');

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-schema-version-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('returns implicit baseline when the file is absent', () => {
    const storePath = storePathOf(workspace);
    const result = readSchemaVersion(storePath);
    assert.equal(result.present, false);
    assert.equal(result.current, IMPLICIT_BASELINE_VERSION);
    assert.deepEqual(result.history, []);
  });

  it('writes a new file with the first transition on initial bump', () => {
    const storePath = storePathOf(workspace);
    const result = bumpSchemaVersion({
      storePath,
      to: V1_TARGET_SCHEMA_VERSION,
      patches: ['candidate_archive', 'handoff_review_strip', 'provenance_rollout'],
      reason: 'test bump',
      now: fixedNow,
    });

    assert.equal(result.status, 'bumped');
    assert.equal(result.from, IMPLICIT_BASELINE_VERSION);
    assert.equal(result.to, V1_TARGET_SCHEMA_VERSION);

    const disk = SchemaVersionFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(storePath, SCHEMA_VERSION_FILE), 'utf-8')),
    );
    assert.equal(disk.current, V1_TARGET_SCHEMA_VERSION);
    assert.equal(disk.history.length, 1);
    assert.equal(disk.history[0]!.from, IMPLICIT_BASELINE_VERSION);
    assert.equal(disk.history[0]!.to, V1_TARGET_SCHEMA_VERSION);
    assert.deepEqual(disk.history[0]!.patches, [
      'candidate_archive', 'handoff_review_strip', 'provenance_rollout',
    ]);
    assert.equal(disk.history[0]!.at, '2026-04-18T17:00:00.000Z');
  });

  it('is idempotent — second bump to same version is a noop', () => {
    const storePath = storePathOf(workspace);
    bumpSchemaVersion({
      storePath, to: V1_TARGET_SCHEMA_VERSION, patches: ['p'], now: fixedNow,
    });

    const second = bumpSchemaVersion({
      storePath, to: V1_TARGET_SCHEMA_VERSION, patches: ['p'], now: fixedNow,
    });
    assert.equal(second.status, 'noop');
    assert.equal(second.transitions, 1, 'history remains single entry on noop');
  });

  it('appends to history when bumping through successive versions', () => {
    const storePath = storePathOf(workspace);

    bumpSchemaVersion({
      storePath, to: '0.7.0', patches: ['first_patch'],
      now: () => new Date('2026-04-18T17:00:00.000Z'),
    });
    bumpSchemaVersion({
      storePath, to: '0.8.0', patches: ['second_patch'],
      now: () => new Date('2026-04-18T18:00:00.000Z'),
    });

    const disk = readSchemaVersion(storePath);
    assert.equal(disk.current, '0.8.0');
    assert.equal(disk.history.length, 2);
    assert.equal(disk.history[0]!.from, IMPLICIT_BASELINE_VERSION);
    assert.equal(disk.history[0]!.to, '0.7.0');
    assert.equal(disk.history[1]!.from, '0.7.0');
    assert.equal(disk.history[1]!.to, '0.8.0');
  });

  it('dry-run plans without writing the file', () => {
    const storePath = storePathOf(workspace);
    const result = bumpSchemaVersion({
      storePath, to: V1_TARGET_SCHEMA_VERSION, patches: ['p'], now: fixedNow, dryRun: true,
    });

    assert.equal(result.status, 'planned');
    assert.equal(result.from, IMPLICIT_BASELINE_VERSION);
    assert.equal(result.to, V1_TARGET_SCHEMA_VERSION);
    assert.equal(fs.existsSync(path.join(storePath, SCHEMA_VERSION_FILE)), false);
  });

  it('preserves an existing history trail when bumping from a read state', () => {
    const storePath = storePathOf(workspace);
    const seed = {
      schema_version: 1,
      current: '0.7.0',
      history: [
        { from: '0.6.0', to: '0.7.0', at: '2026-04-17T00:00:00.000Z', patches: ['seed'] },
      ],
    };
    fs.writeFileSync(path.join(storePath, SCHEMA_VERSION_FILE), JSON.stringify(seed, null, 2), 'utf-8');

    bumpSchemaVersion({
      storePath, to: '0.8.0', patches: ['next'], now: fixedNow,
    });

    const disk = readSchemaVersion(storePath);
    assert.equal(disk.history.length, 2);
    assert.equal(disk.history[0]!.patches[0], 'seed');
    assert.equal(disk.history[1]!.from, '0.7.0');
    assert.equal(disk.history[1]!.to, '0.8.0');
  });
});
