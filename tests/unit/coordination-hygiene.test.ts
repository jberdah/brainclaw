/**
 * pln#602 — coordination hygiene tests.
 *
 * Covers:
 *  - HygienePolicy defaults + opt-out
 *  - hint-aging: serve counter bumps, K-times → aggregate, idempotence,
 *    key normalization, opt-out
 *  - assignment-sweeper: sweepAssignmentsFromList + read-path variant on the
 *    empirical 2026-07-04 pattern (workers dead, heartbeats mtime > TTL,
 *    worktree GC'd) — converges via the canonical grammar
 *  - parkClosedAutoHandoffs: park-only, backup written, human handoffs untouched
 *  - runHygieneReport: shape + counts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { nowISO, generateId } from '../../src/core/ids.js';
import {
  DEFAULT_HYGIENE_POLICY,
  loadHygienePolicy,
  type HygienePolicy,
} from '../../src/core/hygiene-policy.js';
import {
  ageStaleWarnings,
  ageWorkflowHints,
  loadServeRegistry,
  saveServeRegistry,
  computeServeStats,
  __testing as hintTesting,
} from '../../src/core/hint-aging.js';
import type { StalenessWarning } from '../../src/core/staleness.js';
import { saveAssignment, loadAssignment } from '../../src/core/assignments.js';
import { sweepAssignmentsFromList, sweepAssignmentsAtReadPath, selectReadPathSweepCandidates } from '../../src/core/assignment-sweeper.js';
import { parkClosedAutoHandoffs } from '../../src/core/gc-semantic.js';
import { runHygieneReport } from '../../src/commands/doctor.js';
import type { Assignment, Handoff } from '../../src/core/schema.js';

// ── Fixtures ──────────────────────────────────────────────────────

function mkStale(id: string, entity: StalenessWarning['entity'] = 'plan'): StalenessWarning {
  return {
    id, entity, text: `stale ${id}`, age_days: 87,
    reason: 'test reason',
    suggested_action: `bclaw_transition ${id}`,
  };
}

function mkOfferedAssignment(ws: TestWorkspace, id: string, offeredAt: string): Assignment {
  const a: Assignment = {
    schema_version: 2,
    id,
    short_label: id,
    claim_id: 'clm_hyg',
    agent: 'claude-code',
    dispatcher_agent: 'coordinator',
    scope: 'hygiene-scope',
    description: 'hygiene fixture',
    status: 'offered',
    created_at: offeredAt,
    updated_at: offeredAt,
    offered_at: offeredAt,
    last_heartbeat_at: offeredAt,
    artifacts: [],
    retry_count: 0,
    max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000,
    acceptance_ttl_ms: 15 * 60_000,
    tags: [],
  };
  saveAssignment(a, ws.dir);
  return a;
}

function writeAutoHandoff(ws: TestWorkspace, id: string, status: Handoff['status'], updatedAt: string, isAuto = true): string {
  const dir = path.join(ws.dir, '.brainclaw', 'coordination', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const text = isAuto
    ? `Session sess_test — auto-generated handoff.\nCommits: abc123`
    : `Human note.`;
  const doc = {
    schema_version: 2,
    id,
    from: 'claude-code',
    to: 'coordinator',
    text,
    tags: [],
    status,
    created_at: updatedAt,
    updated_at: updatedAt,
    author: 'claude-code',
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8');
  return file;
}

// ── HygienePolicy ─────────────────────────────────────────────────

let ws: TestWorkspace;
beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-hyg-', projectId: 'prj_hyg', currentAgent: 'hyg-tester' }); });
afterEach(() => { ws.cleanup(); });

describe('HygienePolicy', () => {
  it('exposes non-zero defaults with disabled=false', () => {
    assert.equal(DEFAULT_HYGIENE_POLICY.disabled, false);
    assert.ok(DEFAULT_HYGIENE_POLICY.assignment_offered_ttl_ms > 0);
    assert.ok(DEFAULT_HYGIENE_POLICY.stale_warning_serve_k >= 1);
    assert.ok(DEFAULT_HYGIENE_POLICY.read_path_sweep_budget >= 1);
  });

  it('falls back to defaults when config has no hygiene block', () => {
    const p = loadHygienePolicy(ws.dir);
    assert.equal(p.disabled, DEFAULT_HYGIENE_POLICY.disabled);
    assert.equal(p.stale_warning_serve_k, DEFAULT_HYGIENE_POLICY.stale_warning_serve_k);
  });
});

// ── hint-aging ────────────────────────────────────────────────────

describe('ageStaleWarnings', () => {
  it('serves detail until the counter hits K, then folds into aggregate', () => {
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, stale_warning_serve_k: 2 };
    const warnings = [mkStale('pln_a'), mkStale('rtn_b', 'runtime_note')];
    // First call: both new (count 0 → 1) — detail
    const first = ageStaleWarnings(warnings, ws.dir, { policy });
    assert.equal(first.warnings.length, 2);
    assert.equal(first.aggregate, undefined);
    // Second call: counts move 1 → 2 — still detail
    const second = ageStaleWarnings(warnings, ws.dir, { policy });
    assert.equal(second.warnings.length, 2);
    assert.equal(second.aggregate, undefined);
    // Third call: counts already at K=2 — folded into aggregate
    const third = ageStaleWarnings(warnings, ws.dir, { policy });
    assert.equal(third.warnings.length, 0);
    assert.ok(third.aggregate, 'aggregate present when K reached');
    // trp_336e8054 — the recovery must work VERBATIM. The old line pointed at
    // bclaw_find(status:'stale'), a filter that returns nothing (staleness is
    // computed, never stored), so the operator could not retrieve the items
    // the aggregate announced. The folded ids themselves are the pointer.
    assert.match(third.aggregate!, /pln_a/, 'aggregate names the folded ids');
    assert.match(third.aggregate!, /rtn_b/, 'aggregate names the folded ids');
    assert.doesNotMatch(third.aggregate!, /status:'stale'/, 'never recommend the filter the engine cannot resolve');
  });

  it('opt-out (disabled=true) bypasses aging entirely', () => {
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, disabled: true, stale_warning_serve_k: 1 };
    // Pre-poison the registry: even with existing counts, disabled=true returns as-is
    saveServeRegistry({ schema_version: 1, warnings: { 'pln_a': { count: 99, first_at: '2020', last_at: '2020' } }, hints: {} }, ws.dir);
    const w = [mkStale('pln_a')];
    const r = ageStaleWarnings(w, ws.dir, { policy });
    assert.deepEqual(r.warnings, w);
    assert.equal(r.aggregate, undefined);
  });

  it('recordServe=false previews aging without persisting counter changes', () => {
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, stale_warning_serve_k: 5 };
    ageStaleWarnings([mkStale('pln_z')], ws.dir, { policy, recordServe: false });
    const reg = loadServeRegistry(ws.dir);
    assert.equal(reg.warnings['pln_z'], undefined, 'counter must not persist in preview mode');
  });

  it('is safe to call twice — counter increments monotonically per invocation', () => {
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, stale_warning_serve_k: 10 };
    ageStaleWarnings([mkStale('pln_i')], ws.dir, { policy });
    ageStaleWarnings([mkStale('pln_i')], ws.dir, { policy });
    const reg = loadServeRegistry(ws.dir);
    assert.equal(reg.warnings['pln_i'].count, 2);
  });
});

describe('ageWorkflowHints', () => {
  it('normalises hint keys so numeric variants fold into the same counter', () => {
    // The generator produces "3 in-progress plan(s) without a claim..."; another
    // session might produce "5 in-progress plan(s) without a claim..." — the
    // aging must key both on the same normalised text (numbers stripped).
    const raw1 = '3 in-progress plan(s) without a claim — consider claiming pln_abcd1234';
    const raw2 = '7 in-progress plan(s) without a claim — consider claiming pln_ffff9999';
    assert.equal(hintTesting.hintKey(raw1), hintTesting.hintKey(raw2), 'digit + id normalization');
  });

  it('folds hints served ≥ K into an aggregate', () => {
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, workflow_hint_serve_k: 1 };
    ageWorkflowHints(['confirm or retire dec_426b3b00 (87d old)'], ws.dir, { policy });
    const second = ageWorkflowHints(['confirm or retire dec_426b3b00 (87d old)'], ws.dir, { policy });
    assert.equal(second.hints.length, 0);
    assert.ok(second.aggregate);
  });
});

// ── assignment-sweeper (empirical 2026-07-04 pattern) ─────────────

describe('sweepAssignmentsFromList — empirical fable-audit pattern', () => {
  it('offered heartbeat mtime > TTL with no evidence → expired via canonical grammar', () => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago
    const a = mkOfferedAssignment(ws, generateId('assignments'), stale);
    const result = sweepAssignmentsFromList([a], ws.dir, { actor: 'test' });
    assert.equal(result.expired.length, 1, 'canonical expired transition applied');
    assert.equal(result.expired[0].assignment_id, a.id);
    const post = loadAssignment(a.id, ws.dir)!;
    assert.equal(post.status, 'expired');
    assert.ok(post.status_reason?.includes('Not accepted'), 'audit trail carries the reason');
  });

  it('policy.disabled=true bypasses the sweep', () => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const a = mkOfferedAssignment(ws, generateId('assignments'), stale);
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, disabled: true };
    const result = sweepAssignmentsFromList([a], ws.dir, { actor: 'test', policy });
    assert.equal(result.expired.length, 0, 'disabled=true is a no-op');
    assert.equal(loadAssignment(a.id, ws.dir)!.status, 'offered');
  });

  it('read-path variant honours the budget', () => {
    const budget = 2;
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, read_path_sweep_budget: budget };
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const items: Assignment[] = [];
    for (let i = 0; i < 5; i++) items.push(mkOfferedAssignment(ws, generateId('assignments'), stale));
    sweepAssignmentsAtReadPath(items, ws.dir, { policy });
    const expiredCount = items.map((a) => loadAssignment(a.id, ws.dir)!).filter((a) => a.status === 'expired').length;
    assert.equal(expiredCount, budget, 'sweep did not exceed budget');
  });

  it('is idempotent: sweeping the same list twice does not corrupt state', () => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const a = mkOfferedAssignment(ws, generateId('assignments'), stale);
    sweepAssignmentsFromList([a], ws.dir, { actor: 'test' });
    const first = loadAssignment(a.id, ws.dir)!.status;
    const secondPass = sweepAssignmentsFromList([loadAssignment(a.id, ws.dir)!], ws.dir, { actor: 'test' });
    assert.equal(secondPass.expired.length, 0);
    assert.equal(loadAssignment(a.id, ws.dir)!.status, first);
  });
});

// ── parkClosedAutoHandoffs ────────────────────────────────────────

describe('parkClosedAutoHandoffs', () => {
  it('parks closed auto-generated handoffs older than the cutoff (writes backup, never deletes silently)', () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const filePath = writeAutoHandoff(ws, 'hnd_old', 'closed', old, true);
    const result = parkClosedAutoHandoffs(ws.dir, 30, false);
    assert.equal(result.candidates, 1);
    assert.equal(result.parked, 1);
    assert.ok(result.backup_path && fs.existsSync(result.backup_path), 'backup file was written');
    assert.equal(fs.existsSync(filePath), false, 'source file parked');
    // Archive JSONL must exist and contain one line
    const archive = path.join(ws.dir, '.brainclaw', 'coordination', 'handoffs', 'compacted.jsonl');
    assert.ok(fs.existsSync(archive));
  });

  it('leaves human-authored handoffs alone', () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const filePath = writeAutoHandoff(ws, 'hnd_human', 'closed', old, false);
    const result = parkClosedAutoHandoffs(ws.dir, 30, false);
    assert.equal(result.parked, 0);
    assert.ok(fs.existsSync(filePath), 'human handoff preserved');
  });

  it('leaves open handoffs alone regardless of age', () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    writeAutoHandoff(ws, 'hnd_open', 'open', old, true);
    const result = parkClosedAutoHandoffs(ws.dir, 30, false);
    assert.equal(result.parked, 0);
  });

  it('dryRun reports candidates without mutating', () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const filePath = writeAutoHandoff(ws, 'hnd_dry', 'closed', old, true);
    const result = parkClosedAutoHandoffs(ws.dir, 30, true);
    assert.equal(result.candidates, 1);
    assert.equal(result.parked, 0);
    assert.ok(fs.existsSync(filePath), 'dryRun preserves source');
  });
});

// ── runHygieneReport ─────────────────────────────────────────────

describe('runHygieneReport', () => {
  it('reports counts per family without mutating state', () => {
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    mkOfferedAssignment(ws, generateId('assignments'), stale);
    mkOfferedAssignment(ws, generateId('assignments'), nowISO()); // fresh
    const report = runHygieneReport({ cwd: ws.dir });
    assert.equal(report.disabled, false);
    assert.ok(report.families.assignments.total_open >= 2);
    assert.ok(report.families.assignments.offered_park_candidates >= 1);
    // Fresh offered must NOT be a park candidate
    assert.ok(report.families.assignments.offered_park_candidates < report.families.assignments.offered);
  });

  it('carries the policy so operators can see current thresholds', () => {
    const report = runHygieneReport({ cwd: ws.dir });
    assert.ok(report.policy.assignment_offered_ttl_ms > 0);
    assert.ok(report.policy.stale_warning_serve_k >= 1);
  });
});

// ── ServeStats helper ────────────────────────────────────────────

describe('computeServeStats', () => {
  it('returns zeros on an empty registry', () => {
    const stats = computeServeStats({}, 3);
    assert.equal(stats.total, 0);
    assert.equal(stats.over_threshold, 0);
  });

  it('counts items over threshold and produces a median count', () => {
    const stats = computeServeStats({
      a: { count: 1, first_at: '2026-01-01', last_at: '2026-01-01' },
      b: { count: 4, first_at: '2026-01-01', last_at: '2026-01-01' },
      c: { count: 5, first_at: '2026-01-01', last_at: '2026-01-01' },
    }, 3);
    assert.equal(stats.total, 3);
    assert.equal(stats.over_threshold, 2);
    assert.equal(stats.median_count, 4);
  });
});

// ── Codex PR#48 review — regression coverage for the 4 findings ───

/** Append a raw YAML block at the config root (valid for top-level keys). */
function appendConfigYaml(dir: string, block: string): void {
  const cfgPath = path.join(dir, '.brainclaw', 'config.yaml');
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  fs.writeFileSync(cfgPath, `${raw.trimEnd()}\n${block}\n`, 'utf-8');
}

