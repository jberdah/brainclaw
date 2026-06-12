import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import type { PlanItem } from '../core/schema.js';

export interface EstimationReportOptions {
  agent?: string;
  json?: boolean;
  cwd?: string;
}

/**
 * How a plan's `actual` measurement was derived (pln#495). 'step' is the
 * highest-quality: the sum of per-step durations, which excludes the inter-step
 * idle gaps that smear plan-level wall-clock. 'plan_wallclock' is the noisiest.
 */
export type EstimationSource = 'step' | 'plan_string' | 'plan_wallclock';

export interface PlanEstimationEntry {
  id: string;
  text: string;
  author: string;
  estimated_minutes?: number;
  actual_effort?: string;
  elapsed_minutes?: number;
  ratio?: number;
  completed_at?: string;
  /** Provenance of elapsed_minutes — the measurement-quality tag (pln#495). */
  source?: EstimationSource;
}

export interface EstimationReportResult {
  entries: PlanEstimationEntry[];
  summary: {
    total: number;
    with_estimate: number;
    with_both: number;
    median_ratio?: number;
    mean_ratio?: number;
    calibration_hint?: string;
    /** Median ratio per measurement source — shows how much noise is wall-clock contamination. */
    by_source?: Partial<Record<EstimationSource, { count: number; median_ratio: number }>>;
  };
}

/**
 * Sum of per-step estimates — only when EVERY step carries one. A mixed plan
 * (some steps estimated, some not) returns undefined so the caller falls back
 * to the plan-level estimate rather than mixing half-measured data (pln#495).
 */
function sumStepEstimates(plan: PlanItem): number | undefined {
  const steps = plan.steps ?? [];
  if (steps.length === 0) return undefined;
  if (!steps.every((s) => typeof s.estimated_effort === 'number')) return undefined;
  return steps.reduce((acc, s) => acc + (s.estimated_effort as number), 0);
}

/**
 * Sum of per-step actual durations — only when EVERY step is measurable, via an
 * explicit `actual_effort` string OR both `started_at`+`completed_at`. Returns
 * undefined otherwise (→ fall back to plan-level). This is the key win: summing
 * per-step durations excludes the idle time BETWEEN steps that plan-level
 * wall-clock wrongly counts as work (pln#495, the pln#494 step-6 bias).
 */
