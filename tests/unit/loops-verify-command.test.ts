import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop } from '../../src/core/loops/index.js';
import { getLoop, writeThreadFile } from '../../src/core/loops/store.js';
import { hasPassingVerifyReportInIteration } from '../../src/core/loops/iteration-engine.js';
import {
  runVerify,
  defaultVerifyRunner,
  type VerifyRunResult,
  type VerifyRunner,
} from '../../src/core/loops/verify-command.js';

/**
 * pln#632 — engine-run verify-command runner. The command_green gate becomes
 * deterministic: brainclaw runs the opener-configured command and records the
 * verify_report the iteration engine reads. Injected runner for the control-flow
 * cases; the REAL defaultVerifyRunner for the security-critical env-sanitization +
 * exit-code cases.
 */
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function ws(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-verify-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  cleanup.push(dir);
  return dir;
}
function openImpl(cwd: string, command?: string[]) {
  return openLoop(
    {
      kind: 'implementation',
      title: 'verify test',
      created_by: 'agt_test',
      ...(command ? { verify: { command } } : {}),
      slots: [{ role: 'implementer', agent_id: 'agt_i' }],
    },
    cwd,
  );
}
const runnerReturning = (r: VerifyRunResult): VerifyRunner => () => r;
const GREEN: VerifyRunResult = { exit_code: 0, passed: true, timed_out: false, duration_ms: 5, stdout_tail: 'ok', stderr_tail: '' };

