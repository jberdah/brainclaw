#!/usr/bin/env node
/**
 * bench-check.mjs — CI gate for the "time-to-first-value" bench.
 *
 * Reads dist/bench-report.json (produced by scripts/bench.mjs) and
 * bench-budgets.json (versioned at repo root). Fails non-zero when any
 * measured value exceeds its budget by more than the configured tolerance,
 * mirroring the shape of the coverage gate: budgets live in the repo,
 * regressions block merge.
 *
 * Tolerance is intentionally generous (default 20%) — this catches a real
 * regression, not per-run noise. Tune per-scenario in bench-budgets.json.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const reportFile = args.get('report') ?? 'dist/bench-report.json';
const budgetsFile = args.get('budgets') ?? 'bench-budgets.json';

function readJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`bench-check: ${file} not found`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const report = readJson(reportFile);
const budgets = readJson(budgetsFile);

const defaultTolerance = budgets.default_tolerance ?? 0.2;
const violations = [];
const passes = [];

for (const scenario of report.scenarios) {
  const budget = budgets.scenarios?.[scenario.name];
  if (!budget) {
    console.log(`  ${scenario.name}: no budget entry — skipping`);
    continue;
  }
  const tolerance = budget.tolerance ?? defaultTolerance;
  const checks = [
    { key: 'duration_ms', value: scenario.duration_ms.median, limit: budget.duration_ms_median },
    { key: 'payload_chars', value: scenario.payload_chars.median, limit: budget.payload_chars_median },
  ];
  for (const c of checks) {
    if (c.limit == null) continue;
    const ceiling = c.limit * (1 + tolerance);
    const ok = c.value <= ceiling;
    const record = {
      scenario: scenario.name,
      metric: c.key,
      measured: c.value,
      budget: c.limit,
      ceiling: Math.round(ceiling),
      tolerance,
    };
    if (ok) passes.push(record); else violations.push(record);
  }
}

console.log('\nBench budget check');
console.log('==================');
for (const p of passes) {
  console.log(
    `  ok    ${p.scenario.padEnd(14)} ${p.metric.padEnd(14)} ${String(p.measured).padStart(6)} ≤ ${String(p.ceiling).padStart(6)} (budget ${p.budget}, tol ±${Math.round(p.tolerance * 100)}%)`,
  );
}
for (const v of violations) {
  console.error(
    `  FAIL  ${v.scenario.padEnd(14)} ${v.metric.padEnd(14)} ${String(v.measured).padStart(6)} > ${String(v.ceiling).padStart(6)} (budget ${v.budget}, tol ±${Math.round(v.tolerance * 100)}%)`,
  );
}

if (violations.length > 0) {
  console.error(`\nbench-check: ${violations.length} budget violation(s). Update ${path.basename(budgetsFile)} intentionally if this is a planned trade-off.`);
  process.exit(1);
}
console.log(`\n✓ bench-check: ${passes.length} check(s) within budget`);
