import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { appendEvent } from '../../src/core/event-log.js';
import {
  appendJournalRecords,
  journalDir,
  journalStatus,
  journalWriterId,
  JournalRecordSchema,
  ACTION_CLASS_BY_ACTION,
  type JournalRecord,
} from '../../src/core/events/journal.js';

function readAllJournalRecords(cwd: string): JournalRecord[] {
  const dir = journalDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const records: JournalRecord[] = [];
  const segments = fs.readdirSync(dir).filter(f => f.startsWith('seg-') && f.endsWith('.jsonl')).sort();
  for (const seg of segments) {
    for (const line of fs.readFileSync(path.join(dir, seg), 'utf-8').split('\n')) {
      if (!line) continue;
      // Reader rule §2.6: unparseable lines are skipped (adjudicated fragments).
      try {
        const parsed = JournalRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      } catch { /* torn fragment — skip */ }
    }
  }
  return records;
}

describe('journal v2 write path (pln#543 step 2)', () => {
  let workspace: TestWorkspace;
  let savedMode: string | undefined;
  let savedSegBytes: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-journal-',
      projectId: 'prj_journal_test',
      currentAgent: 'testuser',
    });
    savedMode = process.env.BRAINCLAW_JOURNAL_MODE;
    savedSegBytes = process.env.BRAINCLAW_JOURNAL_SEGMENT_BYTES;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.BRAINCLAW_JOURNAL_MODE;
    else process.env.BRAINCLAW_JOURNAL_MODE = savedMode;
    if (savedSegBytes === undefined) delete process.env.BRAINCLAW_JOURNAL_SEGMENT_BYTES;
    else process.env.BRAINCLAW_JOURNAL_SEGMENT_BYTES = savedSegBytes;
    workspace.cleanup();
  });

  it('flag off (default): no journal directory, v1 unchanged', () => {
    delete process.env.BRAINCLAW_JOURNAL_MODE;
    appendEvent({ action: 'create', item_type: 'decision', item_id: 'dec_x', agent: 'alice' }, workspace.dir);

    assert.equal(fs.existsSync(journalDir(workspace.dir)), false);
    const v1 = fs.readFileSync(path.join(workspace.dir, '.brainclaw', 'events.jsonl'), 'utf-8');
    assert.match(v1, /dec_x/);
  });

  it('dual mode: v1 line AND v2 record with seq, writer, v:2', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'create', item_type: 'decision', item_id: 'dec_y', agent: 'alice' }, workspace.dir);

    const v1 = fs.readFileSync(path.join(workspace.dir, '.brainclaw', 'events.jsonl'), 'utf-8');
    assert.match(v1, /dec_y/);

    const records = readAllJournalRecords(workspace.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].v, 2);
    assert.equal(records[0].seq, 1);
    assert.equal(records[0].item_id, 'dec_y');
    assert.equal(records[0].writer, journalWriterId());
    assert.match(records[0].writer, /^w_\d+-[0-9a-f]{6}$/);
  });

  it('seq is monotonic and entity_rev bumps per item across appends', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'create', item_type: 'plan', item_id: 'pln_a', agent: 'a' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_a', agent: 'a' }, workspace.dir);
    appendEvent({ action: 'create', item_type: 'trap', item_id: 'trp_b', agent: 'a' }, workspace.dir);

    const records = readAllJournalRecords(workspace.dir);
    assert.deepEqual(records.map(r => r.seq), [1, 2, 3]);
    assert.deepEqual(records.map(r => r.entity_rev), [1, 2, 1]);
  });

  it('coarse state events map to journal_note store_marker', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'update', item_type: 'state', agent: 'system', summary: 'persist' }, workspace.dir);

    const records = readAllJournalRecords(workspace.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'journal_note');
    assert.equal(records[0].item_type, 'journal');
    assert.deepEqual(records[0].payload, { kind: 'store_marker', op: 'update', detail: 'persist' });
  });

  it('meta.json is a rebuildable cache: delete it, seq continues without reuse', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'create', item_type: 'plan', item_id: 'pln_m', agent: 'a' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_m', agent: 'a' }, workspace.dir);

    fs.unlinkSync(path.join(journalDir(workspace.dir), 'meta.json'));
    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_m', agent: 'a' }, workspace.dir);

    const records = readAllJournalRecords(workspace.dir);
    assert.deepEqual(records.map(r => r.seq), [1, 2, 3]);
    assert.equal(records[2].entity_rev, 3);
  });

  it('stale meta triggers tail validation: seq_repair appended, no seq collision', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'create', item_type: 'plan', item_id: 'pln_r', agent: 'a' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_r', agent: 'a' }, workspace.dir);

    // Tamper: rewind meta.next_seq as if a crash lost the cache update.
    const metaFile = path.join(journalDir(workspace.dir), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    meta.next_seq = 1;
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf-8');

    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_r', agent: 'a' }, workspace.dir);

    const records = readAllJournalRecords(workspace.dir);
    const repair = records.find(r => r.action === 'seq_repair');
    assert.ok(repair, 'seq_repair record expected');
    assert.equal(repair!.payload!.tail_seq, 2);
    const seqs = records.map(r => r.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq');
    assert.equal(Math.max(...seqs), records.length);
  });

  it('torn tail is adjudicated with a journal_note, not absorbed', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    appendEvent({ action: 'create', item_type: 'plan', item_id: 'pln_t', agent: 'a' }, workspace.dir);

    // Simulate a torn write: unterminated garbage at the active segment tail.
    const dir = journalDir(workspace.dir);
    const seg = fs.readdirSync(dir).find(f => f.startsWith('seg-'))!;
    fs.appendFileSync(path.join(dir, seg), '{"v":2,"seq":99,"truncat', 'utf-8');

    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_t', agent: 'a' }, workspace.dir);

    const records = readAllJournalRecords(workspace.dir);
    const note = records.find(r => r.action === 'journal_note' && (r.payload as { kind?: string })?.kind === 'torn_tail_adjudicated');
    assert.ok(note, 'torn_tail_adjudicated note expected');
    assert.equal(typeof note!.payload!.sha256, 'string');
    // The valid update record after the tear is intact and parseable.
    const update = records.find(r => r.action === 'update' && r.item_id === 'pln_t');
    assert.ok(update);
    assert.equal(update!.entity_rev, 2);
  });

  it('segment rolls at the size threshold; old segment is never renamed', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    process.env.BRAINCLAW_JOURNAL_SEGMENT_BYTES = '200';

    for (let i = 0; i < 5; i++) {
      appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_roll', agent: 'a', summary: 'x'.repeat(80) }, workspace.dir);
    }

    const dir = journalDir(workspace.dir);
    const segments = fs.readdirSync(dir).filter(f => f.startsWith('seg-')).sort();
    assert.ok(segments.length >= 2, `expected a roll, got ${segments.join(', ')}`);
    assert.equal(segments[0], 'seg-00000001.jsonl');
    // All records remain readable across segments with monotonic seq.
    const records = readAllJournalRecords(workspace.dir);
    assert.deepEqual(records.map(r => r.seq), records.map((_, i) => i + 1));
  });

  it('observability records carry no payload and no entity_rev; violations are counted not thrown', () => {
    process.env.BRAINCLAW_JOURNAL_MODE = 'dual';
    const before = journalStatus(workspace.dir).violations;

    appendEvent({ action: 'session_start', item_type: 'session', agent: 'a' }, workspace.dir);
    // entity-state without payload: permitted in dual, counted as violation.
    const appended = appendJournalRecords([{ action: 'create', item_type: 'decision', item_id: 'dec_v', agent: 'a' }], workspace.dir);

    assert.equal(appended.length, 1);
    const records = readAllJournalRecords(workspace.dir);
    const session = records.find(r => r.action === 'session_start')!;
    assert.equal(session.payload, undefined);
    assert.equal(session.entity_rev, undefined);
    assert.ok(journalStatus(workspace.dir).violations > before, 'dual-mode violation counted');
  });

  it('every v2 action is classified (table is the runtime mirror of the compile-time check)', () => {
    for (const [action, cls] of Object.entries(ACTION_CLASS_BY_ACTION)) {
      assert.ok(['entity-state', 'tombstone', 'journal-meta', 'observability', 'registry-lifecycle'].includes(cls), `${action} has invalid class ${cls}`);
    }
    assert.equal(Object.keys(ACTION_CLASS_BY_ACTION).length, 42);
  });
});