describe('pln#632 verify-command runner', () => {
  it('a GREEN run records a passing verify_report that satisfies command_green', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['echo', 'ok']);
    const res = runVerify({ loop_id: loop.id, actor: 'agt_i', runner: runnerReturning(GREEN) }, cwd);
    assert.equal(res.unconfigured, undefined);
    assert.equal(res.deduped, false);
    assert.equal(res.report?.passed, true);
    const thread = getLoop(loop.id, cwd)!;
    assert.ok(hasPassingVerifyReportInIteration(thread, thread.iteration_count), 'command_green is satisfied');
  });

  it('a RED run records passed:false (command_green NOT satisfied → cycle continues)', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['false']);
    const res = runVerify(
      { loop_id: loop.id, actor: 'agt_i', runner: runnerReturning({ exit_code: 1, passed: false, timed_out: false, duration_ms: 5, stdout_tail: '', stderr_tail: 'fail' }) },
      cwd,
    );
    assert.equal(res.report?.passed, false);
    const thread = getLoop(loop.id, cwd)!;
    assert.equal(hasPassingVerifyReportInIteration(thread, thread.iteration_count), false);
  });

  it('a TIMEOUT records timed_out:true + passed:false', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['sleep', '9999']);
    const res = runVerify(
      { loop_id: loop.id, actor: 'agt_i', runner: runnerReturning({ exit_code: null, passed: false, timed_out: true, duration_ms: 100, stdout_tail: '', stderr_tail: '' }) },
      cwd,
    );
    assert.equal(res.report?.timed_out, true);
    assert.equal(res.report?.passed, false);
  });

  it('re-invoking for the same iteration does NOT double-append (idempotent)', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['echo', 'ok']);
    runVerify({ loop_id: loop.id, actor: 'agt_i', runner: runnerReturning(GREEN) }, cwd);
    const second = runVerify({ loop_id: loop.id, actor: 'agt_i', runner: runnerReturning(GREEN) }, cwd);
    assert.equal(second.deduped, true, 'second call is deduped');
    const thread = getLoop(loop.id, cwd)!;
    assert.equal(thread.artifacts.filter((a) => a.type === 'verify_report').length, 1, 'exactly one verify_report');
  });

  it('an UNCONFIGURED loop → typed unconfigured, no artifact (agent-narrated path unchanged)', () => {
    const cwd = ws();
    const loop = openImpl(cwd); // no verify command
    const res = runVerify({ loop_id: loop.id, actor: 'agt_i', runner: runnerReturning(GREEN) }, cwd);
    assert.equal(res.unconfigured, true);
    assert.equal(res.report, undefined);
    const thread = getLoop(loop.id, cwd)!;
    assert.equal(thread.artifacts.filter((a) => a.type === 'verify_report').length, 0, 'nothing appended when unconfigured');
  });

  it('defaultVerifyRunner STRIPS BRAINCLAW_* from the child env (store-safety, trap)', () => {
    const cwd = ws();
    const outFile = path.join(cwd, 'env-dump.json');
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('BRAINCLAW_')||k==='BCLAW_PROMPT_FILE')));`;
    process.env.BRAINCLAW_CWD = '/should/not/leak';
    process.env.BRAINCLAW_AGENT = 'leak-agent';
    try {
      const r = defaultVerifyRunner({ command: [process.execPath, '-e', script], cwd, timeout_ms: 30000 });
      assert.equal(r.passed, true, `runner should succeed: ${r.stderr_tail}`);
      const leaked = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as string[];
      assert.deepEqual(leaked, [], 'the spawned command sees NO BRAINCLAW_* / BCLAW_PROMPT_FILE vars');
    } finally {
      delete process.env.BRAINCLAW_CWD;
      delete process.env.BRAINCLAW_AGENT;
    }
  });

  it('defaultVerifyRunner: exit 0 → passed; non-zero → not passed', () => {
    const cwd = ws();
    const ok = defaultVerifyRunner({ command: [process.execPath, '-e', 'process.exit(0)'], cwd, timeout_ms: 30000 });
    assert.equal(ok.passed, true);
    assert.equal(ok.exit_code, 0);
    const bad = defaultVerifyRunner({ command: [process.execPath, '-e', 'process.exit(3)'], cwd, timeout_ms: 30000 });
    assert.equal(bad.passed, false);
    assert.equal(bad.exit_code, 3);
  });

  it('stamps the report with the SNAPSHOT iteration if the loop advances during the spawn (review F1)', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['echo', 'ok']);
    // The runner runs BETWEEN the two lock scopes — simulate a concurrent advance that
    // bumps the loop from iteration 0 → 1 during the out-of-lock spawn window.
    const advancingRunner: VerifyRunner = () => {
      const t = getLoop(loop.id, cwd)!;
      writeThreadFile({ ...t, iteration_count: 1 }, cwd);
      return GREEN;
    };
    runVerify({ loop_id: loop.id, actor: 'agt_i', runner: advancingRunner }, cwd);
    const thread = getLoop(loop.id, cwd)!;
    const reports = thread.artifacts.filter((a) => a.type === 'verify_report');
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.iteration, 0, 'report attributed to the SNAPSHOT iteration (0), not the advanced (1)');
    assert.equal(hasPassingVerifyReportInIteration(thread, 1), false, 'iteration 1 is NOT falsely green');
    assert.equal(hasPassingVerifyReportInIteration(thread, 0), true, 'iteration 0 (the verified one) is green');
  });

  it('byte-fits an oversized multibyte report so a GREEN suite still records (review F2)', () => {
    const cwd = ws();
    const loop = openImpl(cwd, ['echo', 'ok']);
    // 1024 multibyte chars per tail → raw > 4 KiB, and each JSON-escapes to 6 bytes:
    // without byte-fitting, add_artifact's 4096-byte body cap would reject a green report.
    const big = '✓'.repeat(1024);
    const res = runVerify(
      { loop_id: loop.id, actor: 'agt_i', runner: runnerReturning({ exit_code: 0, passed: true, timed_out: false, duration_ms: 5, stdout_tail: big, stderr_tail: big }) },
      cwd,
    );
    assert.equal(res.report?.passed, true);
    const thread = getLoop(loop.id, cwd)!;
    assert.equal(thread.artifacts.filter((a) => a.type === 'verify_report').length, 1, 'the green report was recorded, not dropped');
    assert.ok(hasPassingVerifyReportInIteration(thread, thread.iteration_count), 'command_green satisfied despite oversized tails');
  });

  it('defaultVerifyRunner: a missing command → passed:false with the error (no crash)', () => {
    const cwd = ws();
    const r = defaultVerifyRunner({ command: ['this-command-does-not-exist-xyz-42'], cwd, timeout_ms: 10000 });
    assert.equal(r.passed, false);
    assert.equal(r.exit_code, null);
    assert.ok(r.stderr_tail.length > 0, 'the spawn error is surfaced in stderr_tail');
  });
});
