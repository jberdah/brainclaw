/**
 * Tests for `brainclaw bootstrap-loop` CLI (pln#513 step 3).
 *
 * Direct verb invocation via runBootstrapLoopCommand(opts, tmpdir) — no
 * child-process spawn. Fixtures use openLoop(BOOTSTRAP_PRESET, ...) so
 * the find-existing branch sees a real bootstrap loop on disk.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BOOTSTRAP_PRESET,
  closeLoop,
  listLoops,
  openLoop,
  type LoopThread,
} from '../../src/core/loops/index.js';

import { runBootstrapLoopCommand, type BootstrapLoopResult } from '../../src/commands/bootstrap-loop.js';

interface Captured {
  stdout: string[];
  stderr: string[];
}

function captureConsole(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    captured.stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    captured.stderr.push(args.map(String).join(' '));
  };
  return {
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function stubExit(): () => void {
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;
  return () => {
    process.exit = origExit;
  };
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cli-bootloop-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function seedBootstrapLoop(cwd: string): LoopThread {
  return openLoop(
    {
      kind: 'ideation',
      title: 'Bootstrap PROJECT.md',
      created_by: 'agt_test',
      slots: [{ role: 'champion', agent: 'agt_test' }],
      phases: BOOTSTRAP_PRESET.phases,
      stop_condition: BOOTSTRAP_PRESET.stop_condition,
      protocol: BOOTSTRAP_PRESET.protocol,
    },
    cwd,
  );
}

describe('runBootstrapLoopCommand — no-args', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('opens a new bootstrap loop when none exists', async () => {
    await runBootstrapLoopCommand({}, cwd);
    const loops = listLoops({ kind: 'ideation' }, cwd);
    assert.equal(loops.length, 1);
    assert.equal(loops[0].protocol?.preset, 'bootstrap');
    assert.equal(loops[0].current_phase, 'survey');
    assert.equal(loops[0].status, 'open');
    const joined = captured.stdout.join('\n');
    assert.ok(/Opened bootstrap loop lop_/.test(joined), `expected open line, got:\n${joined}`);
    assert.ok(joined.includes('phase: survey'));
  });

  it('joins the existing bootstrap loop when one is already on disk', async () => {
    const existing = seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({}, cwd);
    const loops = listLoops({ kind: 'ideation' }, cwd);
    assert.equal(loops.length, 1, 'no second loop should be created');
    const joined = captured.stdout.join('\n');
    assert.ok(/Joined existing bootstrap loop/.test(joined), `expected joined line, got:\n${joined}`);
    assert.ok(joined.includes(existing.id), `expected ${existing.id} in output`);
  });

  it('emits parseable JSON on opened path', async () => {
    await runBootstrapLoopCommand({ json: true }, cwd);
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'opened');
    assert.equal(parsed.current_phase, 'survey');
    assert.equal(parsed.status, 'open');
    assert.ok(parsed.loop_id.startsWith('lop_'), `expected lop_ prefix, got ${parsed.loop_id}`);
    assert.ok(parsed.next_expected, 'next_expected should be set');
  });

  it('emits parseable JSON on joined path with action=joined', async () => {
    const existing = seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({ json: true }, cwd);
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'joined');
    assert.equal(parsed.loop_id, existing.id);
  });
});

describe('runBootstrapLoopCommand — --status', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('reports phase and open_questions count when a loop exists', async () => {
    const existing = seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({ status: true, json: true }, cwd);
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'status');
    assert.equal(parsed.loop_id, existing.id);
    assert.equal(parsed.current_phase, 'survey');
    assert.equal(parsed.status, 'open');
    assert.deepEqual(parsed.open_questions, []);
  });

  it('renders a human report when --json is not set', async () => {
    seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({ status: true }, cwd);
    const joined = captured.stdout.join('\n');
    assert.ok(/Bootstrap loop status/.test(joined), `expected status header, got:\n${joined}`);
    assert.ok(joined.includes('phase: survey'));
    assert.ok(joined.includes('status: open'));
  });

  it('exits 1 with clear error when no bootstrap loop exists', async () => {
    await assert.rejects(
      () => runBootstrapLoopCommand({ status: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(
      captured.stderr.join('\n').includes('no active bootstrap loop'),
      `expected "no active bootstrap loop" stderr, got: ${captured.stderr.join('\n')}`,
    );
  });

  it('--status --json on missing loop emits {ok:false}', async () => {
    await assert.rejects(
      () => runBootstrapLoopCommand({ status: true, json: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, false);
    assert.ok(typeof parsed.error === 'string');
  });
});

describe('runBootstrapLoopCommand — --cancel', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('--cancel --yes closes the loop with status=cancelled', async () => {
    const existing = seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({ cancel: true, yes: true }, cwd);
    const all = listLoops({}, cwd);
    const found = all.find((l) => l.id === existing.id);
    assert.ok(found, 'loop should still exist on disk');
    assert.equal(found!.status, 'cancelled');
    const joined = captured.stdout.join('\n');
    assert.ok(/Cancelled bootstrap loop/.test(joined), `expected cancel line, got:\n${joined}`);
  });

  it('--cancel --yes --json emits action=cancelled JSON payload', async () => {
    const existing = seedBootstrapLoop(cwd);
    await runBootstrapLoopCommand({ cancel: true, yes: true, json: true }, cwd);
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'cancelled');
    assert.equal(parsed.loop_id, existing.id);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.next_expected, null);
  });

  it('--cancel exits 1 when no active bootstrap loop exists', async () => {
    await assert.rejects(
      () => runBootstrapLoopCommand({ cancel: true, yes: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(
      captured.stderr.join('\n').includes('no active bootstrap loop'),
    );
  });

  it('--cancel ignores already-closed loops (treated as none active)', async () => {
    const existing = seedBootstrapLoop(cwd);
    closeLoop(
      { id: existing.id, final_status: 'cancelled', actor: 'agt_test' },
      cwd,
    );
    await assert.rejects(
      () => runBootstrapLoopCommand({ cancel: true, yes: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
  });
});

describe('runBootstrapLoopCommand — guards', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('exits 1 when --status and --cancel are passed together', async () => {
    await assert.rejects(
      () => runBootstrapLoopCommand({ status: true, cancel: true, yes: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('mutually exclusive'));
  });

  it('exits 1 when .brainclaw/ is missing', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cli-bootloop-bare-'));
    try {
      await assert.rejects(
        () => runBootstrapLoopCommand({}, bare),
        (err: unknown) => err instanceof ProcessExitError && err.code === 1,
      );
      assert.ok(captured.stderr.join('\n').includes('.brainclaw/ not found'));
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * pln#518 step 1 — regression for the singleton acquire path.
 *
 * Verifies that two sequential runBootstrapLoopCommand() invocations converge
 * on the SAME loop rather than creating duplicates. A true concurrent race
 * can't be reproduced in unit tests without fault injection, but the
 * sequential-repeat case is the most common operator scenario and exercises
 * the find-existing → join path added by the refactor.
 */
