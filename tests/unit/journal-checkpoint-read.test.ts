/**
 * pln#566 Inc0 s2 — checkpointRead fast path in loadState.
 *
 * When the capability is enabled AND a verified checkpoint exists, loadState
 * serves from checkpoint + sealed tail and returns the SAME state as the
 * projection read. On any failure (capability off, no checkpoint, tampered
 * checkpoint) it falls back to reading projection files. The capability is OFF
 * by default, so production reads are unchanged.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMemoryDir, resolveEntityDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { loadState, mutateState } from '../../src/core/state.js';
import { createCheckpoint } from '../../src/core/events/checkpoint.js';
import { journalDir } from '../../src/core/events/journal.js';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ckpt-read-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('ckpt-read', { projectId: 'prj_ckpt_read' }), dir);
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const k of Object.keys(savedEnv)) { const v = savedEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; delete savedEnv[k]; }
  while (cleanupDirs.length) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
});

function seed(dir: string): void {
  setEnv('BRAINCLAW_JOURNAL_MODE', 'dual'); // dual-write so the journal has post-images
  for (let i = 1; i <= 4; i++) {
    mutateState((s) => {
      s.recent_decisions.push({
        id: `dec_${i}`, short_label: `dec#${i}`, text: `decision ${i}`,
        created_at: `2026-06-12T00:00:0${i}.000Z`, author: 't', tags: [],
      } as never);
    }, dir);
  }
}

describe('checkpointRead fast path (pln#566 Inc0 s2)', () => {
  it('OFF by default: loadState reads projections (unchanged)', () => {
    const dir = tmpStore(); cleanupDirs.push(dir);
    seed(dir);
    createCheckpoint(dir);
    // No capability flag set → projection read.
    const ids = loadState(dir).recent_decisions.map(d => d.id).sort();
    assert.deepEqual(ids, ['dec_1', 'dec_2', 'dec_3', 'dec_4']);
  });

  it('ENABLED + verified checkpoint: fast path == projection read', () => {
    const dir = tmpStore(); cleanupDirs.push(dir);
    seed(dir);
    const baseline = loadState(dir); // projection read
    createCheckpoint(dir);

    setEnv('BRAINCLAW_PRIMARY_CHECKPOINT_READ', '1');
    const fast = loadState(dir); // checkpoint + sealed tail
    assert.deepEqual(fast, baseline, 'checkpoint fast path must equal the projection read');
  });

  it('ENABLED + gap after checkpoint: fast path replays the tail', () => {
    const dir = tmpStore(); cleanupDirs.push(dir);
    seed(dir);
    createCheckpoint(dir);
    // a mutation AFTER the checkpoint (tail)
    mutateState((s) => { s.recent_decisions.push({ id: 'dec_5', short_label: 'dec#5', text: 'tail', created_at: '2026-06-12T00:00:05.000Z', author: 't', tags: [] } as never); }, dir);

    setEnv('BRAINCLAW_PRIMARY_CHECKPOINT_READ', '1');
    const ids = loadState(dir).recent_decisions.map(d => d.id).sort();
    assert.deepEqual(ids, ['dec_1', 'dec_2', 'dec_3', 'dec_4', 'dec_5'], 'tail mutation must appear via checkpoint+tail');
  });

  it('ENABLED + no checkpoint: falls back to projection read', () => {
    const dir = tmpStore(); cleanupDirs.push(dir);
    seed(dir);
    // no createCheckpoint
    setEnv('BRAINCLAW_PRIMARY_CHECKPOINT_READ', '1');
    const ids = loadState(dir).recent_decisions.map(d => d.id).sort();
    assert.deepEqual(ids, ['dec_1', 'dec_2', 'dec_3', 'dec_4'], 'no checkpoint → projection fallback');
  });

  it('ENABLED + tampered checkpoint: falls back to projection read', () => {
    const dir = tmpStore(); cleanupDirs.push(dir);
    seed(dir);
    createCheckpoint(dir);
    const ckptDir = path.join(journalDir(dir), 'checkpoints');
    const snap = fs.readdirSync(ckptDir).find(f => f.endsWith('.snapshot.json'))!;
    fs.writeFileSync(path.join(ckptDir, snap), '[{"item_type":"decision","item_id":"dec_HACK","payload":{}}]');

    setEnv('BRAINCLAW_PRIMARY_CHECKPOINT_READ', '1');
    const ids = loadState(dir).recent_decisions.map(d => d.id).sort();
    assert.deepEqual(ids, ['dec_1', 'dec_2', 'dec_3', 'dec_4'], 'tampered checkpoint → projection fallback (never serves dec_HACK)');
  });
});
