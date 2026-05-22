import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  writeProjectMdSafe,
  type LoopArtifact,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#512 step 1 — writeProjectMdSafe IMPL tests.
 *
 * The hook is the IMPL only — wiring into closeLoop + the
 * file_overwrite_approval request_input flow is step 2. These tests pin the
 * function's three branches (absent / empty / present_non_empty), the
 * no_final_artifact short-circuit, and atomicity for the write paths.
 */

const FINAL_BODY = '# PROJECT\n\nGenerated from the bootstrap loop.\n';

interface Fixture {
  cwd: string;
  loop: LoopThread;
  refPath: string;
}

function setupFixture(opts: { withFinal: boolean; finalContent?: string } = { withFinal: true }): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bootstrap-write-test-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });

  const loopId = `lop_${crypto.randomBytes(6).toString('hex')}`;
  const finalArtifactId = `art_${crypto.randomBytes(6).toString('hex')}`;
  const ref = `${finalArtifactId}.md`;
  const artifactsDir = path.join(cwd, '.brainclaw', 'loops', 'threads', loopId, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const refPath = path.join(artifactsDir, ref);

  const finalContent = opts.finalContent ?? FINAL_BODY;
  fs.writeFileSync(refPath, finalContent, 'utf8');

  const sha = crypto.createHash('sha256').update(finalContent, 'utf8').digest('hex');
  const body = {
    ref,
    byte_count: Buffer.byteLength(finalContent, 'utf8'),
    sha256: sha,
  };

  const artifacts: LoopArtifact[] = opts.withFinal
    ? [
        {
          artifact_id: finalArtifactId,
          phase: 'converge',
          type: 'project_md_final',
          body: JSON.stringify(body),
          produced_at: '2026-05-22T00:00:00.000Z',
        },
      ]
    : [];

  const loop: LoopThread = {
    schema_version: 1,
    id: loopId,
    version: 1,
    mutation_id: 'mut_test',
    kind: 'ideation',
    title: 'bootstrap test loop',
    status: 'open',
    phases: [{ name: 'converge' }],
    current_phase: 'converge',
    iteration_count: 0,
    slots: [],
    artifacts,
    open_questions: [],
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    created_by: 'agt_test',
  };

  return { cwd, loop, refPath };
}

