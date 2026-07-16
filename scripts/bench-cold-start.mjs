#!/usr/bin/env node
/**
 * bench-cold-start.mjs — dedicated SUBPROCESS cold-start bench (pln#622 PR6).
 *
 * The in-process "time-to-first-value" bench (scripts/bench.mjs) deliberately
 * excludes the Node module-import cost that dominates real cold-start wall
 * clock (scenarios.ts:10-14). This bench measures exactly that: it spawns the
 * built CLI as a fresh process for the coldest entry points and records
 * min/median/max over N repeats.
 *
 *   node scripts/bench-cold-start.mjs [--cli dist/cli.js] [--repeats 7]
 *        [--out dist/bench-cold-start.json] [--check] [--baseline <file>]
 *        [--tolerance 0.5]
 *
 * Deterministic + store-free: each spawn runs in a throwaway cwd with a fake
 * HOME and agent-detection stripped, so the number reflects import + arg-parse
 * cost, not store I/O or environment. `--check` compares medians against the
 * committed baseline and exits non-zero on a regression beyond the tolerance
 * (default 100% — cold-start wall clock is machine- and load-dependent, far
 * noisier than the in-process bench; empirically the same code varies ~60%
 * run-to-run under load, so the check is a gross-regression detector for
 * manual use on a calm machine, NOT a CI gate).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const cliPath = path.resolve(args.get('cli') ?? 'dist/cli.js');
const repeats = Math.max(3, Number(args.get('repeats') ?? '7'));
const outFile = args.get('out') ?? 'dist/bench-cold-start.json';
const doCheck = args.get('check') === 'true';
const baselineFile = args.get('baseline') ?? 'bench-cold-start.baseline.json';
const tolerance = Number(args.get('tolerance') ?? '1.0');

if (!fs.existsSync(cliPath)) {
  console.error(`bench-cold-start: CLI not found at ${cliPath}. Build first (npm run build:cli or build:test).`);
  process.exit(2);
}

// The coldest, most deterministic entry points. --version / --help never touch
// a store; `status --json` additionally exercises command dispatch (it prints a
// not-initialized notice fast in the throwaway store — we time the process, not
// its exit code).
const COMMANDS = [
  { name: 'version', argv: ['--version'] },
  { name: 'help', argv: ['--help'] },
  { name: 'status_json', argv: ['status', '--json'] },
];

/** Store-free, agent-neutral env in a throwaway cwd + fake HOME. */
function coldEnv(cwd) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cold-home-'));
  const env = {
    ...process.env,
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };
  // Strip identity/agent-detection so the number is environment-independent.
  for (const key of Object.keys(env)) {
    if (/^(BRAINCLAW_AGENT|BRAINCLAW_SESSION|OPENCLAW_|CLAUDE_|CLAUDECODE|CURSOR_|COPILOT_|GITHUB_COPILOT|WINDSURF_|CODEX_|CLINE_|CONTINUE_|ROO_|OPENCODE_|ANTIGRAVITY_|HERMES_|VIBE_)/.test(key)) {
      delete env[key];
    }
  }
  return env;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

const startedAt = new Date().toISOString();
const results = [];
console.log(`cold-start bench: ${cliPath} — ${repeats}× per command`);

for (const cmd of COMMANDS) {
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cold-cwd-'));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cliPath, ...cmd.argv], {
      cwd,
      env: coldEnv(cwd),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const dt = Date.now() - t0;
    if (r.error) {
      console.error(`  ${cmd.name} [${i + 1}/${repeats}] spawn error: ${r.error.message}`);
    }
    samples.push(dt);
  }
  const med = median(samples);
  results.push({
    name: cmd.name,
    argv: cmd.argv.join(' '),
    duration_ms: { min: Math.min(...samples), median: med, max: Math.max(...samples), samples },
  });
  console.log(`  ${cmd.name.padEnd(12)} median=${med}ms  (min=${Math.min(...samples)} max=${Math.max(...samples)})`);
}

const report = { schema: 1, started_at: startedAt, cli: path.relative(process.cwd(), cliPath), repeats, scenarios: results };
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');
console.log(`\nwrote ${outFile}`);

if (doCheck) {
  if (!fs.existsSync(baselineFile)) {
    console.error(`bench-cold-start --check: baseline ${baselineFile} not found`);
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  const byName = new Map(baseline.scenarios.map((s) => [s.name, s]));
  const violations = [];
  for (const s of results) {
    const base = byName.get(s.name);
    if (!base) continue;
    const ceiling = Math.round(base.duration_ms.median * (1 + tolerance));
    const status = s.duration_ms.median <= ceiling ? 'ok' : 'REGRESSION';
    console.log(`  ${s.name.padEnd(12)} ${s.duration_ms.median}ms vs baseline ${base.duration_ms.median}ms (ceiling ${ceiling}ms) — ${status}`);
    if (s.duration_ms.median > ceiling) {
      violations.push(`${s.name}: ${s.duration_ms.median}ms > ceiling ${ceiling}ms (baseline ${base.duration_ms.median}ms +${Math.round(tolerance * 100)}%)`);
    }
  }
  if (violations.length > 0) {
    console.error(`\nbench-cold-start: ${violations.length} regression(s):\n  ${violations.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nbench-cold-start: all entry points within budget');
}