describe('loadHygienePolicy — config overrides (finding 1: HygieneConfigSchema)', () => {
  it('applies a valid config.hygiene override instead of stripping it', () => {
    appendConfigYaml(ws.dir, 'hygiene:\n  disabled: true\n  assignment_offered_ttl_ms: 60000');
    const p = loadHygienePolicy(ws.dir);
    assert.equal(p.disabled, true, 'disabled override now reaches the policy');
    assert.equal(p.assignment_offered_ttl_ms, 60000, 'TTL override now reaches the policy');
    // Untouched fields keep their defaults (partial override).
    assert.equal(p.stale_warning_serve_k, DEFAULT_HYGIENE_POLICY.stale_warning_serve_k);
  });

  it('ignores an unknown/typo hygiene key and keeps the default', () => {
    // _ttl_m instead of _ttl_ms — stripped by the schema, must fall back.
    appendConfigYaml(ws.dir, 'hygiene:\n  assignment_offered_ttl_m: 999');
    const p = loadHygienePolicy(ws.dir);
    assert.equal(p.assignment_offered_ttl_ms, DEFAULT_HYGIENE_POLICY.assignment_offered_ttl_ms);
  });
});

describe('sweepAssignmentsFromList — family TTL from policy (finding 2)', () => {
  it('does NOT sweep a 20-min offered assignment when the policy family TTL is one day', () => {
    const offeredAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const a = mkOfferedAssignment(ws, generateId('assignments'), offeredAt);
    const r = sweepAssignmentsFromList([a], ws.dir, { actor: 'test', policy: DEFAULT_HYGIENE_POLICY });
    assert.equal(r.expired.length, 0, 'not expired under the one-day offered family TTL');
    assert.equal(r.implicitly_advanced.length, 0);
    assert.equal(loadAssignment(a.id, ws.dir)!.status, 'offered', 'stays offered');
  });

  it('expires a never-accepted offered assignment after one day by default', () => {
    const offeredAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const a = mkOfferedAssignment(ws, generateId('assignments'), offeredAt);
    const r = sweepAssignmentsFromList([a], ws.dir, { actor: 'test', policy: DEFAULT_HYGIENE_POLICY });
    assert.equal(r.expired.length, 1);
    assert.equal(loadAssignment(a.id, ws.dir)!.status, 'expired');
    assert.equal(sweepAssignmentsFromList([loadAssignment(a.id, ws.dir)!], ws.dir, { actor: 'test', policy: DEFAULT_HYGIENE_POLICY }).expired.length, 0);
  });

  it('DOES expire a 20-min offered assignment without a policy (embedded 15-min acceptance TTL — convergence sweep unchanged)', () => {
    const offeredAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const a = mkOfferedAssignment(ws, generateId('assignments'), offeredAt);
    const r = sweepAssignmentsFromList([a], ws.dir, { actor: 'test' });
    assert.equal(r.expired.length, 1, 'expired under the embedded 15-min convergence TTL');
    assert.equal(loadAssignment(a.id, ws.dir)!.status, 'expired');
  });
});

