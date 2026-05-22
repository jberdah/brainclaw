import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir, writeFileAtomic } from '../../io.js';
import { nowISO } from '../../ids.js';
import {
  LoopArtifactSchema,
  RefBasedArtifactBodySchema,
  type LoopArtifact,
  type LoopThread,
  type RefBasedArtifactBody,
} from '../types.js';

/**
 * pln#512 step 1 — `writeProjectMdSafe` (close hook, IMPL only).
 *
 * Resolves the latest `project_md_final` artifact on a bootstrap loop and,
 * depending on whether PROJECT.md already exists at the workspace root,
 * either writes it atomically OR returns a `file_diff` artifact the caller
 * must hand back to the operator for explicit approval.
 *
 * Wiring into `closeLoop` + the `file_overwrite_approval` request_input flow
 * is pln#512 step 2 — this module only ships the function itself.
 */

export interface WriteProjectMdResult {
  needs_approval: boolean;
  target_path: string;
  /** When needs_approval=true: file_diff artifact the caller splices onto the loop. */
  diff_artifact?: LoopArtifact;
  /** When needs_approval=false: did we actually write the target file? */
  written?: boolean;
  reason: 'absent' | 'empty' | 'present_non_empty' | 'no_final_artifact';
}

/**
 * pln#512 step 2 — caller-side option toggle.
 *
 * `approved=true` means "the operator already said yes to the overwrite via a
 * resolved file_overwrite_approval question; skip the diff path and write
 * atomically". Used by the provideInput post-hook to finalize the file write
 * after the operator approves an existing PROJECT.md overwrite. Default
 * `approved=false` preserves step 1 behavior — the hook still returns a
 * file_diff artifact when target is present_non_empty.
 */
export interface WriteProjectMdOptions {
  approved?: boolean;
}

/**
 * Directory where ref-based artifact payloads for a given loop live on disk.
 * No central helper exists yet, so this is the canonical place to compute it.
 * Layout mirrors the thread/event storage convention in store.ts:
 *
 *   <memoryDir>/loops/threads/<loop_id>/artifacts/<ref>
 */
function loopArtifactsDir(loopId: string, cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops', 'threads', loopId, 'artifacts');
}

/**
 * Returns the most recently produced `project_md_final` artifact on the loop,
 * or `undefined` if none has been added yet. Artifacts on `loop.artifacts` are
 * appended in production order, so the last match is "latest".
 */
function findLatestFinal(loop: LoopThread): LoopArtifact | undefined {
  for (let i = loop.artifacts.length - 1; i >= 0; i--) {
    const a = loop.artifacts[i];
    if (a.type === 'project_md_final') return a;
  }
  return undefined;
}

/**
 * Parse the ref-based body off a known-typed loop artifact. The
 * LoopArtifactSchema validator already enforces the JSON shape, so any failure
 * here points at a corrupt thread file rather than schema drift.
 */
function parseRefBody(artifact: LoopArtifact): RefBasedArtifactBody {
  if (!artifact.body) {
    throw new Error(
      `writeProjectMdSafe: artifact ${artifact.artifact_id} (type=${artifact.type}) has no body — expected ref-based payload`,
    );
  }
  return RefBasedArtifactBodySchema.parse(JSON.parse(artifact.body));
}

/**
 * Hand-rolled unified-diff renderer.
 *
 * Phase 0 spec §file_overwrite_approval explicitly accepts a coarse diff for
 * v1 — the operator reads it; nothing automated patches with it. So we render
 * every old line as `-` and every new line as `+` under a single `@@` hunk
 * header. Output is stable and deterministic.
 */
function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  oldLabel: string,
  newLabel: string,
): string {
  const oldLines = oldContent.length === 0 ? [] : oldContent.split(/\r?\n/);
  const newLines = newContent.length === 0 ? [] : newContent.split(/\r?\n/);
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const oldStart = oldCount === 0 ? 0 : 1;
  const newStart = newCount === 0 ? 0 : 1;

  const lines: string[] = [];
  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);
  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);
  return lines.join('\n');
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * pln#512 step 1 — IMPL.
 *
 * @see WriteProjectMdResult
 * @see WriteProjectMdOptions
 */
export function writeProjectMdSafe(
  loop: LoopThread,
  cwd?: string,
  opts?: WriteProjectMdOptions,
): WriteProjectMdResult {
  const resolvedCwd = cwd ?? process.cwd();
  const target_path = path.join(resolvedCwd, 'PROJECT.md');

  const finalArtifact = findLatestFinal(loop);
  if (!finalArtifact) {
    return {
      needs_approval: false,
      target_path,
      written: false,
      reason: 'no_final_artifact',
    };
  }

  const body = parseRefBody(finalArtifact);
  const sourcePath = path.join(loopArtifactsDir(loop.id, resolvedCwd), body.ref);
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');

  const exists = fs.existsSync(target_path);
  const isEmpty = exists && fs.statSync(target_path).size === 0;

  if (!exists || isEmpty) {
    writeFileAtomic(target_path, sourceContent);
    return {
      needs_approval: false,
      target_path,
      written: true,
      reason: exists ? 'empty' : 'absent',
    };
  }

  // pln#512 step 2 — approval short-circuit. When the operator has already
  // signed off on the overwrite (via a resolved file_overwrite_approval
  // question), the caller passes opts.approved=true and we write atomically
  // without re-generating a diff artifact. Mirrors the absent/empty branch
  // semantics so callers see a unified shape.
  if (opts?.approved === true) {
    writeFileAtomic(target_path, sourceContent);
    return {
      needs_approval: false,
      target_path,
      written: true,
      reason: 'present_non_empty',
    };
  }

  // Present + non-empty → build a file_diff artifact for operator approval.
  // We do NOT touch the loop thread or the target file; the caller (step 2)
  // splices the artifact onto the thread under request_input.
  const existingContent = fs.readFileSync(target_path, 'utf8');
  const diff = generateUnifiedDiff(existingContent, sourceContent, 'PROJECT.md', 'PROJECT.md (proposed)');

  const artifactId = `art_${crypto.randomBytes(6).toString('hex')}`;
  const patchRef = `${artifactId}.patch`;
  const patchPath = path.join(loopArtifactsDir(loop.id, resolvedCwd), patchRef);
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  writeFileAtomic(patchPath, diff);

  const refBody: RefBasedArtifactBody = {
    ref: patchRef,
    byte_count: Buffer.byteLength(diff, 'utf8'),
    sha256: sha256Hex(diff),
  };

  const diff_artifact = LoopArtifactSchema.parse({
    artifact_id: artifactId,
    phase: finalArtifact.phase,
    type: 'file_diff',
    body: JSON.stringify(refBody),
    produced_at: nowISO(),
  });

  return {
    needs_approval: true,
    target_path,
    diff_artifact,
    reason: 'present_non_empty',
  };
}