function sumStepActuals(plan: PlanItem): number | undefined {
  const steps = plan.steps ?? [];
  if (steps.length === 0) return undefined;
  let total = 0;
  for (const s of steps) {
    let dur: number | undefined;
    if (s.actual_effort) {
      dur = parseEffortMinutes(s.actual_effort);
    } else if (s.started_at && s.completed_at) {
      const d = (new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 60000;
      dur = d > 0 ? d : undefined;
    }
    if (dur === undefined) return undefined; // any unmeasurable step → no step-level actual
    total += dur;
  }
  return total > 0 ? total : undefined;
}

/** Parse legacy actual_effort strings ("30min", "2h", "1h30m", "1d", "45m") → minutes.
 *  Still needed for actual_effort which remains a free string. */
export function parseEffortMinutes(effort: string): number | undefined {
  const s = effort.trim().toLowerCase();
  let total = 0;
  let matched = false;

  const days = s.match(/(\d+(?:\.\d+)?)\s*d/);
  if (days) { total += parseFloat(days[1]!) * 8 * 60; matched = true; }

  const hours = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hours) { total += parseFloat(hours[1]!) * 60; matched = true; }

  const mins = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
  if (mins) { total += parseFloat(mins[1]!); matched = true; }

  if (!matched) {
    const bare = parseFloat(s);
    if (!isNaN(bare) && /^\d+(?:\.\d+)?$/.test(s)) return bare;
    return undefined;
  }
  return total > 0 ? total : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildCalibrationHint(medianRatio: number): string {
  if (medianRatio < 0.5) return `You tend to underestimate by ~${(1 / medianRatio).toFixed(1)}x — pad estimates up`;
  if (medianRatio < 0.8) return `You slightly underestimate — add ~${Math.round((1 - medianRatio) * 100)}% to estimates`;
  if (medianRatio <= 1.25) return 'Estimates are well-calibrated';
  if (medianRatio <= 2.0) return `You tend to overestimate by ~${medianRatio.toFixed(1)}x — cut estimates by ~${Math.round((1 - 1 / medianRatio) * 100)}%`;
  return `You significantly overestimate by ~${medianRatio.toFixed(1)}x — estimates should be ~${medianRatio.toFixed(1)}x smaller`;
}

/** Render a ratio bar (40 chars wide, 1.0x at the midpoint). */
export function renderRatioBar(ratio: number, width = 40): string {
  const pivot = Math.floor(width / 2); // position of 1.0x
  const filled = Math.min(Math.round(ratio * pivot), width);
  const bar = Array.from({ length: width }, (_, i) => {
    if (i < filled) return '█';
    if (i === pivot && filled < pivot) return '│';
    return '░';
  }).join('');
  return bar;
}

export function buildEstimationReport(options: EstimationReportOptions = {}): EstimationReportResult {
  const state = loadState(options.cwd);
  const done = state.plan_items.filter((p: PlanItem) =>
    p.status === 'done' && (!options.agent || p.author === options.agent)
  );

  const entries: PlanEstimationEntry[] = done.map((p: PlanItem) => {
    // Estimate: prefer the sum of per-step estimates when ALL steps carry one,
    // else the plan-level estimate (pln#495).
    const stepEstimate = sumStepEstimates(p);
    const entry: PlanEstimationEntry = {
      id: p.id,
      text: p.text,
      author: p.author,
      estimated_minutes: stepEstimate ?? p.estimated_effort,
      actual_effort: p.actual_effort,
      completed_at: p.completed_at,
    };

    // Actual + source, in fallback order (pln#495):
    //   step durations (idle-gap-free) > plan.actual_effort string > plan wall-clock.
    let actualMinutes: number | undefined;
    let source: EstimationSource;
    const stepActual = sumStepActuals(p);
    if (stepActual !== undefined) {
      actualMinutes = stepActual;
      source = 'step';
    } else if (p.actual_effort) {
      actualMinutes = parseEffortMinutes(p.actual_effort);
      source = 'plan_string';
    } else {
      const endTime = p.completed_at ?? p.updated_at;
      const startTime = p.started_at ?? p.created_at;
      if (endTime && startTime) {
        const elapsed = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000;
        if (elapsed > 0) actualMinutes = elapsed;
      }
      source = 'plan_wallclock';
    }

    if (actualMinutes !== undefined) {
      entry.elapsed_minutes = Math.round(actualMinutes);
      entry.source = source;
    }

    if (entry.estimated_minutes !== undefined && actualMinutes !== undefined && actualMinutes > 0) {
      entry.ratio = parseFloat((entry.estimated_minutes / actualMinutes).toFixed(2));
    }

    return entry;
  });

  const withBoth = entries.filter((e) => e.ratio !== undefined);
  const ratios = withBoth.map((e) => e.ratio as number);

  const medianRatio = ratios.length > 0 ? parseFloat(median(ratios).toFixed(2)) : undefined;
  const meanRatio = ratios.length > 0 ? parseFloat(mean(ratios).toFixed(2)) : undefined;

  // Per-source median (pln#495): exposes how much calibration noise is wall-clock
  // contamination vs idle-gap-free step measurement.
  const bySource: Partial<Record<EstimationSource, { count: number; median_ratio: number }>> = {};
  for (const src of ['step', 'plan_string', 'plan_wallclock'] as const) {
    const srcRatios = withBoth.filter((e) => e.source === src).map((e) => e.ratio as number);
    if (srcRatios.length > 0) {
      bySource[src] = { count: srcRatios.length, median_ratio: parseFloat(median(srcRatios).toFixed(2)) };
    }
  }

  return {
    entries,
    summary: {
      total: entries.length,
      with_estimate: entries.filter((e) => e.estimated_minutes !== undefined).length,
      with_both: withBoth.length,
      median_ratio: medianRatio,
      mean_ratio: meanRatio,
      calibration_hint: medianRatio !== undefined ? buildCalibrationHint(medianRatio) : undefined,
      by_source: Object.keys(bySource).length > 0 ? bySource : undefined,
    },
  };
}

export function runEstimationReport(options: EstimationReportOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const report = buildEstimationReport(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { summary, entries } = report;

  if (summary.total === 0) {
    console.log('No completed plans found.');
    return;
  }

  console.log(`\nEstimation Report — ${summary.total} completed plan(s)`);
  console.log(`With estimates: ${summary.with_estimate} · With both: ${summary.with_both}`);

  if (summary.median_ratio !== undefined) {
    console.log(`\nMedian ratio (estimated÷actual): ${summary.median_ratio}x · Mean: ${summary.mean_ratio}x`);
    console.log(`→ ${summary.calibration_hint}`);
  }

  if (summary.by_source) {
    const labels: Record<EstimationSource, string> = {
      step: 'step-derived', plan_string: 'plan-string', plan_wallclock: 'plan-wallclock',
    };
    const parts = (['step', 'plan_string', 'plan_wallclock'] as const)
      .filter((s) => summary.by_source![s])
      .map((s) => `${labels[s]}: ${summary.by_source![s]!.median_ratio}x (n=${summary.by_source![s]!.count})`);
    console.log(`By measurement quality — ${parts.join(' · ')}`);
    console.log('  (step-derived excludes inter-step idle; plan-wallclock is the noisiest)');
  }

  // Chart — only plans with ratio data
  const chartable = entries.filter((e) => e.ratio !== undefined);
  if (chartable.length > 0) {
    console.log('\n— Accuracy chart (ratio = estimated ÷ actual) —');
    console.log('  < 1.0 = went over estimate   │   > 1.0 = finished early\n');

    // Header scale
    const W = 40;
    const pivot = W / 2;
    const scaleTop  = '  ' + '0.0x' + ' '.repeat(pivot - 4) + '1.0x' + ' '.repeat(W - pivot - 4) + '2.0x+';
    const scaleLine = '  ├' + '─'.repeat(pivot - 1) + '┼' + '─'.repeat(W - pivot - 1) + '┤';
    console.log(scaleTop);
    console.log(scaleLine);

    for (const e of chartable) {
      const label = (e.text.length > 35 ? e.text.slice(0, 32) + '…' : e.text).padEnd(35);
      const bar = renderRatioBar(e.ratio!);
      const pct = e.ratio! >= 1
        ? ` EARLY -${Math.round((1 - 1 / e.ratio!) * 100)}%`
        : ` OVER  +${Math.round((1 / e.ratio! - 1) * 100)}%`;
      const est = e.estimated_minutes !== undefined ? `${e.estimated_minutes}min` : '?';
      const act = e.elapsed_minutes !== undefined ? `${e.elapsed_minutes}min` : '?';
      const srcTag = e.source === 'step' ? ' ✓step' : e.source === 'plan_wallclock' ? ' ~wall' : '';
      console.log(`  ${label} ${bar} ${e.ratio}x  ${est}→${act}${pct}${srcTag}`);
    }
    console.log('');
  }

  // Detail table for plans with estimate but no actual
  const estimateOnly = entries.filter((e) => e.estimated_minutes !== undefined && e.ratio === undefined);
  if (estimateOnly.length > 0) {
    console.log('— Estimated but no elapsed time —');
    for (const e of estimateOnly) {
      const short = e.text.length > 60 ? e.text.slice(0, 57) + '…' : e.text;
      console.log(`  [${e.id.slice(-8)}] ${short} — est:${e.estimated_minutes}min`);
    }
    console.log('');
  }
}
