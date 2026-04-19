import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runUpgrade } from '../../src/commands/upgrade.js';
import {
  BACKUP_DIR_PREFIX,
  listBackups,
} from '../../src/core/upgrades/backup.js';
import {
  V1_TARGET_SCHEMA_VERSION,
  readSchemaVersion,
} from '../../src/core/upgrades/schema-version.js';
import { runPostMigrationHealthCheck } from '../../src/core/upgrades/health-check.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * End-to-end migration suite covering `brainclaw upgrade --to=1.0` on a
 * fixture store that touches every patch: pending candidates, handoffs with
 * review blocks, mixed-author decisions, runtime notes in nested agent dirs.
 */

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function writeJson(file: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
}

function seedFixtureStore(storePath: string): {
  decisions: string[];
  constraints: string[];
  traps: string[];
  handoffsWithReview: string[];
  handoffsClean: string[];
  runtimeNotes: string[];
  pendingCandidates: string[];
  acceptedCandidates: string[];
} {
  // Memory records — mix of authors + plain records (no provenance yet).
  writeJson(path.join(storePath, 'memory/decisions/dec_001.json'), {
    id: 'dec_001', text: 'chose typescript', author: 'jberdah',
    created_at: '2026-04-10T08:00:00.000Z', tags: [],
  });
  writeJson(path.join(storePath, 'memory/decisions/dec_002.json'), {
    id: 'dec_002', text: 'auto-captured migration note', author: 'auto-reflect',
    created_at: '2026-04-10T09:00:00.000Z', tags: [],
  });
  writeJson(path.join(storePath, 'memory/constraints/cst_001.json'), {
    id: 'cst_001', text: 'minimize deps', author: 'jberdah', status: 'active',
    created_at: '2026-04-11T08:00:00.000Z', tags: [],
  });
  writeJson(path.join(storePath, 'memory/traps/trp_001.json'), {
    id: 'trp_001', text: 'git merge wipes node_modules', severity: 'high',
    author: 'jberdah', status: 'active',
    created_at: '2026-04-12T08:00:00.000Z', tags: [],
  });

  // Handoffs — one with review, one without.
  writeJson(path.join(storePath, 'coordination/handoffs/hdf_001.json'), {
    id: 'hdf_001', from: 'claude-code', to: 'codex', text: 'session x',
    author: 'claude-code', status: 'open', tags: [],
    created_at: '2026-04-14T10:00:00.000Z',
    review: { requester: 'claude-code', reviewer: 'codex', verdict: 'approved' },
  });
  writeJson(path.join(storePath, 'coordination/handoffs/hdf_002.json'), {
    id: 'hdf_002', from: 'codex', to: 'claude-code', text: 'session y',
    author: 'codex', status: 'open', tags: [],
    created_at: '2026-04-15T10:00:00.000Z',
  });

  // Runtime notes — one per agent subdir.
  writeJson(path.join(storePath, 'coordination/runtime/claude-code/rtn_001.json'), {
    id: 'rtn_001', agent: 'claude-code', text: 'observation a',
    created_at: '2026-04-16T10:00:00.000Z', tags: [],
  });
  writeJson(path.join(storePath, 'coordination/runtime/codex/rtn_002.json'), {
    id: 'rtn_002', agent: 'codex', text: 'observation b',
    created_at: '2026-04-16T11:00:00.000Z', tags: [],
  });

  // Pending candidates at inbox root.
  writeJson(path.join(storePath, 'coordination/inbox/cnd_001.json'), {
    id: 'cnd_001', short_label: 'cnd#1', type: 'decision', text: 'candidate 1',
    author: 'auto-reflect', status: 'pending', tags: [],
    created_at: '2026-04-17T09:00:00.000Z',
  });
  writeJson(path.join(storePath, 'coordination/inbox/cnd_002.json'), {
    id: 'cnd_002', short_label: 'cnd#2', type: 'trap', text: 'candidate 2',
    author: 'jberdah', status: 'pending', tags: [],
    created_at: '2026-04-17T10:00:00.000Z',
  });
  // Already-accepted candidate in its own subdir — must NOT be archived.
  writeJson(path.join(storePath, 'coordination/inbox/accepted/cnd_100.json'), {
    id: 'cnd_100', short_label: 'cnd#100', type: 'decision', text: 'accepted',
    author: 'jberdah', status: 'accepted', tags: [],
    created_at: '2026-04-17T08:00:00.000Z',
  });

  return {
    decisions: ['dec_001', 'dec_002'],
    constraints: ['cst_001'],
    traps: ['trp_001'],
    handoffsWithReview: ['hdf_001'],
    handoffsClean: ['hdf_002'],
    runtimeNotes: ['rtn_001', 'rtn_002'],
    pendingCandidates: ['cnd_001', 'cnd_002'],
    acceptedCandidates: ['cnd_100'],
  };
}

