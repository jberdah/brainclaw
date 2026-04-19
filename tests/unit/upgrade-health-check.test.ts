import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPostMigrationHealthCheck } from '../../src/core/upgrades/health-check.js';
import {
  V1_TARGET_SCHEMA_VERSION,
  bumpSchemaVersion,
} from '../../src/core/upgrades/schema-version.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function writeJson(file: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
}

function seedMigratedStore(storePath: string): void {
  writeJson(path.join(storePath, 'memory/decisions/dec_001.json'), {
    id: 'dec_001', text: 'd', provenance: { kind: 'legacy' },
  });
  writeJson(path.join(storePath, 'memory/constraints/cst_001.json'), {
    id: 'cst_001', text: 'c', provenance: { kind: 'legacy' },
  });
  writeJson(path.join(storePath, 'coordination/handoffs/hdf_001.json'), {
    id: 'hdf_001', text: 'h', provenance: { kind: 'legacy' },
  });
  fs.mkdirSync(path.join(storePath, 'coordination/inbox'), { recursive: true });
  bumpSchemaVersion({
    storePath,
    to: V1_TARGET_SCHEMA_VERSION,
    patches: ['candidate_archive', 'handoff_review_strip', 'provenance_rollout'],
    now: () => new Date('2026-04-19T08:00:00.000Z'),
  });
}

describe('core/upgrades/health-check (post-migration)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-health-check-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('passes every invariant on a fully migrated store', () => {
    const storePath = storePathOf(workspace);
    seedMigratedStore(storePath);

    const report = runPostMigrationHealthCheck({ storePath });

    assert.equal(report.ok, true);
    assert.equal(report.findings.every((f) => f.status === 'ok'), true);
    assert.equal(report.stats.records_scanned, 3);
    assert.equal(report.stats.records_missing_provenance, 0);
    assert.equal(report.stats.current_schema_version, V1_TARGET_SCHEMA_VERSION);
  });

  it('flags records missing provenance', () => {
    const storePath = storePathOf(workspace);
    seedMigratedStore(storePath);
    writeJson(path.join(storePath, 'memory/traps/trp_bad.json'), { id: 'trp_bad', text: 't' });

    const report = runPostMigrationHealthCheck({ storePath });

    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'provenance');
    assert.ok(finding);
    assert.equal(finding.status, 'error');
    assert.equal(report.stats.records_missing_provenance, 1);
  });

  it('flags records whose provenance has an unknown kind', () => {
    const storePath = storePathOf(workspace);
    seedMigratedStore(storePath);
    writeJson(path.join(storePath, 'memory/decisions/dec_bad.json'), {
      id: 'dec_bad', text: 'd', provenance: { kind: 'not_a_kind' },
    });

    const report = runPostMigrationHealthCheck({ storePath });
    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'provenance');
    assert.ok(finding);
    assert.equal(finding.status, 'error');
  });

  it('flags handoffs still carrying a review sub-object', () => {
    const storePath = storePathOf(workspace);
    seedMigratedStore(storePath);
    writeJson(path.join(storePath, 'coordination/handoffs/hdf_orphan.json'), {
      id: 'hdf_orphan', text: 'h', provenance: { kind: 'legacy' },
      review: { verdict: 'approved' },
    });

    const report = runPostMigrationHealthCheck({ storePath });
    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'handoff_review');
    assert.ok(finding);
    assert.equal(finding.status, 'error');
    assert.equal(report.stats.handoffs_with_review, 1);
  });

  it('flags pending candidates left at inbox root', () => {
    const storePath = storePathOf(workspace);
    seedMigratedStore(storePath);
    writeJson(path.join(storePath, 'coordination/inbox/cnd_stray.json'), {
      id: 'cnd_stray', status: 'pending', type: 'decision',
    });

    const report = runPostMigrationHealthCheck({ storePath });
    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'candidate_archive');
    assert.ok(finding);
    assert.equal(finding.status, 'error');
  });

  it('flags missing schema-version.json', () => {
    const storePath = storePathOf(workspace);
    writeJson(path.join(storePath, 'memory/decisions/dec_001.json'), {
      id: 'dec_001', text: 'd', provenance: { kind: 'legacy' },
    });
    fs.mkdirSync(path.join(storePath, 'coordination/inbox'), { recursive: true });
    fs.mkdirSync(path.join(storePath, 'coordination/handoffs'), { recursive: true });

    const report = runPostMigrationHealthCheck({ storePath });
    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'schema_version');
    assert.ok(finding);
    assert.equal(finding.status, 'error');
    assert.equal(report.stats.current_schema_version, null);
  });

  it('flags a store stuck on an old schema version', () => {
    const storePath = storePathOf(workspace);
    writeJson(path.join(storePath, 'memory/decisions/dec_001.json'), {
      id: 'dec_001', text: 'd', provenance: { kind: 'legacy' },
    });
    fs.mkdirSync(path.join(storePath, 'coordination/inbox'), { recursive: true });
    fs.mkdirSync(path.join(storePath, 'coordination/handoffs'), { recursive: true });
    bumpSchemaVersion({
      storePath, to: '0.7.0', patches: ['partial'],
      now: () => new Date('2026-04-19T08:00:00.000Z'),
    });

    const report = runPostMigrationHealthCheck({ storePath });
    assert.equal(report.ok, false);
    const finding = report.findings.find((f) => f.check === 'schema_version');
    assert.ok(finding);
    assert.match(finding.message, /0\.7\.0.*expected.*0\.8\.0/);
  });
});
