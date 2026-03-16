import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import type { PlanItem } from '../core/schema.js';

export interface EstimationReportOptions {
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export interface PlanEstimationEntry {
  id: string;
  text: string;
  author: string;
  estimated_effort?: string;
  actual_effort?: string;
  elapsed_minutes?: number;
  estimated_minutes?: number;
  ratio?: number;
  completed_at?: string;
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
  };
}

/** Parse effort strings like "30min", "2h", "1h30m", "1d", "45m" → minutes */
export function parseEffortMinutes(effort: string): number | undefined {
  const s = effort.trim().toLowerCase();
  let total = 0;
  let matched = false;

  const days = s.match(/(\d+(?:\.\d+)?)\s*d/);
  if (days) { total += parseFloat(days[1]) * 8 * 60; matched = true; }

  const hours = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hours) { total += parseFloat(hours[1]) * 60; matched = true; }

  const mins = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
  if (mins) { total += parseFloat(mins[1]); matched = true; }

  // bare number → assume minutes
  if (!matched) {
    const bare = parseFloat(s);
    if (!isNaN(bare)) return bare;
    return undefined;
  }
  return total > 0 ? total : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildCalibrationHint(medianRatio: number): string {
  if (medianRatio < 0.5) return `You tend to underestimate by ~${(1 / medianRatio).toFixed(1)}x — pad estimates up`;
  if (medianRatio < 0.8) return `You slightly underestimate — add ~${Math.round((1 - medianRatio) * 100)}% to estimates`;
  if (medianRatio <= 1.25) return 'Estimates are well-calibrated';
  if (medianRatio <= 2.0) return `You tend to overestimate by ~${medianRatio.toFixed(1)}x — cut estimates by ~${Math.round((1 - 1 / medianRatio) * 100)}%`;
  return `You significantly overestimate by ~${medianRatio.toFixed(1)}x — estimates should be ~${medianRatio.toFixed(1)}x smaller`;
}

export function buildEstimationReport(options: EstimationReportOptions = {}): EstimationReportResult {
  const state = loadState(options.cwd);
  const done = state.plan_items.filter((p: PlanItem) =>
    p.status === 'done' && (!options.agent || p.author === options.agent)
  );

  const entries: PlanEstimationEntry[] = done.map((p: PlanItem) => {
    const entry: PlanEstimationEntry = {
      id: p.id,
      text: p.text,
      author: p.author,
      estimated_effort: p.estimated_effort,
      actual_effort: p.actual_effort,
      completed_at: p.completed_at,
    };

    // Compute elapsed from wall-clock timestamps
    const endTime = p.completed_at ?? p.updated_at;
    const startTime = p.started_at ?? p.created_at;
    if (endTime && startTime) {
      const elapsed = (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000;
      if (elapsed > 0) entry.elapsed_minutes = Math.round(elapsed);
    }

    // Resolve actual minutes: explicit actual_effort > elapsed
    const actualMinutes = p.actual_effort
      ? parseEffortMinutes(p.actual_effort)
      : entry.elapsed_minutes;

    if (actualMinutes !== undefined) entry.elapsed_minutes = Math.round(actualMinutes);

    if (p.estimated_effort) {
      const est = parseEffortMinutes(p.estimated_effort);
      if (est !== undefined) {
        entry.estimated_minutes = est;
        if (actualMinutes !== undefined && actualMinutes > 0) {
          entry.ratio = parseFloat((est / actualMinutes).toFixed(2));
        }
      }
    }

    return entry;
  });

  const withBoth = entries.filter((e) => e.ratio !== undefined);
  const ratios = withBoth.map((e) => e.ratio as number);

  const medianRatio = ratios.length > 0 ? parseFloat(median(ratios).toFixed(2)) : undefined;
  const meanRatio = ratios.length > 0 ? parseFloat(mean(ratios).toFixed(2)) : undefined;

  return {
    entries,
    summary: {
      total: entries.length,
      with_estimate: entries.filter((e) => e.estimated_effort).length,
      with_both: withBoth.length,
      median_ratio: medianRatio,
      mean_ratio: meanRatio,
      calibration_hint: medianRatio !== undefined ? buildCalibrationHint(medianRatio) : undefined,
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
    console.log(`\nMedian ratio (estimated/actual): ${summary.median_ratio}x`);
    console.log(`Mean ratio: ${summary.mean_ratio}x`);
    console.log(`→ ${summary.calibration_hint}`);
  }

  if (entries.length > 0) {
    console.log('\n— Details —');
    for (const e of entries) {
      const est = e.estimated_effort ? `est:${e.estimated_effort}` : 'no estimate';
      const act = e.elapsed_minutes !== undefined ? `actual:${e.elapsed_minutes}min` : 'no actual';
      const ratio = e.ratio !== undefined ? ` ratio:${e.ratio}x` : '';
      const short = e.text.length > 60 ? e.text.slice(0, 57) + '…' : e.text;
      console.log(`  [${e.id.slice(0, 8)}] ${short}`);
      console.log(`    ${est} · ${act}${ratio} (${e.author})`);
    }
  }
}
