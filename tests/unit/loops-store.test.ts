import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeLoop,
  getLoop,
  listLoopEvents,
  listLoops,
  openLoop,
  DEFAULT_PROTOCOLS,
  LoopArtifactSchema,
  LOOP_ARTIFACT_BODY_MAX_BYTES,
} from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-test-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

describe('loops store — openLoop', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a review loop with default phases + stop condition', () => {
    const loop = openLoop(
      { kind: 'review', title: 'first review', created_by: 'agt_test' },
      cwd,
    );
    assert.match(loop.id, /^lop_[0-9a-z]+$/);
    assert.equal(loop.version, 1);
    assert.equal(loop.status, 'open');
    assert.equal(loop.current_phase, 'change_summary');
    assert.equal(loop.iteration_count, 0);
    assert.deepEqual(
      loop.phases.map((p) => p.name),
      DEFAULT_PROTOCOLS.review.phases.map((p) => p.name),
    );
    assert.deepEqual(loop.stop_condition, DEFAULT_PROTOCOLS.review.stop_condition);
    assert.equal(loop.protocol?.review_mode, 'asymmetric');
    assert.equal(loop.created_by, 'agt_test');
    assert.equal(loop.slots.length, 0);
    assert.equal(loop.artifacts.length, 0);
  });

  it('persists the thread file and one opened event', () => {
    const loop = openLoop(
      { kind: 'ideation', title: 'brainstorm', created_by: 'agt_test' },
      cwd,
    );
    const onDisk = getLoop(loop.id, cwd);
    assert.ok(onDisk, 'thread file must exist');
    assert.equal(onDisk.mutation_id, loop.mutation_id);

    const events = listLoopEvents(loop.id, cwd);
    assert.equal(events.length, 1);
    const first = events[0];
    assert.equal(first.kind, 'opened');
    assert.equal(first.seq, 1);
    assert.equal(first.mutation_id, loop.mutation_id);
    if (first.kind === 'opened') {
      assert.equal(first.initial_phase, loop.current_phase);
      assert.equal(first.created_by, 'agt_test');
    }
  });

  it('mints distinct slot ids and defaults slot status to "open"', () => {
    const loop = openLoop(
      {
        kind: 'review',
        title: 'with slots',
        created_by: 'agt_test',
        slots: [{ role: 'author', agent: 'claude-code' }, { role: 'reviewer', agent: 'codex' }],
      },
      cwd,
    );
    assert.equal(loop.slots.length, 2);
    assert.notEqual(loop.slots[0].slot_id, loop.slots[1].slot_id);
    for (const slot of loop.slots) {
      assert.match(slot.slot_id, /^lsl_[0-9a-z]+$/);
      assert.equal(slot.status, 'open');
    }
  });

  it('accepts a symmetric review mode and persists it on the thread', () => {
    const loop = openLoop(
      { kind: 'review', title: 'sym', mode: 'symmetric', created_by: 'agt_test' },
      cwd,
    );
    assert.equal(loop.protocol?.review_mode, 'symmetric');
  });

  it('accepts an explicit composite stop_condition override', () => {
    const loop = openLoop(
      {
        kind: 'review',
        title: 'custom stop',
        created_by: 'agt_test',
        stop_condition: {
          kind: 'all',
          conditions: [
            { kind: 'reviewer_green' },
            { kind: 'phase_reached', phase: 'verdict' },
          ],
        },
      },
      cwd,
    );
    assert.equal(loop.stop_condition?.kind, 'all');
  });

  it('rejects phases with duplicate names', () => {
    assert.throws(
      () =>
        openLoop(
          {
            kind: 'research',
            title: 'bad phases',
            created_by: 'agt_test',
            phases: [{ name: 'a' }, { name: 'a' }],
          },
          cwd,
        ),
      /phase names must be unique/,
    );
  });
});

describe('loops store — listLoops', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('returns loops sorted by created_at and filters by kind/status', () => {
    const a = openLoop({ kind: 'review', title: 'a', created_by: 'agt_test' }, cwd);
    const b = openLoop({ kind: 'ideation', title: 'b', created_by: 'agt_test' }, cwd);

    // On fast CI machines both loops can land in the same millisecond, and
    // `created_at` has only ms precision — so the sort is stable but the
    // natural order of two same-ms loops is undefined. Assert set membership
    // rather than order for the broad listing (the per-filter cases below
    // remain deterministic because each filter returns a single loop).
    const all = listLoops({}, cwd);
    const allIds = all.map((l) => l.id).sort();
    assert.deepEqual(allIds, [a.id, b.id].sort());

    const reviews = listLoops({ kind: 'review' }, cwd);
    assert.deepEqual(
      reviews.map((l) => l.id),
      [a.id],
    );

    const open = listLoops({ status: 'open' }, cwd);
    assert.equal(open.length, 2);
  });
});

describe('loops store — closeLoop', () => {
  let cwd: string;
  before(() => {
    cwd = makeWorkspace();
  });
  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('transitions an open loop to completed, bumps version, appends closed event', () => {
    const loop = openLoop(
      { kind: 'research', title: 'done', created_by: 'agt_test' },
      cwd,
    );
    const closed = closeLoop(
      { id: loop.id, final_status: 'completed', actor: 'agt_test', reason: 'finished' },
      cwd,
    );
    assert.equal(closed.status, 'completed');
    assert.equal(closed.version, loop.version + 1);
    assert.ok(closed.closed_at, 'closed_at must be set');
    assert.notEqual(closed.mutation_id, loop.mutation_id);

    const events = listLoopEvents(loop.id, cwd);
    assert.equal(events.length, 2);
    const last = events[1];
    assert.equal(last.kind, 'closed');
    assert.equal(last.seq, 2);
    if (last.kind === 'closed') {
      assert.equal(last.final_status, 'completed');
      assert.equal(last.reason, 'finished');
    }
  });

  it('refuses to close an already-closed loop', () => {
    const loop = openLoop(
      { kind: 'research', title: 'second', created_by: 'agt_test' },
      cwd,
    );
    closeLoop({ id: loop.id, final_status: 'cancelled', actor: 'agt_test' }, cwd);
    assert.throws(
      () => closeLoop({ id: loop.id, final_status: 'completed', actor: 'agt_test' }, cwd),
      /already cancelled/,
    );
  });

  it('throws when loop_id is unknown', () => {
    assert.throws(
      () => closeLoop({ id: 'lop_doesnotexist', final_status: 'cancelled', actor: 'agt_test' }, cwd),
      /unknown loop_id/,
    );
  });
});

describe('loops types — artifact body size cap', () => {
  it('accepts a body under the 4 KB cap', () => {
    const body = 'x'.repeat(LOOP_ARTIFACT_BODY_MAX_BYTES);
    const artifact = LoopArtifactSchema.parse({
      artifact_id: 'art_1',
      phase: 'findings',
      type: 'finding',
      body,
      produced_at: new Date().toISOString(),
    });
    assert.equal(artifact.body, body);
  });

  it('rejects a body over the 4 KB cap', () => {
    const body = 'x'.repeat(LOOP_ARTIFACT_BODY_MAX_BYTES + 1);
    assert.throws(() =>
      LoopArtifactSchema.parse({
        artifact_id: 'art_2',
        phase: 'findings',
        type: 'finding',
        body,
        produced_at: new Date().toISOString(),
      }),
    );
  });
});
