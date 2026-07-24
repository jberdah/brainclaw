import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir } from '../io.js';

/**
 * Safe canonical artifact resolver (pln#630 §7).
 *
 * The single central resolver every loop-artifact reader/writer must use. It
 * replaces the ad-hoc `path.join(dir, body.ref)` (hooks/bootstrap-write.ts) that
 * joined a WORKER-CONTROLLED `ref` straight onto a store dir — a path-traversal
 * hole (`ref: "../../../etc/passwd"` escaped the artifacts dir).
 *
 * The safety protocol, mandatory before any state mutation (§7):
 *   1. Brainclaw-generated target basenames — `<artifact_id>.<ext>`, never a
 *      worker-supplied name.
 *   2. Worker source paths validated by `realpath` CONTAINMENT (reject `../`
 *      escapes and symlink-out) before any read.
 *   3. Atomic temp-copy + fsync + rename into the canonical store.
 *   4. size + sha256 validation against the attempt's expected_artifacts.
 *   5. Deterministic (artifact_id-keyed) target + hash check = per-turn
 *      idempotency: a crash between copy and the artifact/event write retries
 *      without duplicating (re-copy of an identical payload is a no-op).
 *
 * Canonical home (unifies the two conflicting doc paths §7):
 *   .brainclaw/loops/artifacts/<lop_id>/<artifact_id>.<ext>
 * Migration is new-then-legacy on READ, reject-on-hash-mismatch; writes go to the
 * new path only.
 */

export class ArtifactResolverError extends Error {
  constructor(
    public readonly code:
      | 'containment_violation'
      | 'source_missing'
      | 'sha256_mismatch'
      | 'byte_count_mismatch'
      | 'canonical_hash_conflict'
      | 'artifact_missing',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactResolverError';
  }
}

/** Legacy on-disk home for ref-based payloads (pre-§7). Read fallback only. */
function legacyArtifactsDir(loopId: string, cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops', 'threads', loopId, 'artifacts');
}

/** Canonical home for a loop's artifact payloads (§7). */
export function canonicalArtifactsDir(loopId: string, cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops', 'artifacts', loopId);
}

/**
 * The canonical absolute path for a brainclaw-owned artifact payload. The
 * basename is derived ENTIRELY from brainclaw-generated ids (never a worker
 * string), so it cannot traverse. `ext` is sanitized to a bare alnum extension.
 */
export function canonicalArtifactPath(loopId: string, artifactId: string, ext: string, cwd?: string): string {
  const safeExt = ext.replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '') || 'txt';
  return path.join(canonicalArtifactsDir(loopId, cwd), `${artifactId}.${safeExt}`);
}

/**
 * Validate that a worker-relative path resolves to a real file CONTAINED within
 * `workerRoot` (no `../` escape, no symlink pointing outside). Returns the
 * validated absolute path; throws `containment_violation` / `source_missing`
 * otherwise. This is the mandatory gate before ANY read of a worker-produced
 * artifact (§7 / invariant #7).
 */
export function resolveContainedWorkerPath(workerRoot: string, workerRelPath: string, _cwd?: string): string {
  // realpath the containment ROOT first (it must exist and be a directory).
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(workerRoot);
  } catch {
    throw new ArtifactResolverError('source_missing', `resolveContainedWorkerPath: worker root ${workerRoot} does not resolve`);
  }
  // Reject an absolute worker path outright — an expected artifact is always
  // worker-RELATIVE; an absolute path is a red flag we never join.
  if (path.isAbsolute(workerRelPath)) {
    throw new ArtifactResolverError('containment_violation', `resolveContainedWorkerPath: absolute worker path "${workerRelPath}" rejected`);
  }
  const joined = path.resolve(rootReal, workerRelPath);
  // Lexical containment check on the joined path BEFORE touching the FS (guards
  // the case where the target itself does not exist yet).
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (joined !== rootReal && !joined.startsWith(rootWithSep)) {
    throw new ArtifactResolverError('containment_violation', `resolveContainedWorkerPath: "${workerRelPath}" escapes worker root`);
  }
  // realpath the target and re-check containment — defeats a symlink inside the
  // root that points outside it (lexical check alone would pass).
  let targetReal: string;
  try {
    targetReal = fs.realpathSync(joined);
  } catch {
    throw new ArtifactResolverError('source_missing', `resolveContainedWorkerPath: "${workerRelPath}" does not resolve to a file under the worker root`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootWithSep)) {
    throw new ArtifactResolverError('containment_violation', `resolveContainedWorkerPath: "${workerRelPath}" resolves (via symlink) outside the worker root`);
  }
  return targetReal;
}

function sha256OfFile(absPath: string): { sha256: string; byte_count: number } {
  const buf = fs.readFileSync(absPath);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), byte_count: buf.length };
}

export interface CopyArtifactInput {
  loopId: string;
  artifactId: string;
  ext: string;
  /** Absolute, already containment-validated source path (from resolveContainedWorkerPath). */
  sourceAbsPath: string;
  /** Expected hash from the attempt's expected_artifacts — validated before commit. */
  expectedSha256?: string;
  /** Expected byte count — validated before commit. */
  expectedByteCount?: number;
  cwd?: string;
}