describe('writeProjectMdSafe (pln#512 step 1)', () => {
  let fixtures: Fixture[] = [];

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  function make(opts?: { withFinal?: boolean; finalContent?: string }): Fixture {
    const f = setupFixture({ withFinal: opts?.withFinal ?? true, finalContent: opts?.finalContent });
    fixtures.push(f);
    return f;
  }

  it('returns reason=no_final_artifact when no project_md_final exists', () => {
    const f = make({ withFinal: false });
    const result = writeProjectMdSafe(f.loop, f.cwd);
    assert.equal(result.needs_approval, false);
    assert.equal(result.written, false);
    assert.equal(result.reason, 'no_final_artifact');
    assert.equal(result.target_path, path.join(f.cwd, 'PROJECT.md'));
    assert.equal(result.diff_artifact, undefined);
    assert.equal(fs.existsSync(result.target_path), false, 'must not create the file');
  });

  it('writes atomically when PROJECT.md is absent', () => {
    const f = make();
    const result = writeProjectMdSafe(f.loop, f.cwd);
    assert.equal(result.needs_approval, false);
    assert.equal(result.written, true);
    assert.equal(result.reason, 'absent');
    assert.equal(result.target_path, path.join(f.cwd, 'PROJECT.md'));
    assert.equal(result.diff_artifact, undefined);
    const wrote = fs.readFileSync(result.target_path, 'utf8');
    assert.equal(wrote, FINAL_BODY, 'written content must match the artifact body byte-for-byte');
  });

  it('writes atomically when PROJECT.md exists but is 0 bytes', () => {
    const f = make();
    const target = path.join(f.cwd, 'PROJECT.md');
    fs.writeFileSync(target, '', 'utf8');
    assert.equal(fs.statSync(target).size, 0);

    const result = writeProjectMdSafe(f.loop, f.cwd);
    assert.equal(result.needs_approval, false);
    assert.equal(result.written, true);
    assert.equal(result.reason, 'empty');
    assert.equal(fs.readFileSync(target, 'utf8'), FINAL_BODY);
  });

  it('returns a file_diff artifact (needs_approval=true) when PROJECT.md is present + byte-identical', () => {
    // Conservative v1: even byte-identical content goes through approval —
    // the hook does not short-circuit on equality; the operator inspects the
    // (empty-bodied) diff and decides.
    const f = make({ finalContent: FINAL_BODY });
    const target = path.join(f.cwd, 'PROJECT.md');
    fs.writeFileSync(target, FINAL_BODY, 'utf8');
    const beforeMtime = fs.statSync(target).mtimeMs;

    const result = writeProjectMdSafe(f.loop, f.cwd);
    assert.equal(result.needs_approval, true);
    assert.equal(result.reason, 'present_non_empty');
    assert.equal(result.written, undefined);
    assert.ok(result.diff_artifact, 'diff_artifact must be present');
    assert.equal(result.diff_artifact.type, 'file_diff');
    assert.equal(result.diff_artifact.phase, 'converge');
    assert.match(result.diff_artifact.artifact_id, /^art_[0-9a-f]+$/);
    // PROJECT.md must NOT have been touched.
    assert.equal(fs.readFileSync(target, 'utf8'), FINAL_BODY);
    assert.equal(fs.statSync(target).mtimeMs, beforeMtime, 'target_path must not be re-written');
  });

  it('writes a .patch ref file and produces a sha256-validated body when content differs', () => {
    const f = make({ finalContent: '# proposed final\n\nDifferent from existing.\n' });
    const target = path.join(f.cwd, 'PROJECT.md');
    fs.writeFileSync(target, '# existing\n\nOld content.\n', 'utf8');

    const result = writeProjectMdSafe(f.loop, f.cwd);
    assert.equal(result.needs_approval, true);
    assert.equal(result.reason, 'present_non_empty');
    assert.ok(result.diff_artifact);

    // Body validates as a ref-based artifact body.
    const body = JSON.parse(result.diff_artifact.body!) as { ref: string; byte_count: number; sha256: string };
    assert.match(body.ref, /^art_[0-9a-f]+\.patch$/);
    assert.ok(body.byte_count > 0);
    assert.match(body.sha256, /^[0-9a-f]{64}$/);

    // The .patch file must exist on disk under the loop's artifacts dir.
    const patchPath = path.join(f.cwd, '.brainclaw', 'loops', 'threads', f.loop.id, 'artifacts', body.ref);
    assert.ok(fs.existsSync(patchPath), 'patch file must exist on disk');

    // sha256 + byte_count must match what's actually on disk.
    const patchContent = fs.readFileSync(patchPath, 'utf8');
    assert.equal(Buffer.byteLength(patchContent, 'utf8'), body.byte_count);
    const sha = crypto.createHash('sha256').update(patchContent, 'utf8').digest('hex');
    assert.equal(sha, body.sha256);

    // Diff body should reference both the old and the proposed content.
    assert.match(patchContent, /^--- PROJECT\.md\n\+\+\+ PROJECT\.md \(proposed\)\n@@ /);
    assert.match(patchContent, /-# existing/);
    assert.match(patchContent, /\+# proposed final/);

    // Target file is unchanged.
    assert.equal(fs.readFileSync(target, 'utf8'), '# existing\n\nOld content.\n');
  });

  it('atomicity smoke: written content equals body exactly, no tmp leftovers in cwd', () => {
    const f = make({ finalContent: 'line 1\nline 2\nline 3\n' });
    writeProjectMdSafe(f.loop, f.cwd);
    const got = fs.readFileSync(path.join(f.cwd, 'PROJECT.md'), 'utf8');
    assert.equal(got, 'line 1\nline 2\nline 3\n');
    const leftover = fs.readdirSync(f.cwd).filter((e) => e.endsWith('.tmp'));
    assert.deepEqual(leftover, [], 'no .tmp file should remain after atomic rename');
  });
});
