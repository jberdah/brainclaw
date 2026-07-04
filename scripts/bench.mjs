#!/usr/bin/env node
/**
 * bench.mjs — run the "time-to-first-value" scenarios and emit a report.
 *
 * Assumes `npm run build:test` has produced dist-test/. Loads the compiled
 * scenarios from dist-test/tests/bench/scenarios.js (in-process) and writes
 * dist/bench-report.json for CI artifact upload + facts emission.
 *
 * A repeat count (--repeats N) helps damp noise from a single warm-JIT run
 * without needing a full statistical framework; the report keeps every
 * sample plus min/median/max.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const repeats = Math.max(1, Number(args.get('repeats') ?? '3'));
const scenarioFilter = args.get('scenario'); // optional: cold_onboard | warm_work | first_edit
const outFile = args.get('out') ?? 'dist/bench-report.json';

const scenariosMod = pathToFileURL(path.resolve('./dist-test/tests/bench/scenarios.js')).href;
if (!fs.existsSync('./dist-test/tests/bench/scenarios.js')) {
  console.error('bench: dist-test/tests/bench/scenarios.js not found. Run `npm run build:test` first.');
  process.exit(2);
}

const { SCENARIO_SPECS, runSingleScenario } = await import(scenariosMod);

const specs = scenarioFilter
  ? SCENARIO_SPECS.filter((s) => s.name === scenarioFilter)
  : SCENARIO_SPECS;
if (specs.length === 0) {
  console.error(`bench: no scenario matched --scenario=${scenarioFilter}`);
  process.exit(2);
}

function pickMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return sorted[mid];
}

const startedAt = new Date().toISOString();
const scenarioReports = [];

for (const spec of specs) {
  const samples = [];
  console.log(`\n==> ${spec.name} (${spec.volume}) — ${repeats}× ${spec.description}`);
  for (let i = 0; i < repeats; i++) {
    const result = await runSingleScenario(spec.name);
    samples.push(result);
    const status = result.ok ? 'ok' : 'FAIL';
    console.log(
      `   [${i + 1}/${repeats}] ${status} duration=${result.duration_ms}ms calls=${result.calls} payload=${result.payload_chars}c`,
    );
    if (!result.ok) console.log(`       error: ${result.error}`);
  }

  const okSamples = samples.filter((s) => s.ok);
  const measured = okSamples.length > 0 ? okSamples : samples;
  const durations = measured.map((s) => s.duration_ms);
  const payloads = measured.map((s) => s.payload_chars);
  const calls = measured.map((s) => s.calls);
  const first = samples[0];

  scenarioReports.push({
    name: spec.name,
    volume: spec.volume,
    description: spec.description,
    repeats: samples.length,
    ok_count: okSamples.length,
    duration_ms: {
      min: Math.min(...durations),
      median: pickMedian(durations),
      max: Math.max(...durations),
    },
    payload_chars: {
      min: Math.min(...payloads),
      median: pickMedian(payloads),
      max: Math.max(...payloads),
    },
    calls: { median: pickMedian(calls) },
    // ~4 chars ≈ 1 token — deliberately conservative.
    payload_tokens_est: { median: Math.round(pickMedian(payloads) / 4) },
    extras: first?.extras,
    notes: Array.from(new Set(samples.flatMap((s) => s.notes))),
    samples,
  });
}

const report = {
  schema: 'brainclaw.bench.v1',
  generated_at: startedAt,
  node_version: process.version,
  platform: `${process.platform}-${process.arch}`,
  repeats,
  scenarios: scenarioReports,
};

const outAbs = path.resolve(outFile);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, JSON.stringify(report, null, 2) + '\n', 'utf-8');

console.log(`\n✓ wrote ${outFile} — ${scenarioReports.length} scenario(s), ${repeats} repeat(s) each`);
console.log('  Summary:');
for (const s of scenarioReports) {
  console.log(
    `    ${s.name.padEnd(14)} ${s.volume.padEnd(6)} duration_ms.median=${String(s.duration_ms.median).padStart(5)}  payload=${s.payload_chars.median}c  ~${s.payload_tokens_est.median}tok`,
  );
}

const anyFailed = scenarioReports.some((s) => s.ok_count < s.repeats);
if (anyFailed) {
  console.error('bench: at least one scenario had failing samples');
  process.exit(1);
}
