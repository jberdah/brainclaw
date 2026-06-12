import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, loadState, persistState } from '../../src/core/state.js';
import { PlanItemSchema, type PlanItem, type PlanStep } from '../../src/core/schema.js';
import { addStep, updateStep, completeStep } from '../../src/core/operations/plan.js';
import { buildEstimationReport } from '../../src/commands/estimation-report.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;
beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-stepest-', projectId: 'prj_stepest', currentAgent: 'tester' }); });
afterEach(() => { ws.cleanup(); });

function step(over: Partial<PlanStep> & { id: string }): PlanStep {
  return { text: over.id, status: 'done', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...over };
}

function persistDonePlan(id: string, over: Partial<PlanItem>): void {
  const state = emptyState();
  const plan = PlanItemSchema.parse({
    id, short_label: id.replace('pln_', 'pln#'), text: `plan ${id}`, type: 'feat',
    status: 'done', priority: 'medium', author: 'tester', tags: [],
    created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T14:30:00.000Z',
    started_at: '2026-01-01T10:00:00.000Z', completed_at: '2026-01-01T14:30:00.000Z', // 270min wall-clock
    ...over,
  });
  state.plan_items.push(plan);
  persistState(state, ws.dir);
}

describe('step-level effort estimation — aggregation (pln#495)', () => {
  it('sums per-step durations and EXCLUDES inter-step idle (the core win)', () => {
    // Two 30-min steps with a 3.5h idle gap between them. Plan wall-clock = 270min;
    // the honest work is 60min. Step-level must report 60, not 270.
    persistDonePlan('pln_idle', {
      estimated_effort: 60,
      steps: [
        step({ id: 'a', started_at: '2026-01-01T10:00:00.000Z', completed_at: '2026-01-01T10:30:00.000Z' }),
        step({ id: 'b', started_at: '2026-01-01T14:00:00.000Z', completed_at: '2026-01-01T14:30:00.000Z' }),
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_idle')!;
    assert.equal(e.source, 'step');
    assert.equal(e.elapsed_minutes, 60, 'step-sum excludes the 3.5h idle gap');
    assert.equal(e.estimated_minutes, 60);
    assert.equal(e.ratio, 1);
  });

  it('prefers sum-of-step-estimates when ALL steps carry one', () => {
    persistDonePlan('pln_est', {
      estimated_effort: 999, // plan-level should be IGNORED in favor of the step sum
      steps: [
        step({ id: 'a', estimated_effort: 20, actual_effort: '20m' }),
        step({ id: 'b', estimated_effort: 40, actual_effort: '40m' }),
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_est')!;
    assert.equal(e.estimated_minutes, 60, 'sum of step estimates, not the 999 plan-level');
    assert.equal(e.elapsed_minutes, 60); // 20m + 40m
    assert.equal(e.source, 'step');
  });

  it('explicit step.actual_effort strings are summed (source=step)', () => {
    persistDonePlan('pln_actstr', {
      estimated_effort: 100,
      steps: [
        step({ id: 'a', actual_effort: '1h' }),
        step({ id: 'b', actual_effort: '30m' }),
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_actstr')!;
    assert.equal(e.elapsed_minutes, 90);
    assert.equal(e.source, 'step');
  });

  it('MIXED plan (one step estimated, one not) falls back to plan-level estimate, not a partial sum', () => {
    persistDonePlan('pln_mixed', {
      estimated_effort: 200,
      actual_effort: '3h',
      steps: [
        step({ id: 'a', estimated_effort: 20, actual_effort: '20m' }),
        step({ id: 'b' }), // no estimate, no actual, no timestamps
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_mixed')!;
    assert.equal(e.estimated_minutes, 200, 'mixed → plan-level estimate, never a half-sum');
    assert.equal(e.elapsed_minutes, 180, 'actual falls back to plan.actual_effort "3h"');
    assert.equal(e.source, 'plan_string');
  });

  it('legacy plan with no step data → plan wall-clock, source=plan_wallclock', () => {
    persistDonePlan('pln_legacy', { estimated_effort: 120 }); // no steps, no actual_effort
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_legacy')!;
    assert.equal(e.source, 'plan_wallclock');
    assert.equal(e.elapsed_minutes, 270); // the full wall-clock span
  });

  it('by_source summary buckets ratios per measurement quality', () => {
    persistDonePlan('pln_s', { estimated_effort: 60, steps: [step({ id: 'a', estimated_effort: 60, actual_effort: '1h' })] });
    // second plan, legacy wall-clock — persist both into the same store
    const state = loadState(ws.dir);
    state.plan_items.push(PlanItemSchema.parse({
      id: 'pln_w', short_label: 'pln#w', text: 'wallclock plan', type: 'feat', status: 'done',
      priority: 'medium', author: 'tester', tags: [], estimated_effort: 120,
      created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T14:30:00.000Z',
      started_at: '2026-01-01T10:00:00.000Z', completed_at: '2026-01-01T14:30:00.000Z',
    }));
    persistState(state, ws.dir);

    const bySource = buildEstimationReport({ cwd: ws.dir }).summary.by_source!;
    assert.ok(bySource.step, 'step bucket present');
    assert.equal(bySource.step!.count, 1);
    assert.equal(bySource.step!.median_ratio, 1); // 60/60
    assert.ok(bySource.plan_wallclock, 'wallclock bucket present');
    assert.equal(bySource.plan_wallclock!.median_ratio, 0.44); // 120/270
  });

  it('falls back to plan actual_effort when a step duration is negative or zero', () => {
    persistDonePlan('pln_bad_duration', {
      estimated_effort: 60,
      actual_effort: '45m',
      steps: [
        step({ id: 'negative', started_at: '2026-01-01T11:00:00.000Z', completed_at: '2026-01-01T10:00:00.000Z' }),
      ],
    });
    persistDonePlan('pln_zero_duration', {
      estimated_effort: 60,
      actual_effort: '30m',
      steps: [
        step({ id: 'zero', started_at: '2026-01-01T10:00:00.000Z', completed_at: '2026-01-01T10:00:00.000Z' }),
      ],
    });

    const entries = buildEstimationReport({ cwd: ws.dir }).entries;
    const negative = entries.find(x => x.id === 'pln_bad_duration')!;
    assert.equal(negative.elapsed_minutes, 45);
    assert.equal(negative.source, 'plan_string');
    const zero = entries.find(x => x.id === 'pln_zero_duration')!;
    assert.equal(zero.elapsed_minutes, 30);
    assert.equal(zero.source, 'plan_string');
  });

  it('falls back to plan actual_effort when a step actual_effort string is unparseable', () => {
    persistDonePlan('pln_unparseable_step_actual', {
      estimated_effort: 120,
      actual_effort: '2h',
      steps: [
        step({ id: 'a', actual_effort: '3-4 sessions' }),
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_unparseable_step_actual')!;
    assert.equal(e.elapsed_minutes, 120);
    assert.equal(e.source, 'plan_string');
  });

  it('falls back to plan actual_effort when a direct todo→done step has no measurable duration', () => {
    persistDonePlan('pln_direct_done', {
      estimated_effort: 30,
      actual_effort: '25m',
      steps: [
        step({ id: 'a', completed_at: '2026-01-01T10:25:00.000Z' }),
      ],
    });
    const e = buildEstimationReport({ cwd: ws.dir }).entries.find(x => x.id === 'pln_direct_done')!;
    assert.equal(e.elapsed_minutes, 25);
    assert.equal(e.source, 'plan_string');
  });
});

describe('step-level effort estimation — lifecycle timestamps (pln#495)', () => {
  function seedPlanWithStep(): { planId: string; stepId: string } {
    const state = emptyState();
    state.plan_items.push(PlanItemSchema.parse({
      id: 'pln_lc', short_label: 'pln#lc', text: 'lifecycle', type: 'feat', status: 'in_progress',
      priority: 'medium', author: 'tester', tags: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }));
    persistState(state, ws.dir);
    const r = addStep({ planId: 'pln_lc', text: 'do a thing', estimatedEffort: 30 }, ws.dir);
    return { planId: 'pln_lc', stepId: r.stepId };
  }

  it('addStep records estimated_effort', () => {
    const { stepId } = seedPlanWithStep();
    const stepDoc = loadState(ws.dir).plan_items[0].steps!.find(s => s.id === stepId)!;
    assert.equal(stepDoc.estimated_effort, 30);
    assert.equal(stepDoc.started_at, undefined); // todo, not started
  });

  it('addStep duration-string estimated_effort survives reload as minutes', () => {
    const state = emptyState();
    state.plan_items.push(PlanItemSchema.parse({
      id: 'pln_string_est', short_label: 'pln#se', text: 'string estimate', type: 'feat', status: 'in_progress',
      priority: 'medium', author: 'tester', tags: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }));
    persistState(state, ws.dir);
    const r = addStep({ planId: 'pln_string_est', text: 'estimated by string', estimatedEffort: '2h' }, ws.dir);
    const stepDoc = loadState(ws.dir).plan_items[0].steps!.find(s => s.id === r.stepId)!;
    assert.equal(stepDoc.estimated_effort, 120);
  });

  it('updateStep→in_progress stamps started_at; →done stamps completed_at', () => {
    const { planId, stepId } = seedPlanWithStep();
    updateStep({ planId, stepId, status: 'in_progress' }, ws.dir);
    let s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === stepId)!;
    assert.ok(s.started_at, 'started_at set on in_progress');
    assert.equal(s.completed_at, undefined);

    updateStep({ planId, stepId, status: 'done' }, ws.dir);
    s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === stepId)!;
    assert.ok(s.completed_at, 'completed_at set on done');
  });

  it('updateStep todo→done stamps both lifecycle endpoints', () => {
    const { planId, stepId } = seedPlanWithStep();
    updateStep({ planId, stepId, status: 'done' }, ws.dir);
    const s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === stepId)!;
    assert.ok(s.started_at, 'started_at set by direct done');
    assert.ok(s.completed_at, 'completed_at set by direct done');
  });

  it('completeStep stamps both lifecycle endpoints even when never marked in_progress', () => {
    const { planId, stepId } = seedPlanWithStep();
    completeStep({ planId, stepId }, ws.dir);
    const s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === stepId)!;
    assert.ok(s.started_at, 'started_at set by completeStep');
    assert.ok(s.completed_at, 'completed_at set by completeStep');
  });

  it('reopened steps clear stale completion and restamp on re-completion', () => {
    const state = emptyState();
    state.plan_items.push(PlanItemSchema.parse({
      id: 'pln_reopen', short_label: 'pln#ro', text: 'reopen', type: 'feat', status: 'in_progress',
      priority: 'medium', author: 'tester', tags: [],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      steps: [
        step({
          id: 'stp_reopen',
          status: 'done',
          started_at: '2026-01-01T10:00:00.000Z',
          completed_at: '2026-01-01T10:30:00.000Z',
        }),
      ],
    }));
    persistState(state, ws.dir);

    updateStep({ planId: 'pln_reopen', stepId: 'stp_reopen', status: 'in_progress' }, ws.dir);
    let s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === 'stp_reopen')!;
    assert.notEqual(s.started_at, '2026-01-01T10:00:00.000Z');
    assert.equal(s.completed_at, undefined);

    updateStep({ planId: 'pln_reopen', stepId: 'stp_reopen', status: 'done' }, ws.dir);
    s = loadState(ws.dir).plan_items[0].steps!.find(x => x.id === 'stp_reopen')!;
    assert.ok(s.completed_at, 'completed_at set again after reopen');
    assert.notEqual(s.completed_at, '2026-01-01T10:30:00.000Z');
  });
});
