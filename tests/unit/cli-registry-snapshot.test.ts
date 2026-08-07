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

interface RegistryDump {
  /** Full command surface, sorted by path (compared against the fixture). */
  commands: RegistryCommand[];
  /** Top-level registration order — what `--help` renders (pln#622 PR5 order shim). */
  topLevelOrder: string[];
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

function dumpRegistry(): RegistryDump {
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
    return JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as RegistryDump;
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
    const actual = dumpRegistry().commands;

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

  it('preserves the pre-split monolith top-level command order (--help surface)', () => {
    // Commander renders `--help` in registration order. The pln#622 PR5 split
    // registers commands per family, so src/cli.ts carries an explicit
    // ORIGINAL_COMMAND_ORDER manifest + stable sort to keep the help output
    // identical to the pre-split monolith (git show 0bc2005:src/cli.ts).
    // This is that manifest's frozen expectation, MINUS the two
    // BRAINCLAW_ENABLE_CODEV-gated commands (codev, codev-metrics):
    // sanitizedProcessEnv strips the gate, so they are not registered here.
    const expectedOrder = [
      'init',
      'setup',
      'setup-machine',
      'memory-log',
      'memory-rollback',
      'upgrade',
      'patch-configs',
      'machine-profile',
      'agent-inventory',
      'projects',
      'decision',
      'constraint',
      'trap',
      'handoff',
      'status',
      'plan',
      'code-map',
      'move',
      'list-plans',
      'sequence',
      'add-step',
      'complete-step',
      'update-step',
      'delete-step',
      'estimation-report',
      'update-plan',
      'surface-task',
      'delete-plan',
      'update-handoff',
      'doctor',
      'repair',
      'stale',
      'version',
      'release-notes',
      'uninstall',
      'rebuild',
      'reflect',
      'reflect-runtime-note',
      'context',
      'bootstrap',
      'env',
      'memory',
      'instruction',
      'list-instructions',
      'register-agent',
      'enable-agent',
      'list-agents',
      'review',
      'show-candidate',
      'star-candidate',
      'use-candidate',
      'accept',
      'adapter-openclaw-import',
      'reject',
      'harvest-candidates',
      'harvest',
      'prune-candidates',
      'cleanup-candidates',
      'claim',
      'assignment',
      'list-claims',
      'release-claim',
      'release-claims',
      'agent-board',
      'runtime-note',
      'note',
      'runtime-status',
      'sync',
      'check-constraints',
      'check-policy',
      'check-security',
      'setup-security',
      'install-hooks',
      'diff',
      'prune',
      'compact',
      'mcp',
      'set-trust',
      'session-start',
      'session-end',
      'whoami',
      'usage',
      'search',
      'export',
      'refresh',
      'reconcile',
      'hooks',
      'watch',
      'dispatch',
      'inbox',
      'check-events',
      'metrics',
      'rollback',
      'pull',
      'push',
      'audit',
      'history',
      'context-diff',
      'capability',
      'link',
      'tool',
      'explore',
      'discover',
      'migrate',
      'switch',
      'who',
      'worktree',
      'questions',
      'bootstrap-loop',
      'loop',
      'reply',
      'run',
    ];
    const { topLevelOrder } = dumpRegistry();
    assert.deepEqual(
      topLevelOrder,
      expectedOrder,
      'top-level --help command order drifted from the pre-split monolith (pln#622 PR5 order shim)',
    );
  });
});
