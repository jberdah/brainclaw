/**
 * Observer performance benchmark (pln#560 step 3, stp_25c54641).
 *
 * Measures the journal-consumer / board-projection hot paths against a REAL
 * event journal, and reports them against the observer-protocol §10 budgets.
 * It is a standalone measurement tool, NOT a unit test — wall-clock asserts in
 * the suite are flaky (cf. pln#543 "drop flaky wall-clock asserts"), so this
 * prints numbers for a human/soak to judge instead of asserting them.
 *
 * Usage:
 *   node out/.. is not needed; this requires the compiled CommonJS modules.
 *   1) npm run compile   (produces out/journal-consumer.js, out/board-projection.js)
 *   2) node scripts/observer-bench.cjs [eventsDir]
 *      eventsDir defaults to <repo>/.brainclaw/events.
 *
 * Run node with --expose-gc for a tighter heap delta (optional).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { applyTail, tailRecords } = require('../out/journal-consumer.js');
const { projectBoard, projectCounts, attentionRequired } = require('../out/board-projection.js');

const eventsDir = process.argv[2] || path.join(__dirname, '..', '..', '.brainclaw', 'events');

function timed(label, fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, r, label };
}

function fmt(ms) { return `${ms.toFixed(1)} ms`; }

// §10 budgets (target / hard limit), restated.
const BUDGETS = {
  activation: { target: 500, hard: 2000, label: 'Activation -> first summary' },
  refresh: { target: 300, hard: 1000, label: 'Summary refresh (warm tail)' },
  warmExpand: { target: 50, hard: 200, label: 'Section expand (warm, in-memory)' },
};

function verdict(ms, b) {
  if (ms <= b.target) return 'OK (<= target)';
  if (ms <= b.hard) return 'OVER TARGET (<= hard limit)';
  return 'OVER HARD LIMIT';
}

console.log(`observer-bench — eventsDir: ${eventsDir}`);
if (!fs.existsSync(eventsDir)) {
  console.error('events dir does not exist — pass a path or enable journal mode (BRAINCLAW_JOURNAL_MODE=dual).');
  process.exit(2);
}

// Journal size context.
const segs = fs.readdirSync(eventsDir).filter((f) => /^seg-\d{8}\.jsonl$/.test(f));
let bytes = 0;
for (const s of segs) { bytes += fs.statSync(path.join(eventsDir, s)).size; }
console.log(`segments: ${segs.length}, total bytes: ${(bytes / 1e6).toFixed(1)} MB`);

if (global.gc) { global.gc(); }
const heapBefore = process.memoryUsage().heapUsed;

// 1) Cold bootstrap = activation path (full replay from seq 0).
const projection = new Map();
const cold = timed('cold bootstrap (full replay)', () => applyTail(projection, eventsDir, { seq: 0, checkpoint_seq: 0 }));
const heapAfter = process.memoryUsage().heapUsed;
console.log(`\n[1] ${BUDGETS.activation.label}`);
console.log(`    ${fmt(cold.ms)}  | applied ${cold.r.applied} records | projection entities: ${projection.size}`);
console.log(`    budget ${BUDGETS.activation.target}/${BUDGETS.activation.hard} ms -> ${verdict(cold.ms, BUDGETS.activation)}`);

// 2) Warm tail = summary refresh (re-tail from the advanced cursor; applies 0 new).
const warm = timed('warm tail (no new records)', () => applyTail(projection, eventsDir, cold.r.cursor));
console.log(`\n[2] ${BUDGETS.refresh.label} (re-tail, 0 new records)`);
console.log(`    ${fmt(warm.ms)}  | applied ${warm.r.applied} records`);
console.log(`    budget ${BUDGETS.refresh.target}/${BUDGETS.refresh.hard} ms -> ${verdict(warm.ms, BUDGETS.refresh)}`);
console.log(`    NOTE: tailRecords reads+parses EVERY segment each call (no segment seek / byte offset, §5 unimplemented),`);
console.log(`          so this cost recurs on every journal-growth refresh, independent of how few records are new.`);

// 3) Warm expand = build the board / counts from the in-memory projection.
const board = timed('projectBoard', () => projectBoard(projection));
const counts = timed('projectCounts', () => projectCounts(projection));
const att = timed('attentionRequired', () => attentionRequired(board.r));
console.log(`\n[3] ${BUDGETS.warmExpand.label}`);
console.log(`    projectBoard ${fmt(board.ms)} | projectCounts ${fmt(counts.ms)} | attentionRequired ${fmt(att.ms)}`);
const worstExpand = Math.max(board.ms, counts.ms, att.ms);
console.log(`    worst ${fmt(worstExpand)} | budget ${BUDGETS.warmExpand.target}/${BUDGETS.warmExpand.hard} ms -> ${verdict(worstExpand, BUDGETS.warmExpand)}`);

// 4) Memory footprint of the retained projection (rough heap delta).
console.log(`\n[4] Projection memory (rough heap delta)`);
console.log(`    heap +${((heapAfter - heapBefore) / 1e6).toFixed(1)} MB for ${projection.size} entities`
  + (global.gc ? '' : '  (run node --expose-gc for a tighter number)'));

// Section breakdown (what the journal actually covers, trp_2a89ae97).
const b = board.r;
console.log(`\n[5] Journal coverage (entities with payloads in the projection)`);
console.log(`    plans=${b.active_plans.length} traps=${b.known_traps.length} handoffs=${b.open_handoffs.length}`
  + ` claims=${b.active_claims.length} actions=${b.active_actions.length} assignments=${b.active_assignments.length}`
  + ` runs=${b.active_runs.length} candidates=${b.pending_candidates.length}`);
