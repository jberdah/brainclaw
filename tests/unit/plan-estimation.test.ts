import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseEffortMinutes, buildEstimationReport, renderRatioBar, buildCalibrationHint } from '../../src/commands/estimation-report.js';
import { runPlan } from '../../src/commands/plan.js';
import { runUpdatePlan } from '../../src/commands/update-plan.js';
import { loadState } from '../../src/core/state.js';
import { PlanItemSchema } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// --- parseEffortMinutes (still used for actual_effort strings) ---

describe('parseEffortMinutes', () => {
  it('parses minutes: "30min"', () => assert.equal(parseEffortMinutes('30min'), 30));
  it('parses minutes: "45m"', () => assert.equal(parseEffortMinutes('45m'), 45));
  it('parses hours: "2h"', () => assert.equal(parseEffortMinutes('2h'), 120));
  it('parses hours+minutes: "1h30m"', () => assert.equal(parseEffortMinutes('1h30m'), 90));
  it('parses days: "1d"', () => assert.equal(parseEffortMinutes('1d'), 480));
  it('parses bare number as minutes', () => assert.equal(parseEffortMinutes('20'), 20));
  it('returns undefined for garbage', () => assert.equal(parseEffortMinutes('abc'), undefined));
  it('parses fractional hours: "0.5h"', () => assert.equal(parseEffortMinutes('0.5h'), 30));
  it('handles spaces: "1 h 30 min"', () => assert.equal(parseEffortMinutes('1 h 30 min'), 90));
});

// --- PlanItemSchema coercion (legacy string → integer minutes) ---

describe('PlanItemSchema estimated_effort coercion', () => {
  const base = {
    id: 'pln_test', text: 't', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', author: 'a', status: 'todo' as const,
    priority: 'medium' as const, tags: [], depends_on: [],
  };

  it('accepts integer directly', () => {
    const p = PlanItemSchema.parse({ ...base, estimated_effort: 30 });
    assert.equal(p.estimated_effort, 30);
  });

  it('coerces legacy "30min" string to 30', () => {
    const p = PlanItemSchema.parse({ ...base, estimated_effort: '30min' });
    assert.equal(p.estimated_effort, 30);
  });

  it('coerces legacy "2h" string to 120', () => {
    const p = PlanItemSchema.parse({ ...base, estimated_effort: '2h' });
    assert.equal(p.estimated_effort, 120);
  });

  it('coerces legacy "1d" string to 480', () => {
    const p = PlanItemSchema.parse({ ...base, estimated_effort: '1d' });
    assert.equal(p.estimated_effort, 480);
  });

  it('drops unparseable strings like "3-4 sessions"', () => {
    const p = PlanItemSchema.parse({ ...base, estimated_effort: '3-4 sessions' });
    assert.equal(p.estimated_effort, undefined);
  });

  it('accepts undefined', () => {
    const p = PlanItemSchema.parse({ ...base });
    assert.equal(p.estimated_effort, undefined);
  });
});

// --- renderRatioBar ---

describe('renderRatioBar', () => {
  it('produces a bar of the correct width', () => {
    assert.equal(renderRatioBar(1.0).length, 40);
    assert.equal(renderRatioBar(0.5).length, 40);
  });

  it('fills half the bar at ratio 0.5', () => {
    const bar = renderRatioBar(0.5, 40);
    const filled = [...bar].filter(c => c === '█').length;
    assert.equal(filled, 10); // 0.5 * 20 = 10
  });

  it('fills full bar beyond 2.0x (capped at width)', () => {
    const bar = renderRatioBar(3.0, 40);
    assert.ok(![...bar].some(c => c === '░'), 'should have no empty chars at 3.0x');
  });

  it('places separator │ at pivot when ratio < 1.0', () => {
    const bar = renderRatioBar(0.2, 40);
    assert.ok(bar.includes('│'), 'should include pivot marker');
  });

  it('ratio 1.0 fills exactly half', () => {
    const bar = renderRatioBar(1.0, 40);
    const filled = [...bar].filter(c => c === '█').length;
    assert.equal(filled, 20);
  });
});

// --- buildCalibrationHint ---

