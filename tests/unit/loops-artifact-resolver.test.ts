import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  canonicalArtifactPath, canonicalArtifactsDir, resolveContainedWorkerPath,
  copyArtifactToCanonicalStore, readCanonicalArtifact, ArtifactResolverError,
} from '../../src/core/loops/artifact-resolver.js';
import { memoryDir } from '../../src/core/io.js';

// pln#630 §7 — the single safe canonical artifact resolver. The load-bearing
// guarantee: a WORKER-CONTROLLED path can never escape the worker root, and a
// payload is hash-validated before it becomes canonical state.

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-artres-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

describe('artifact-resolver §7', () => {
  let cwd: string;
  beforeEach(() => { cwd = ws(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  describe('canonicalArtifactPath', () => {
    it('is deterministic + brainclaw-keyed + sanitizes the extension', () => {
      const p = canonicalArtifactPath('lop_x', 'art_1', 'json', cwd);
      assert.equal(p, canonicalArtifactPath('lop_x', 'art_1', 'json', cwd));
      assert.ok(p.startsWith(canonicalArtifactsDir('lop_x', cwd)));
      assert.ok(p.endsWith(`art_1.json`));
      // A malicious ext cannot inject a separator / traversal.
      const evil = canonicalArtifactPath('lop_x', 'art_1', '../../evil', cwd);
      assert.ok(!evil.includes('..'), 'ext traversal stripped');
      assert.ok(evil.endsWith('art_1.evil'));
    });
  });

  describe('resolveContainedWorkerPath (the traversal gate)', () => {
    it('accepts a real file contained in the worker root', () => {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'LANE-RESULT.json'), '{}');
      const resolved = resolveContainedWorkerPath(root, 'LANE-RESULT.json');
      assert.ok(resolved.endsWith('LANE-RESULT.json'));
    });
    it('REJECTS a ../ escape', () => {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(cwd, 'secret.txt'), 'top secret');
      assert.throws(() => resolveContainedWorkerPath(root, '../secret.txt'),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'containment_violation');
    });
    it('REJECTS an absolute worker path', () => {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      assert.throws(() => resolveContainedWorkerPath(root, path.join(cwd, 'secret.txt')),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'containment_violation');
    });
    it('REJECTS a symlink that points OUTSIDE the root (realpath re-check)', () => {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      const outside = path.join(cwd, 'outside.txt'); fs.writeFileSync(outside, 'escaped');
      const link = path.join(root, 'link.txt');
      try {
        fs.symlinkSync(outside, link);
      } catch {
        return; // symlink creation unsupported (Windows without privilege) — skip
      }
      assert.throws(() => resolveContainedWorkerPath(root, 'link.txt'),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'containment_violation');
    });
    it('reports source_missing for a contained-but-absent path', () => {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      assert.throws(() => resolveContainedWorkerPath(root, 'nope.json'),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'source_missing');
    });
  });

  describe('copyArtifactToCanonicalStore (atomic + validated + idempotent)', () => {
    function src(content: string): string {
      const root = path.join(cwd, 'wt'); fs.mkdirSync(root, { recursive: true });
      const p = path.join(root, 'out.json'); fs.writeFileSync(p, content);
      return p;
    }
    it('copies, hashes, and reports non-idempotent on first write', () => {
      const sourceAbsPath = src('{"verdict":"approve"}');
      const r = copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_1', ext: 'json', sourceAbsPath, cwd });
      assert.equal(r.idempotent, false);
      assert.equal(r.sha256, sha('{"verdict":"approve"}'));
      assert.ok(fs.existsSync(r.canonicalPath));
      assert.equal(fs.readFileSync(r.canonicalPath, 'utf8'), '{"verdict":"approve"}');
    });
    it('is idempotent: a second copy of identical bytes is a no-op', () => {
      const sourceAbsPath = src('same');
      copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_1', ext: 'txt', sourceAbsPath, cwd });
      const r2 = copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_1', ext: 'txt', sourceAbsPath, cwd });
      assert.equal(r2.idempotent, true);
    });
    it('rejects a canonical hash CONFLICT (same id, different bytes) — never overwrites', () => {
      copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_1', ext: 'txt', sourceAbsPath: src('v1'), cwd });
      const other = path.join(cwd, 'wt', 'out2.txt'); fs.writeFileSync(other, 'v2-DIFFERENT');
      assert.throws(() => copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_1', ext: 'txt', sourceAbsPath: other, cwd }),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'canonical_hash_conflict');
    });
    it('validates expectedSha256 BEFORE writing (no partial commit on mismatch)', () => {
      const sourceAbsPath = src('payload');
      assert.throws(() => copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_bad', ext: 'txt', sourceAbsPath, expectedSha256: 'f'.repeat(64), cwd }),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'sha256_mismatch');
      assert.ok(!fs.existsSync(canonicalArtifactPath('lop_a', 'art_bad', 'txt', cwd)), 'nothing written on hash mismatch');
    });
    it('validates expectedByteCount', () => {
      const sourceAbsPath = src('1234567');
      assert.throws(() => copyArtifactToCanonicalStore({ loopId: 'lop_a', artifactId: 'art_bc', ext: 'txt', sourceAbsPath, expectedByteCount: 999, cwd }),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'byte_count_mismatch');
    });
  });

  describe('readCanonicalArtifact (new-then-legacy migration)', () => {
    it('reads the canonical copy', () => {
      const p = canonicalArtifactPath('lop_r', 'art_1', 'txt', cwd);
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'canon');
      assert.equal(readCanonicalArtifact('lop_r', 'art_1', 'txt', { cwd }).toString(), 'canon');
    });
    it('falls back to the legacy ref path when only legacy exists', () => {
      const legacyDir = path.join(memoryDir(cwd), 'loops', 'threads', 'lop_r', 'artifacts');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'old.txt'), 'legacy-body');
      assert.equal(readCanonicalArtifact('lop_r', 'art_1', 'txt', { legacyRef: 'old.txt', cwd }).toString(), 'legacy-body');
    });
    it('rejects a canonical/legacy hash mismatch (migration safety)', () => {
      const p = canonicalArtifactPath('lop_r', 'art_1', 'txt', cwd);
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'canon');
      const legacyDir = path.join(memoryDir(cwd), 'loops', 'threads', 'lop_r', 'artifacts');
      fs.mkdirSync(legacyDir, { recursive: true }); fs.writeFileSync(path.join(legacyDir, 'old.txt'), 'DIVERGENT');
      assert.throws(() => readCanonicalArtifact('lop_r', 'art_1', 'txt', { legacyRef: 'old.txt', cwd }),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'canonical_hash_conflict');
    });
    it('throws artifact_missing when neither exists', () => {
      assert.throws(() => readCanonicalArtifact('lop_r', 'art_none', 'txt', { cwd }),
        (e: unknown) => e instanceof ArtifactResolverError && e.code === 'artifact_missing');
    });
  });
});
