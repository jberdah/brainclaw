/**
 * pln#619 — store-snapshot tool: the snapshot-before-curation safety net.
 *
 * The acceptance criterion is executed literally: a restored store must
 * reproduce the manifest's metrics (file/byte totals, corpus hash, entity
 * counts). And the fixtures exporter must NEVER leak free text — the store
 * carries private coordination content and fixtures land in a public repo.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Walk up to the repo root: the compiled test runs from dist-test/tests/unit,
// the source layout from tests/unit — a fixed depth breaks one of the two.
const SCRIPT = (() => {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'scripts', 'store-snapshot.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`store-snapshot.mjs not found walking up from ${import.meta.dirname}`);
})();

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('store-snapshot (pln#619)', { concurrency: false }, () => {
  let root: string;
  let store: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-snap-'));
    store = path.join(root, '.brainclaw');
    // A miniature store with the shapes the manifest counts.
    fs.mkdirSync(path.join(store, 'coordination', 'claims'), { recursive: true });
    fs.mkdirSync(path.join(store, 'coordination', 'assignments'), { recursive: true });
    fs.mkdirSync(path.join(store, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(store, 'coordination', 'claims', 'clm_a.json'), JSON.stringify({
      schema_version: 2, id: 'clm_a', agent: 'codex', scope: 'src/x', status: 'active',
      description: 'a long private description that must never appear in fixtures output',
    }));
    fs.writeFileSync(path.join(store, 'coordination', 'assignments', 'asgn_a.json'), JSON.stringify({
      schema_version: 2, id: 'asgn_a', agent: 'codex', status: 'completed',
    }));
    fs.writeFileSync(path.join(store, 'memory', 'state.json'), JSON.stringify({
      version: 1, active_constraints: [{}], recent_decisions: [{}, {}], known_traps: [],
      open_handoffs: [], plan_items: [{}, {}, {}],
    }));
  });

  afterEach(() => {
    // Snapshot files are read-only; clear attributes before rm.
    for (const dirent of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (dirent.isFile()) {
        try { fs.chmodSync(path.join(dirent.parentPath ?? (dirent as unknown as { path: string }).path, dirent.name), 0o644); } catch { /* best-effort */ }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('create → verify: the manifest carries totals, entity counts and a corpus hash', () => {
    const out = path.join(root, 'snap');
    const created = run(['create', '--store', store, '--out', out]);
    assert.equal(created.status, 0, created.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.totals.files, 3);
    assert.equal(manifest.entity_counts.claims, 1);
    assert.equal(manifest.entity_counts.assignments, 1);
    assert.equal(manifest.entity_counts.plans, 3);
    assert.equal(manifest.entity_counts.decisions, 2);
    assert.match(manifest.corpus_hash, /^[a-f0-9]{64}$/);
    assert.match(manifest.rule, /SNAPSHOT BEFORE CURATION/);

    const verified = run(['verify', '--snapshot', out]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /OK verify/);
  });

  it('verify FAILS when the snapshot is tampered with — immutability is checked, not assumed', () => {
    const out = path.join(root, 'snap');
    assert.equal(run(['create', '--store', store, '--out', out]).status, 0);
    const victim = path.join(out, 'store', 'coordination', 'claims', 'clm_a.json');
    fs.chmodSync(victim, 0o644);
    fs.writeFileSync(victim, JSON.stringify({ tampered: true }));
    const verified = run(['verify', '--snapshot', out]);
    assert.equal(verified.status, 1, 'tampering must fail verification');
    assert.match(verified.stderr, /corpus_hash mismatch|byte total/);
  });

  it('restore to an ISOLATED empty target reproduces the metrics (the pln#619 acceptance criterion)', () => {
    const out = path.join(root, 'snap');
    assert.equal(run(['create', '--store', store, '--out', out]).status, 0);
    const target = path.join(root, 'restored');
    const restored = run(['restore', '--snapshot', out, '--to', target]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /OK restore .*hash \+ entity counts match/);
    assert.ok(fs.existsSync(path.join(target, 'coordination', 'claims', 'clm_a.json')));
  });

  it('restore REFUSES a non-empty target — never an in-place overwrite', () => {
    const out = path.join(root, 'snap');
    assert.equal(run(['create', '--store', store, '--out', out]).status, 0);
    const target = path.join(root, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'existing.txt'), 'x');
    const restored = run(['restore', '--snapshot', out, '--to', target]);
    assert.equal(restored.status, 1);
    assert.match(restored.stderr, /not empty/);
  });

  it('fixtures export SHAPES only — free text and identity values never leak', () => {
    // The identity redaction was added after the FIRST real export leaked the
    // machine hostname and OS username into would-be public fixtures: both
    // are short enough to pass the length gate, so field NAMES gate them.
    fs.writeFileSync(path.join(store, 'coordination', 'claims', 'clm_b.json'), JSON.stringify({
      schema_version: 2, id: 'clm_b', agent: 'codex', scope: 'src/y', status: 'released',
      host_id: 'mymachine01', user: 'realuser',
    }));
    const out = path.join(root, 'shapes');
    const r = run(['fixtures', '--store', store, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const claimShape = JSON.parse(fs.readFileSync(path.join(out, 'claim.shape.json'), 'utf-8'));
    assert.deepEqual(claimShape.fields.description.types, ['string']);
    const serialized = fs.readFileSync(path.join(out, 'claim.shape.json'), 'utf-8');
    assert.doesNotMatch(serialized, /long private description/, 'free text must never reach fixtures');
    assert.doesNotMatch(serialized, /mymachine01|realuser/, 'identity field VALUES must never reach fixtures');
    assert.deepEqual(claimShape.fields.host_id.types, ['string'], 'identity fields keep type/presence');
    assert.ok(claimShape.fields.status.observed_short_values.includes('active'), 'short enum-ish values ARE kept');
  });
});
