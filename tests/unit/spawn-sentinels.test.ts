/**
 * pln#520 step 4 — spawn observability via shell-level sentinels.
 *
 * The ack-wrap now (a) touches `ack` pre-exec, (b) redirects the agent's
 * stdout/stderr to per-assignment log files AT THE SHELL LEVEL (fds don't
 * inherit through the cmd.exe→.cmd→node shim — can_f792cacd), and (c) emits a
 * `completed`/`failed` sentinel from the agent's exit code so a dead wrapper
 * pid is never misread as a silent failure.
 *
 * Pure-string tests cover the wrapped-command shape on both platforms; a real
 * `node` round-trip validates the mechanism end-to-end without needing
 * claude/codex installed (the agent-specific shim still needs live validation).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAckWrapCommand,
  defaultExecutionAdapter,
  type AckWrapPaths,
} from '../../src/core/execution-adapters.js';
import {
  getRuntimeSignalPath,
  getRuntimeLogPath,
  readHeartbeat,
} from '../../src/core/runtime-signals.js';
import type { InvokeCommand } from '../../src/core/agent-capability.js';

const PATHS: AckWrapPaths = {
  ackPath: '/r/ack/a.ack',
  completedPath: '/r/signal/a.completed',
  failedPath: '/r/signal/a.failed',
  stdoutLog: '/r/log/a.stdout.log',
  stderrLog: '/r/log/a.stderr.log',
};

describe('buildAckWrapCommand (pln#520 step 4)', () => {
  it('POSIX: ack, then redirected agent cmd, then completed||failed', () => {
    const cmd = buildAckWrapCommand('claude -p "hi"', PATHS, false);
    assert.ok(cmd.startsWith('touch "/r/ack/a.ack" &&'), `ack first: ${cmd}`);
    assert.ok(cmd.includes('claude -p "hi" > "/r/log/a.stdout.log" 2> "/r/log/a.stderr.log"'), `redirect: ${cmd}`);
    assert.ok(cmd.includes('&& touch "/r/signal/a.completed" || touch "/r/signal/a.failed"'), `completion: ${cmd}`);
  });

  it('Windows: uses `type nul >` for the sentinels', () => {
    const cmd = buildAckWrapCommand('claude -p "hi"', PATHS, true);
    assert.ok(cmd.startsWith('type nul > "/r/ack/a.ack" &&'), `ack first: ${cmd}`);
    assert.ok(cmd.includes('> "/r/log/a.stdout.log" 2> "/r/log/a.stderr.log"'), `redirect: ${cmd}`);
    assert.ok(cmd.includes('&& type nul > "/r/signal/a.completed" || type nul > "/r/signal/a.failed"'), `completion: ${cmd}`);
  });

  it('keeps the agent command inside a group so stdin is inherited (only stdout/stderr redirected)', () => {
    const cmd = buildAckWrapCommand('printf x | claude -p', PATHS, false);
    // The pipe stays intact ahead of the redirect — prompt delivery preserved.
    assert.ok(cmd.includes('( printf x | claude -p > '), `grouped pipeline: ${cmd}`);
  });
});

function nodeInvoke(snippet: string): InvokeCommand {
  // `\"` is the correct in-double-quote escape for BOTH cmd and sh; escaping
  // only on Windows broke the Linux/sh ack-wrap path. args[] = raw snippet.
  const escaped = snippet.replace(/"/g, '\\"');
  return {
    executable: 'node',
    args: ['-e', snippet],
    bashCommand: `node -e "${escaped}"`,
    promptDelivery: 'inline_arg',
    shell: false,
  } as InvokeCommand;
}

async function waitFor(predicate: () => boolean, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('ack-wrap spawn round-trip (pln#520 step 4)', () => {
  let workspace: string;
  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-sentinel-')); });
  afterEach(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('a successful agent writes the `completed` sentinel + captures stdout', async () => {
    const id = 'asgn_ok';
    defaultExecutionAdapter.start(
      nodeInvoke('console.log("worked");'),
      { agent: 'node-test', assignmentId: id, ackRoot: workspace, worktreePath: workspace },
    );
    const completed = getRuntimeSignalPath(workspace, id, 'completed');
    assert.ok(await waitFor(() => fs.existsSync(completed), 5000), 'completed sentinel written');
    assert.equal(fs.existsSync(getRuntimeSignalPath(workspace, id, 'failed')), false, 'no failed sentinel');
    const out = fs.readFileSync(getRuntimeLogPath(workspace, id, 'stdout'), 'utf-8');
    assert.ok(out.includes('worked'), `stdout captured via shell redirect: ${out}`);
  });

  it('a failing agent writes the `failed` sentinel, not `completed`', async () => {
    const id = 'asgn_fail';
    defaultExecutionAdapter.start(
      nodeInvoke('process.exit(1);'),
      { agent: 'node-test', assignmentId: id, ackRoot: workspace, worktreePath: workspace },
    );
    const failed = getRuntimeSignalPath(workspace, id, 'failed');
    assert.ok(await waitFor(() => fs.existsSync(failed), 5000), 'failed sentinel written');
    assert.equal(fs.existsSync(getRuntimeSignalPath(workspace, id, 'completed')), false, 'no completed sentinel');
  });

  it('the ack sentinel is still written pre-exec', async () => {
    const id = 'asgn_ack';
    defaultExecutionAdapter.start(
      nodeInvoke('console.log("x");'),
      { agent: 'node-test', assignmentId: id, ackRoot: workspace, worktreePath: workspace },
    );
    assert.ok(await waitFor(() => fs.existsSync(getRuntimeSignalPath(workspace, id, 'ack')), 5000), 'ack written');
  });
});

describe('readHeartbeat (pln#520 step 1 data channel)', () => {
  let workspace: string;
  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hb-')); });
  afterEach(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('reports absent when no heartbeat exists', () => {
    assert.equal(readHeartbeat(workspace, 'asgn_x').exists, false);
  });

  it('parses work_loop_reached{run_id,nonce} and exposes mtime', () => {
    const p = getRuntimeSignalPath(workspace, 'asgn_x', 'heartbeat');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ run_id: 'run_abc', nonce: 'n1' }));
    const hb = readHeartbeat(workspace, 'asgn_x');
    assert.equal(hb.exists, true);
    assert.equal(hb.runId, 'run_abc');
    assert.equal(hb.nonce, 'n1');
    assert.ok(typeof hb.mtimeMs === 'number' && hb.mtimeMs > 0);
  });

  it('a bare (empty) heartbeat file still counts as a life-sign', () => {
    const p = getRuntimeSignalPath(workspace, 'asgn_y', 'heartbeat');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    const hb = readHeartbeat(workspace, 'asgn_y');
    assert.equal(hb.exists, true);
    assert.equal(hb.runId, undefined);
  });
});