describe('buildCalibrationHint', () => {
  it('suggests padding when ratio < 0.8', () => {
    assert.ok(buildCalibrationHint(0.6).includes('underestimate'));
  });
  it('reports well-calibrated near 1.0', () => {
    assert.ok(buildCalibrationHint(1.0).includes('calibrated'));
  });
  it('reports overestimate above 1.25', () => {
    assert.ok(buildCalibrationHint(1.5).includes('overestimate'));
  });
});

// --- buildEstimationReport ---

describe('buildEstimationReport', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  before(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-estimation-', currentAgent: 'test-agent' });
    restoreCwd = workspace.useCwd();
  });

  after(() => {
    restoreCwd();
    workspace.cleanup();
  });

  it('returns empty report when no completed plans', () => {
    const report = buildEstimationReport({ cwd: workspace.dir });
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.with_estimate, 0);
    assert.equal(report.summary.with_both, 0);
    assert.equal(report.summary.median_ratio, undefined);
    assert.equal(report.summary.calibration_hint, undefined);
  });

  it('stores estimated_effort as integer minutes on plan creation', () => {
    runPlan('task with estimate', { estimate: 30 });
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'task with estimate');
    assert.ok(plan, 'plan should exist');
    assert.equal(plan!.estimated_effort, 30);
  });

  it('sets completed_at when marking plan done', () => {
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'task with estimate');
    assert.ok(plan);
    runUpdatePlan(plan!.id, { status: 'done' });
    const updated = loadState(workspace.dir).plan_items.find((p) => p.id === plan!.id);
    assert.ok(updated!.completed_at, 'completed_at should be set');
  });

  it('stores actual_effort string when provided', () => {
    runPlan('task with actual', { estimate: 60 });
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'task with actual');
    assert.ok(plan);
    runUpdatePlan(plan!.id, { status: 'done', actualEffort: '20min' });
    const updated = loadState(workspace.dir).plan_items.find((p) => p.id === plan!.id);
    assert.equal(updated!.actual_effort, '20min');
  });

  it('sets started_at on first in_progress transition', () => {
    runPlan('task in progress', {});
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'task in progress');
    assert.ok(plan);
    assert.equal(plan!.started_at, undefined);
    runUpdatePlan(plan!.id, { status: 'in_progress' });
    const updated = loadState(workspace.dir).plan_items.find((p) => p.id === plan!.id);
    assert.ok(updated!.started_at, 'started_at should be set');
  });

  it('does not overwrite started_at on subsequent updates', () => {
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'task in progress');
    assert.ok(plan);
    const firstStarted = plan!.started_at;
    runUpdatePlan(plan!.id, { status: 'in_progress' });
    const updated = loadState(workspace.dir).plan_items.find((p) => p.id === plan!.id);
    assert.equal(updated!.started_at, firstStarted);
  });

  it('computes ratio=3 when est=60min actual=20min', () => {
    const report = buildEstimationReport({ cwd: workspace.dir });
    const entry = report.entries.find((e) => e.text === 'task with actual');
    assert.ok(entry, 'should find entry');
    assert.ok(entry!.ratio !== undefined, 'ratio should be defined');
    assert.equal(entry!.ratio, 3);
  });

  it('includes calibration_hint once >= 3 plans have both estimate and actual', () => {
    for (const t of ['extra a', 'extra b']) {
      runPlan(t, { estimate: 30 });
      const s = loadState(workspace.dir);
      const p = s.plan_items.find((x) => x.text === t);
      runUpdatePlan(p!.id, { status: 'done', actualEffort: '15min' });
    }
    const report = buildEstimationReport({ cwd: workspace.dir });
    assert.ok(report.summary.with_both >= 3, 'should have at least 3 plans with both');
    assert.ok(report.summary.calibration_hint, 'calibration_hint should be present');
  });

  it('filters by agent name', () => {
    runPlan('other agent task', { author: 'other-agent' });
    const state = loadState(workspace.dir);
    const plan = state.plan_items.find((p) => p.text === 'other agent task');
    runUpdatePlan(plan!.id, { status: 'done' });

    const report = buildEstimationReport({ agent: 'other-agent', cwd: workspace.dir });
    assert.equal(report.summary.total, 1);
    assert.equal(report.entries[0]!.author, 'other-agent');
  });
});
