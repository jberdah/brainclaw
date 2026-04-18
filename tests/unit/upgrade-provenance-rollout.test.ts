import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MIGRATIONS_ARCHIVE_SUBPATH,
  PROVENANCE_ENTITY_LAYOUTS,
  PROVENANCE_ROLLOUT_LOG,
  ProvenanceRolloutLogSchema,
  rolloutProvenance,
} from '../../src/core/upgrades/patches/provenance-rollout.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function writeRecord(
  storePath: string,
  kind: 'decision' | 'constraint' | 'trap' | 'handoff' | 'runtime_note',
  id: string,
  body: Record<string, unknown>,
  subPath?: string,
): string {
  const layout = PROVENANCE_ENTITY_LAYOUTS.find((l) => l.kind === kind);
  if (!layout) throw new Error(`no layout for ${kind}`);
  const dir = subPath ? path.join(storePath, layout.dir, subPath) : path.join(storePath, layout.dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
  return file;
}

describe('core/upgrades/patches/provenance-rollout', () => {
  let workspace: TestWorkspace;
  const fixedNow = () => new Date('2026-04-18T16:00:00.000Z');

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-provenance-rollout-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('returns noop when every record already carries provenance', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'decision', 'dec_001', {
      id: 'dec_001',
      text: 'already migrated',
      provenance: { kind: 'user', author: 'jberdah' },
    });

    const result = rolloutProvenance({ storePath, now: fixedNow });

    assert.equal(result.status, 'noop');
    assert.equal(result.stamped.length, 0);
    assert.equal(result.scanned, 1);
    assert.equal(result.logPath, null);
  });

  it('stamps legacy provenance on every entity kind and writes a log', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'decision',   'dec_001', { id: 'dec_001', text: 'd1' });
    writeRecord(storePath, 'constraint', 'cst_001', { id: 'cst_001', text: 'c1' });
    writeRecord(storePath, 'trap',       'trp_001', { id: 'trp_001', text: 't1' });
    writeRecord(storePath, 'handoff',    'hdf_001', { id: 'hdf_001', text: 'h1' });
    writeRecord(storePath, 'runtime_note', 'rtn_001', { id: 'rtn_001', text: 'r1' }, 'claude-code');
    writeRecord(storePath, 'runtime_note', 'rtn_002', { id: 'rtn_002', text: 'r2' }, 'codex');

    const result = rolloutProvenance({ storePath, now: fixedNow });

    assert.equal(result.status, 'stamped');
    assert.equal(result.scanned, 6);
    assert.equal(result.stamped.length, 6);
    assert.deepEqual(result.countsByKind, {
      decision: 1,
      constraint: 1,
      trap: 1,
      handoff: 1,
      runtime_note: 2,
    });

    const decFile = path.join(storePath, 'memory', 'decisions', 'dec_001.json');
    const decDisk = JSON.parse(fs.readFileSync(decFile, 'utf-8'));
    assert.deepEqual(decDisk.provenance, { kind: 'legacy' });

    const rtnFile = path.join(storePath, 'coordination', 'runtime', 'codex', 'rtn_002.json');
    const rtnDisk = JSON.parse(fs.readFileSync(rtnFile, 'utf-8'));
    assert.deepEqual(rtnDisk.provenance, { kind: 'legacy' });

    const log = ProvenanceRolloutLogSchema.parse(
      JSON.parse(fs.readFileSync(result.logPath as string, 'utf-8')),
    );
    assert.equal(log.count, 6);
    assert.equal(log.entries.length, 6);
    const expectedLogPath = path.join(
      storePath,
      MIGRATIONS_ARCHIVE_SUBPATH,
      '2026-04-18',
      PROVENANCE_ROLLOUT_LOG,
    );
    assert.equal(result.logPath, expectedLogPath);
  });

  it('only stamps records that do not already carry provenance', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'decision', 'dec_legacy', { id: 'dec_legacy', text: 'will be stamped' });
    writeRecord(storePath, 'decision', 'dec_userset', {
      id: 'dec_userset',
      text: 'already stamped',
      provenance: { kind: 'user', author: 'jberdah' },
    });

    const result = rolloutProvenance({ storePath, now: fixedNow });
    assert.equal(result.stamped.length, 1);
    assert.equal(result.stamped[0]!.id, 'dec_legacy');

    const userset = JSON.parse(fs.readFileSync(
      path.join(storePath, 'memory', 'decisions', 'dec_userset.json'),
      'utf-8',
    ));
    assert.deepEqual(userset.provenance, { kind: 'user', author: 'jberdah' });
  });

  it('preserves unknown fields when stamping provenance', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'trap', 'trp_extra', {
      id: 'trp_extra',
      text: 't',
      future_field: { keep: true, nested: [1, 2] },
    });

    rolloutProvenance({ storePath, now: fixedNow });

    const disk = JSON.parse(fs.readFileSync(
      path.join(storePath, 'memory', 'traps', 'trp_extra.json'),
      'utf-8',
    ));
    assert.deepEqual(disk.provenance, { kind: 'legacy' });
    assert.deepEqual(disk.future_field, { keep: true, nested: [1, 2] });
  });

  it('is idempotent — second run is a noop', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'constraint', 'cst_once', { id: 'cst_once', text: 'c' });

    const first = rolloutProvenance({ storePath, now: fixedNow });
    assert.equal(first.status, 'stamped');

    const second = rolloutProvenance({ storePath, now: fixedNow });
    assert.equal(second.status, 'noop');
    assert.equal(second.stamped.length, 0);
  });

  it('dry-run plans without rewriting files or writing a log', () => {
    const storePath = storePathOf(workspace);
    writeRecord(storePath, 'handoff', 'hdf_dry', { id: 'hdf_dry', text: 'h' });

    const result = rolloutProvenance({ storePath, now: fixedNow, dryRun: true });

    assert.equal(result.status, 'planned');
    assert.equal(result.stamped.length, 1);

    const disk = JSON.parse(fs.readFileSync(
      path.join(storePath, 'coordination', 'handoffs', 'hdf_dry.json'),
      'utf-8',
    ));
    assert.equal(disk.provenance, undefined);
    assert.equal(
      fs.existsSync(path.join(storePath, MIGRATIONS_ARCHIVE_SUBPATH, '2026-04-18', PROVENANCE_ROLLOUT_LOG)),
      false,
    );
  });
});