describe('selectReadPathSweepCandidates — hot-path zero-read guard (finding 3)', () => {
  it('never selects a healthy created assignment (no heartbeat) → zero full loads', () => {
    const projections = [
      { id: 'asgn_created_1', status: 'created' as const },
      { id: 'asgn_created_2', status: 'created' as const },
    ];
    const ids = selectReadPathSweepCandidates(projections, DEFAULT_HYGIENE_POLICY, Date.now());
    assert.deepEqual(ids, [], 'created rows are dropped before any loadAssignment');
  });

  it('selects only stale sweepable statuses and respects the budget', () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const projections = [
      { id: 'asgn_off', status: 'offered', last_heartbeat_at: old },
      { id: 'asgn_acc', status: 'accepted', last_heartbeat_at: old },
      { id: 'asgn_done', status: 'completed', last_heartbeat_at: old }, // terminal → skip
      { id: 'asgn_created', status: 'created' }, // no heartbeat but not sweepable → skip
    ];
    const policy: HygienePolicy = { ...DEFAULT_HYGIENE_POLICY, read_path_sweep_budget: 1 };
    const ids = selectReadPathSweepCandidates(projections, policy, Date.now());
    assert.equal(ids.length, 1, 'budget respected');
    assert.ok(ids[0] === 'asgn_off' || ids[0] === 'asgn_acc', 'only a stale sweepable status selected');
  });

  it('disabled policy selects nothing', () => {
    const projections = [{ id: 'asgn_x', status: 'offered' }];
    const ids = selectReadPathSweepCandidates(projections, { ...DEFAULT_HYGIENE_POLICY, disabled: true }, Date.now());
    assert.deepEqual(ids, []);
  });
});

describe('parkClosedAutoHandoffs — idempotent under partial failure (finding 4)', () => {
  it('does not append a duplicate compacted record if a source could not be unlinked', () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeAutoHandoff(ws, 'hnd_dup', 'closed', old, true);
    const archive = path.join(ws.dir, '.brainclaw', 'coordination', 'handoffs', 'compacted.jsonl');

    // First pass parks cleanly.
    const first = parkClosedAutoHandoffs(ws.dir, 30, false);
    assert.equal(first.parked, 1);
    const linesAfterFirst = fs.readFileSync(archive, 'utf-8').trim().split('\n').length;
    assert.equal(linesAfterFirst, 1, 'one compacted record after the first pass');

    // Second pass: source is gone → nothing re-parked, no duplicate record.
    const second = parkClosedAutoHandoffs(ws.dir, 30, false);
    assert.equal(second.parked, 0, 'no re-park once the source is gone');
    const linesAfterSecond = fs.readFileSync(archive, 'utf-8').trim().split('\n').length;
    assert.equal(linesAfterSecond, 1, 'compacted log did not gain a duplicate');
  });
});
