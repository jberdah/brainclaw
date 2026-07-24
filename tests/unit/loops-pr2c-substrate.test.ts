import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { deriveTurnId, deriveChildIds } from '../../src/core/loops/attempt-reservation.js';
import { buildAckWrapCommand } from '../../src/core/execution-adapters.js';
import {
  ensureRuntimeDirs, getRuntimeSignalPath, getRuntimeLogPath,
  readCompletionSignal, signalExists,
} from '../../src/core/runtime-signals.js';

// pln#630 PR2c-a substrate: deterministic turn_id + the turn-keyed completion
// body the ack-wrapper writes (the load-bearing evidence for read-strict).

describe('deriveTurnId (pln#630 PR2c §13 A2)', () => {
  it('is deterministic per (loop_id, slot_id, iteration) and tat_-prefixed', () => {
    const a = deriveTurnId('lop_x', 'lsl_r', 0);
    assert.equal(deriveTurnId('lop_x', 'lsl_r', 0), a, 'same inputs → same turn_id (dup dispatch adopts)');
    assert.match(a, /^tat_[0-9a-f]{16}$/);
  });
  it('differs across loop, slot, and iteration', () => {
    assert.notEqual(deriveTurnId('lop_x', 'lsl_r', 0), deriveTurnId('lop_y', 'lsl_r', 0));
    assert.notEqual(deriveTurnId('lop_x', 'lsl_r', 0), deriveTurnId('lop_x', 'lsl_s', 0));
    assert.notEqual(deriveTurnId('lop_x', 'lsl_r', 0), deriveTurnId('lop_x', 'lsl_r', 1));
    // derived child ids off the turn_id remain distinct too
    const t = deriveTurnId('lop_x', 'lsl_r', 0);
    assert.match(deriveChildIds(t).run_id, /^run_[0-9a-f]{16}$/);
  });
});

describe('buildAckWrapCommand turn-keyed completion body (pln#630 PR2c-a D2)', () => {
  let root: string;
  const asg = 'asgn_wraptest';
  const echo = { turn_id: 'tat_abc', run_id: 'run_def', nonce: 'tok-gen-1' };
  const isWin32 = process.platform === 'win32';

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wrap-')); ensureRuntimeDirs(root); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const paths = () => ({
    ackPath: getRuntimeSignalPath(root, asg, 'ack'),
    completedPath: getRuntimeSignalPath(root, asg, 'completed'),
    failedPath: getRuntimeSignalPath(root, asg, 'failed'),
    stdoutLog: getRuntimeLogPath(root, asg, 'stdout'),
    stderrLog: getRuntimeLogPath(root, asg, 'stderr'),
  });

  it('string form embeds the JSON body when turnEcho is present, empty marker when absent', () => {
    const withEcho = buildAckWrapCommand('node -e ""', paths(), isWin32, echo);
    assert.match(withEcho, /"turn_id":"tat_abc"/);
    assert.match(withEcho, /"nonce":"tok-gen-1"/);
    const legacy = buildAckWrapCommand('node -e ""', paths(), isWin32);
    assert.doesNotMatch(legacy, /turn_id/);
  });

  it('throws loudly on an out-of-class turnEcho value instead of silently corrupting the sentinel', () => {
    // A `"` desyncs cmd.exe quote-parity (no file written → non-convergence);
    // a `'` breaks out of the POSIX printf wrapper. Both must fail fast at the
    // embed site rather than emit a broken one-liner.
    for (const bad of [
      { turn_id: 'tat_abc', run_id: 'run_def', nonce: 'a"b' },
      { turn_id: 'tat_abc', run_id: 'run_def', nonce: "a'b" },
      { turn_id: 'tat_abc', run_id: 'has space', nonce: 'tok-1' },
      { turn_id: 'tat_&evil', run_id: 'run_def', nonce: 'tok-1' },
    ]) {
      assert.throws(() => buildAckWrapCommand('node -e ""', paths(), isWin32, bad), /shell-safe/);
    }
  });

  it('EXECUTED: a success wrapper writes a turn-keyed completed body that readCompletionSignal parses', () => {
    const cmd = buildAckWrapCommand('node -e ""', paths(), isWin32, echo);
    execSync(cmd, { cwd: root, stdio: 'ignore' });
    const body = readCompletionSignal(root, asg);
    assert.ok(body, 'a turn-keyed completed body was written and parsed');
    assert.equal(body!.turn_id, 'tat_abc');
    assert.equal(body!.run_id, 'run_def');
    assert.equal(body!.nonce, 'tok-gen-1');
    assert.equal(body!.status, 'completed');
  });

  it('EXECUTED: a failing command writes a turn-keyed failed body', () => {
    const cmd = buildAckWrapCommand('node -e "process.exit(1)"', paths(), isWin32, echo);
    execSync(cmd, { cwd: root, stdio: 'ignore' });
    const body = readCompletionSignal(root, asg);
    assert.ok(body);
    assert.equal(body!.status, 'failed');
    assert.equal(body!.nonce, 'tok-gen-1');
  });

  it('EXECUTED: legacy (no turnEcho) writes an empty presence marker → readCompletionSignal undefined', () => {
    const cmd = buildAckWrapCommand('node -e ""', paths(), isWin32);
    execSync(cmd, { cwd: root, stdio: 'ignore' });
    assert.equal(signalExists(root, asg, 'completed'), true, 'presence marker exists');
    assert.equal(readCompletionSignal(root, asg), undefined, 'but it is not turn-keyed evidence');
  });
});