describe('runBootstrapLoopCommand — singleton acquire regression (pln#518)', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('second invocation joins the loop opened by the first — no duplicate', async () => {
    // First call: opens a new loop.
    await runBootstrapLoopCommand({ json: true }, cwd);
    const firstOutput = JSON.parse(captured.stdout.join('\n')) as BootstrapLoopResult;
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.action, 'opened');
    const loopIdA = firstOutput.loop_id;
    assert.ok(loopIdA.startsWith('lop_'), `expected lop_ prefix, got ${loopIdA}`);

    // Reset captured output for second call.
    captured.stdout.length = 0;

    // Second call: must join the existing loop, not open a new one.
    await runBootstrapLoopCommand({ json: true }, cwd);
    const secondOutput = JSON.parse(captured.stdout.join('\n')) as BootstrapLoopResult;
    assert.equal(secondOutput.ok, true);
    assert.equal(secondOutput.action, 'joined', 'second invocation must join, not open');
    assert.equal(secondOutput.loop_id, loopIdA, 'must return the same loop_id');
    assert.equal(secondOutput.joined_existing, true, 'joined_existing must be true');

    // Exactly one bootstrap loop must exist on disk.
    const allBootstrap = listLoops({ kind: 'ideation' }, cwd).filter(
      (l) => l.protocol?.preset === 'bootstrap',
    );
    assert.equal(allBootstrap.length, 1, 'exactly one bootstrap loop must be on disk');
  });
});
