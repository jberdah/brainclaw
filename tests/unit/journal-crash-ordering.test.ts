/**
 * pln#566 F1 — persist crash-ordering invariant (I2).
 *
 * The primary cutover's lazy-reconcile recovery assumes a crash can only leave
 * the JOURNAL ahead of the projections, never the reverse. The persist pipeline
 * now emits + fsyncs the per-entity journal records BEFORE applying any
 * projection write (src/core/state.ts persistStateUnlocked). These tests prove
 * it with deterministic fault injection (BRAINCLAW_FAULT_POINT) instead of a
 * racy SIGKILL: a child crashes at a known point, the parent inspects on-disk
 * state. The OLD ordering (projections first) would have produced the opposite,
 * unrecoverable, result here.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMemoryDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { loadState } from '../../src/core/state.js';
import { readJournalRecords } from '../../src/core/events/journal.js';
import { materializeMemoryStateFromJournal } from '../../src/core/events/materialize.js';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-crash-order-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('crash-order', { projectId: 'prj_crash_order' }), dir);
  return dir;
}

async function runChild(dir: string, faultPoint: string | undefined, id: string): Promise<number | null> {
  const stateUrl = new URL('../../src/core/state.js', import.meta.url).href;
  const script = `
    import { mutateState } from ${JSON.stringify(stateUrl)};
    mutateState((state) => {
      state.recent_decisions.push({
        id: ${JSON.stringify(id)}, short_label: 'dec#crash',
        text: 'crash-ordering probe', created_at: '2026-06-12T00:00:00.000Z',
        author: 'tester', tags: [],
      });
    }, ${JSON.stringify(dir)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BRAINCLAW_JOURNAL_MODE: 'dual', ...(faultPoint ? { BRAINCLAW_FAULT_POINT: faultPoint } : {}) },
  });
  return await new Promise((resolve) => child.on('close', resolve));
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
});

describe('persist crash ordering — journal before projections (pln#566 F1)', { concurrency: false }, () => {
  it('crash AFTER journal, BEFORE projection: journal ahead, projection behind (recoverable)', async () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    const status = await runChild(dir, 'after_journal', 'dec_crash');
    assert.notEqual(status, 0, 'child must crash at the injected fault point');

    // Journal is AHEAD: the create event was appended+fsync'd before the crash.
    const journalHasIt = readJournalRecords(dir).some(r => r.item_id === 'dec_crash');
    assert.equal(journalHasIt, true, 'journal must contain the event (it is emitted before projections)');

    // Projection is BEHIND: the projection write never ran (crash was before apply).
    const projectionHasIt = loadState(dir).recent_decisions.some(d => d.id === 'dec_crash');
    assert.equal(projectionHasIt, false, 'projection must NOT have the entity yet (recoverable direction)');

    // Recovery converges: materializing from the journal restores the entity.
    const materializedHasIt = materializeMemoryStateFromJournal(dir).recent_decisions.some(d => d.id === 'dec_crash');
    assert.equal(materializedHasIt, true, 'lazy-reconcile from the journal would restore the entity');
  });

  it('clean persist (no fault): journal, projection, and materialize all agree', async () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    const status = await runChild(dir, undefined, 'dec_ok');
    assert.equal(status, 0, 'clean child must exit 0');

    assert.equal(readJournalRecords(dir).some(r => r.item_id === 'dec_ok'), true, 'journal has it');
    assert.equal(loadState(dir).recent_decisions.some(d => d.id === 'dec_ok'), true, 'projection has it');
    assert.equal(materializeMemoryStateFromJournal(dir).recent_decisions.some(d => d.id === 'dec_ok'), true, 'materialize has it');
  });
});
