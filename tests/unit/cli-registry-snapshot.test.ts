/**
 * CAMPAIGN BASELINE (pln#622 PR0c) — CLI registry snapshot.
 *
 * Freezes the ENTIRE Commander surface of src/cli.ts — full command paths,
 * aliases, positional arguments (required/optional/variadic), and options
 * (long/short flags, value requirement, mandatory, negate, defaults) — for
 * the duration of the cli.ts decomposition campaign (PR1→PR5). Any
 * unintended surface change while commands are extracted fails this test.
 *
 * This is deliberately NOT a --help text snapshot (help output is fragile:
 * wrapping, ordering, descriptions). Instead the test spawns the compiled
 * CLI with BRAINCLAW_DUMP_REGISTRY=1 — a temporary scaffolding branch in
 * src/cli.ts that prints a normalized JSON registry and exits before any
 * parsing — and deep-compares it against the committed snapshot at
 * tests/fixtures/cli-registry.snapshot.json.
 *
 * To INTENTIONALLY change the CLI surface, regenerate the snapshot and
 * commit it alongside your change:
 *
 *   UPDATE_CLI_REGISTRY_SNAPSHOT=1 node --test dist-test/tests/unit/cli-registry-snapshot.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizedProcessEnv } from '../helpers/workspace.js';

// Compiled test lives at dist-test/tests/unit/ → repo root is 3 levels up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist-test', 'src', 'cli.js');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'cli-registry.snapshot.json');
const REGEN_HINT =
  'To intentionally accept the new surface, regenerate and commit the snapshot:\n' +
  '  UPDATE_CLI_REGISTRY_SNAPSHOT=1 node --test dist-test/tests/unit/cli-registry-snapshot.test.js';

interface RegistryCommand {
  aliases: string[];
  arguments: { name: string; required: boolean; variadic: boolean }[];
  options: Record<string, unknown>[];
  path: string;
}

/** Serialize with recursively sorted object keys so the committed file is canonical. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sortKeys((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function dumpRegistry(): RegistryCommand[] {
  // sanitizedProcessEnv strips every BRAINCLAW_* / agent-detection key, which
  // keeps the dump deterministic (e.g. BRAINCLAW_ENABLE_CODEV gates command
  // registration in src/cli.ts and must not leak in from an agent shell).
  // The dump goes to a FILE, not stdout: module side effects can interleave
  // stdout writes (observed on Linux CI — JSON corrupted mid-stream).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-registry-'));
  const dumpPath = path.join(tmpDir, 'registry.json');
  try {
    const result = spawnSync(process.execPath, [CLI_PATH], {
      cwd: REPO_ROOT,
      env: { ...sanitizedProcessEnv(), BRAINCLAW_DUMP_REGISTRY: dumpPath },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      0,
      `BRAINCLAW_DUMP_REGISTRY run failed (status ${result.status}).\nstderr:\n${result.stderr}`,
    );
    return JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as RegistryCommand[];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Human-readable drift report: added/removed command paths + changed entries. */
function describeDrift(actual: RegistryCommand[], expected: RegistryCommand[]): string {
  const actualByPath = new Map(actual.map((c) => [c.path, c]));
  const expectedByPath = new Map(expected.map((c) => [c.path, c]));
  const lines: string[] = [];
  for (const p of actualByPath.keys()) {
    if (!expectedByPath.has(p)) lines.push(`  + command added:   ${p}`);
  }
  for (const p of expectedByPath.keys()) {
    if (!actualByPath.has(p)) lines.push(`  - command removed: ${p}`);
  }
  for (const [p, cmd] of actualByPath) {
    const baseline = expectedByPath.get(p);
    if (!baseline) continue;
    if (canonicalJson(cmd) !== canonicalJson(baseline)) {
      lines.push(`  ~ command changed: ${p}`);
      lines.push(`      baseline: ${JSON.stringify(baseline)}`);
      lines.push(`      current:  ${JSON.stringify(cmd)}`);
    }
  }
  return lines.join('\n');
}

describe('CLI registry baseline (pln#622 campaign freeze)', () => {
  it('matches the committed registry snapshot', () => {
    const actual = dumpRegistry();

    // Sanity: a broken dump mechanism must never be accepted as a baseline.
    assert.ok(
      actual.length >= 50,
      `registry dump looks truncated: only ${actual.length} commands captured`,
    );
    assert.ok(
      actual.some((c) => c.path === 'brainclaw init'),
      'registry dump is missing the "brainclaw init" command — dump mechanism broken?',
    );

    if (process.env.UPDATE_CLI_REGISTRY_SNAPSHOT === '1') {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, canonicalJson(actual), 'utf-8');
      console.log(`cli-registry snapshot rewritten: ${SNAPSHOT_PATH} (${actual.length} commands)`);
      return;
    }

    assert.ok(
      fs.existsSync(SNAPSHOT_PATH),
      `Missing baseline snapshot ${SNAPSHOT_PATH}.\n${REGEN_HINT}`,
    );
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8')) as RegistryCommand[];

    if (canonicalJson(actual) !== canonicalJson(expected)) {
      assert.fail(
        'CLI registry drifted from the frozen pln#622 baseline:\n' +
          `${describeDrift(actual, expected)}\n${REGEN_HINT}`,
      );
    }
  });

  it('produces a deterministic dump (two runs are byte-identical)', () => {
    const first = canonicalJson(dumpRegistry());
    const second = canonicalJson(dumpRegistry());
    assert.equal(first, second, 'registry dump is non-deterministic across runs');
  });
});