function captureLogs(fn: () => void): { logs: string[]; errors: string[]; exitCode?: number } {
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`__process_exit_${code ?? 0}__`);
  }) as typeof process.exit;
  try {
    fn();
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith('__process_exit_')) throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errors, exitCode };
}

describe('upgrade --to=1.0 (end-to-end on fixture store)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-upgrade-e2e-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('migrates a fully-loaded fixture store and passes the health check', () => {
    const storePath = storePathOf(workspace);
    seedFixtureStore(storePath);

    const { errors, exitCode } = captureLogs(() => runUpgrade({ cwd: workspace.dir, to: '1.0' }));
    assert.equal(exitCode, undefined, `runUpgrade should not exit: ${errors.join('\n')}`);

    // Candidate archive: pending items moved to archive/candidates/<date>/
    assert.equal(fs.existsSync(path.join(storePath, 'coordination/inbox/cnd_001.json')), false);
    assert.equal(fs.existsSync(path.join(storePath, 'coordination/inbox/cnd_002.json')), false);
    const archiveEntries = fs.readdirSync(path.join(storePath, 'archive/candidates'));
    assert.ok(archiveEntries.length >= 1, 'archive dir should exist');
    // Accepted candidate untouched
    assert.ok(fs.existsSync(path.join(storePath, 'coordination/inbox/accepted/cnd_100.json')));

    // Handoff review-strip
    const hdf001 = JSON.parse(fs.readFileSync(path.join(storePath, 'coordination/handoffs/hdf_001.json'), 'utf-8'));
    assert.equal(hdf001.review, undefined);
    assert.equal(hdf001.id, 'hdf_001');

    // Provenance rollout: every memory record stamped legacy
    const dec001 = JSON.parse(fs.readFileSync(path.join(storePath, 'memory/decisions/dec_001.json'), 'utf-8'));
    const cst001 = JSON.parse(fs.readFileSync(path.join(storePath, 'memory/constraints/cst_001.json'), 'utf-8'));
    const trp001 = JSON.parse(fs.readFileSync(path.join(storePath, 'memory/traps/trp_001.json'), 'utf-8'));
    const rtn001 = JSON.parse(fs.readFileSync(path.join(storePath, 'coordination/runtime/claude-code/rtn_001.json'), 'utf-8'));
    const rtn002 = JSON.parse(fs.readFileSync(path.join(storePath, 'coordination/runtime/codex/rtn_002.json'), 'utf-8'));
    for (const record of [dec001, cst001, trp001, rtn001, rtn002]) {
      assert.deepEqual(record.provenance, { kind: 'legacy' });
    }

    // Schema version marker
    const schema = readSchemaVersion(storePath);
    assert.equal(schema.present, true);
    assert.equal(schema.current, V1_TARGET_SCHEMA_VERSION);
    assert.equal(schema.history.length, 1);

    // Backup created with store_schema_version
    const backups = listBackups(storePath);
    assert.equal(backups.length, 1);
    assert.ok(backups[0]!.backupPath.includes(BACKUP_DIR_PREFIX));

    // Health check must pass on the migrated store
    const health = runPostMigrationHealthCheck({ storePath });
    assert.equal(health.ok, true);
  });

  it('is idempotent — second --to=1.0 run is a full noop', () => {
    const storePath = storePathOf(workspace);
    seedFixtureStore(storePath);

    captureLogs(() => runUpgrade({ cwd: workspace.dir, to: '1.0' }));
    const firstBackups = listBackups(storePath);

    captureLogs(() => runUpgrade({ cwd: workspace.dir, to: '1.0' }));
    const secondBackups = listBackups(storePath);

    // Schema version unchanged, history still length 1
    const schema = readSchemaVersion(storePath);
    assert.equal(schema.current, V1_TARGET_SCHEMA_VERSION);
    assert.equal(schema.history.length, 1);

    // Second run still creates a defensive backup (upgrade always backs up),
    // but patches themselves are noops.
    assert.ok(secondBackups.length >= firstBackups.length);

    // Health remains green
    const health = runPostMigrationHealthCheck({ storePath });
    assert.equal(health.ok, true);
  });

  it('refuses --to=1.0 --no-backup on a real run', () => {
    const storePath = storePathOf(workspace);
    seedFixtureStore(storePath);

    const { errors, exitCode } = captureLogs(() =>
      runUpgrade({ cwd: workspace.dir, to: '1.0', backup: false })
    );

    assert.equal(exitCode, 1);
    assert.ok(errors.some((line) => /requires a backup/.test(line)));

    // Store untouched — candidate still pending
    assert.ok(fs.existsSync(path.join(storePath, 'coordination/inbox/cnd_001.json')));
    assert.equal(readSchemaVersion(storePath).present, false);
  });

  it('dry-run --to=1.0 does not modify the store', () => {
    const storePath = storePathOf(workspace);
    seedFixtureStore(storePath);

    const beforeInbox = fs.readdirSync(path.join(storePath, 'coordination/inbox'))
      .filter((n) => n.endsWith('.json')).sort();
    const beforeSchema = readSchemaVersion(storePath);

    captureLogs(() => runUpgrade({ cwd: workspace.dir, to: '1.0', dryRun: true }));

    const afterInbox = fs.readdirSync(path.join(storePath, 'coordination/inbox'))
      .filter((n) => n.endsWith('.json')).sort();
    const afterSchema = readSchemaVersion(storePath);

    assert.deepEqual(afterInbox, beforeInbox);
    assert.equal(beforeSchema.present, afterSchema.present);
    assert.equal(listBackups(storePath).length, 0);
  });

  it('round-trip: upgrade, then --rollback restores the original store', () => {
    const storePath = storePathOf(workspace);
    seedFixtureStore(storePath);

    // Snapshot pre-upgrade content.
    const beforeCandidate = fs.readFileSync(
      path.join(storePath, 'coordination/inbox/cnd_001.json'), 'utf-8',
    );
    const beforeHandoff = JSON.parse(fs.readFileSync(
      path.join(storePath, 'coordination/handoffs/hdf_001.json'), 'utf-8',
    ));

    captureLogs(() => runUpgrade({ cwd: workspace.dir, to: '1.0' }));
    assert.equal(readSchemaVersion(storePath).current, V1_TARGET_SCHEMA_VERSION);

    captureLogs(() => runUpgrade({ cwd: workspace.dir, rollback: true }));

    // Candidate is back at inbox root.
    assert.ok(fs.existsSync(path.join(storePath, 'coordination/inbox/cnd_001.json')));
    assert.equal(
      fs.readFileSync(path.join(storePath, 'coordination/inbox/cnd_001.json'), 'utf-8'),
      beforeCandidate,
    );

    // Handoff still carries its review block.
    const restored = JSON.parse(fs.readFileSync(
      path.join(storePath, 'coordination/handoffs/hdf_001.json'), 'utf-8',
    ));
    assert.deepEqual(restored.review, beforeHandoff.review);

    // Schema marker is gone again (store back to pre-migration state).
    assert.equal(readSchemaVersion(storePath).present, false);
  });
});