export interface CopyArtifactResult {
  canonicalPath: string;
  sha256: string;
  byte_count: number;
  /** True when the canonical target already existed with a matching hash (no-op re-copy). */
  idempotent: boolean;
}

/**
 * Copy a containment-validated worker source into the canonical store — atomically
 * (temp + fsync + rename), with size/sha256 validation and per-turn idempotency
 * (§7). Idempotent: if the deterministic target already holds the same bytes, this
 * is a no-op; if it holds DIFFERENT bytes, that is a hard `canonical_hash_conflict`
 * (a deterministic-id collision or corruption — never silently overwrite).
 */
export function copyArtifactToCanonicalStore(input: CopyArtifactInput): CopyArtifactResult {
  const { loopId, artifactId, ext, sourceAbsPath, expectedSha256, expectedByteCount, cwd } = input;
  if (!fs.existsSync(sourceAbsPath)) {
    throw new ArtifactResolverError('source_missing', `copyArtifactToCanonicalStore: source ${sourceAbsPath} missing`);
  }
  const { sha256, byte_count } = sha256OfFile(sourceAbsPath);
  // Validate against the attempt's declared expectations BEFORE any write.
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
    throw new ArtifactResolverError('sha256_mismatch', `copyArtifactToCanonicalStore: sha256 ${sha256} != expected ${expectedSha256}`);
  }
  if (expectedByteCount !== undefined && expectedByteCount !== byte_count) {
    throw new ArtifactResolverError('byte_count_mismatch', `copyArtifactToCanonicalStore: byte_count ${byte_count} != expected ${expectedByteCount}`);
  }

  const canonicalPath = canonicalArtifactPath(loopId, artifactId, ext, cwd);
  // Idempotency: a matching target is a no-op; a mismatching target is a conflict.
  if (fs.existsSync(canonicalPath)) {
    const existing = sha256OfFile(canonicalPath);
    if (existing.sha256 === sha256) {
      return { canonicalPath, sha256, byte_count, idempotent: true };
    }
    throw new ArtifactResolverError(
      'canonical_hash_conflict',
      `copyArtifactToCanonicalStore: ${canonicalPath} already exists with a DIFFERENT hash (${existing.sha256} vs ${sha256}) — refusing to overwrite`,
    );
  }

  const dir = path.dirname(canonicalPath);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic temp-copy + fsync + rename. The temp name is process/id-scoped so
  // concurrent copies of distinct artifacts never collide on the temp file.
  const tmpPath = path.join(dir, `.${artifactId}.${process.pid}.tmp`);
  const buf = fs.readFileSync(sourceAbsPath);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, canonicalPath);
  } catch (err) {
    // A racing writer may have created the target between our existence check and
    // the rename. Re-check idempotency rather than clobbering.
    fs.rmSync(tmpPath, { force: true });
    if (fs.existsSync(canonicalPath) && sha256OfFile(canonicalPath).sha256 === sha256) {
      return { canonicalPath, sha256, byte_count, idempotent: true };
    }
    throw err;
  }
  return { canonicalPath, sha256, byte_count, idempotent: false };
}

/**
 * Read an artifact payload from the canonical store, falling back to the legacy
 * `loops/threads/<loop_id>/artifacts/<ref>` path for pre-§7 artifacts. When BOTH
 * exist, their hashes MUST match (reject-on-mismatch migration safety §7). An
 * `expectedSha256` is validated against whichever copy is returned.
 */
export function readCanonicalArtifact(
  loopId: string,
  artifactId: string,
  ext: string,
  opts: { legacyRef?: string; expectedSha256?: string; cwd?: string } = {},
): Buffer {
  const { legacyRef, expectedSha256, cwd } = opts;
  const canonicalPath = canonicalArtifactPath(loopId, artifactId, ext, cwd);
  const legacyPath = legacyRef ? path.join(legacyArtifactsDir(loopId, cwd), legacyRef) : undefined;

  const canonicalExists = fs.existsSync(canonicalPath);
  const legacyExists = legacyPath !== undefined && fs.existsSync(legacyPath);

  if (!canonicalExists && !legacyExists) {
    throw new ArtifactResolverError('artifact_missing', `readCanonicalArtifact: ${artifactId} not found (canonical nor legacy)`);
  }
  if (canonicalExists && legacyExists) {
    // Migration overlap — both must agree, else refuse (never trust a divergent legacy copy).
    const c = sha256OfFile(canonicalPath);
    const l = sha256OfFile(legacyPath!);
    if (c.sha256 !== l.sha256) {
      throw new ArtifactResolverError('canonical_hash_conflict', `readCanonicalArtifact: ${artifactId} canonical/legacy hash mismatch (${c.sha256} vs ${l.sha256})`);
    }
  }
  const readPath = canonicalExists ? canonicalPath : legacyPath!;
  const buf = fs.readFileSync(readPath);
  if (expectedSha256 !== undefined) {
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== expectedSha256) {
      throw new ArtifactResolverError('sha256_mismatch', `readCanonicalArtifact: ${artifactId} sha256 ${actual} != expected ${expectedSha256}`);
    }
  }
  return buf;
}
