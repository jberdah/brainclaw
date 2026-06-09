/**
 * Tests for pln#504: per-assignment stdout/stderr capture in CliExecutionAdapter.
 *
 * The goal is to make silent worker deaths (trp#292) diagnosable. Before pln#504,
 * spawned worker stdout/stderr was wired to 'ignore'. Now, when an assignmentId
 * is provided alongside ackRoot/worktreePath, the adapter opens per-assignment
 * log files at `.brainclaw/coordination/runtime/log/<asgn>.{stdout,stderr}.log`
 * and routes the child's streams there.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultExecutionAdapter } from '../../src/core/execution-adapters.js';
import type { InvokeCommand } from '../../src/core/agent-capability.js';

function createTestWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-spawn-log-'));
}

function cleanupWorkspace(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Wait up to maxMs for a predicate to hold, polling every 50ms. */
async function waitFor(predicate: () => boolean, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Build an InvokeCommand that runs an arbitrary node -e snippet.
 * We piggyback on node being a stable system binary on PATH so we don't depend
 * on having codex/claude installed in the test environment.
 */
function nodeInvoke(snippet: string): InvokeCommand {
  const arg = `-e`;
  // bashCommand runs through a shell:true spawn (cmd on Windows, sh on Linux)
  // inside the ack-wrap; `\"` is the correct in-double-quote escape for BOTH
  // shells. Escaping only on Windows left the Linux/sh command broken — node
  // got a split, syntactically-invalid script and wrote nothing (CI red on
  // ubuntu, green on windows). args[] is for the no-shell path → raw snippet.
  const escapedForShell = snippet.replace(/"/g, '\\"');
  return {
    executable: 'node',
    args: [arg, snippet],
    bashCommand: `node ${arg} "${escapedForShell}"`,
    promptDelivery: 'inline_arg',
    shell: false,
  } as InvokeCommand;
}

describe('CliExecutionAdapter — stdout/stderr capture (pln#504)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  it('writes child stdout to .brainclaw/coordination/runtime/log/<asgn>.stdout.log', async () => {
    const assignmentId = 'asgn_test_stdout';
    const result = defaultExecutionAdapter.start(
      nodeInvoke('console.log("hello stdout");'),
      { agent: 'node-test', assignmentId, ackRoot: workspace, worktreePath: workspace },
    );
    assert.ok(result.pid > 0, 'spawn should return a pid');

    const stdoutPath = path.join(workspace, '.brainclaw', 'coordination', 'runtime', 'log', `${assignmentId}.stdout.log`);
    const ok = await waitFor(() => {
      try {
        const content = fs.readFileSync(stdoutPath, 'utf-8');
        return content.includes('hello stdout');
      } catch { return false; }
    }, 5000);

    assert.ok(ok, `expected stdout log at ${stdoutPath} to contain "hello stdout" within 5s`);
  });

  it('writes child stderr to .brainclaw/coordination/runtime/log/<asgn>.stderr.log', async () => {
    const assignmentId = 'asgn_test_stderr';
    defaultExecutionAdapter.start(
      nodeInvoke('console.error("hello stderr");'),
      { agent: 'node-test', assignmentId, ackRoot: workspace, worktreePath: workspace },
    );

    const stderrPath = path.join(workspace, '.brainclaw', 'coordination', 'runtime', 'log', `${assignmentId}.stderr.log`);
    const ok = await waitFor(() => {
      try {
        const content = fs.readFileSync(stderrPath, 'utf-8');
        return content.includes('hello stderr');
      } catch { return false; }
    }, 5000);

    assert.ok(ok, `expected stderr log at ${stderrPath} to contain "hello stderr" within 5s`);
  });

  it('also creates the brief-ack sentinel alongside the log files', async () => {
    const assignmentId = 'asgn_test_ack_and_log';
    defaultExecutionAdapter.start(
      nodeInvoke('console.log("done");'),
      { agent: 'node-test', assignmentId, ackRoot: workspace, worktreePath: workspace },
    );

    const ackPath = path.join(workspace, '.brainclaw', 'coordination', 'runtime', 'ack', `${assignmentId}.ack`);
    const logDir = path.join(workspace, '.brainclaw', 'coordination', 'runtime', 'log');

    const sentinelOk = await waitFor(() => fs.existsSync(ackPath), 5000);
    assert.ok(sentinelOk, `expected ack sentinel at ${ackPath} within 5s`);

    const stdoutOk = await waitFor(() => {
      const p = path.join(logDir, `${assignmentId}.stdout.log`);
      return fs.existsSync(p);
    }, 5000);
    assert.ok(stdoutOk, `expected stdout log file to exist within 5s`);
  });

  it('does not create log files when assignmentId is omitted (legacy direct spawn)', async () => {
    // Without assignmentId, the adapter takes the direct-spawn branch and keeps
    // the legacy "stdout/stderr ignored" behaviour. The log dir should stay empty.
    defaultExecutionAdapter.start(
      nodeInvoke('console.log("should-not-be-logged");'),
      { agent: 'node-test', worktreePath: workspace },
    );

    // Give the child a moment to finish, then assert no log dir was created.
    await new Promise((r) => setTimeout(r, 500));
    const logDir = path.join(workspace, '.brainclaw', 'coordination', 'runtime', 'log');
    assert.equal(fs.existsSync(logDir), false, 'log dir should not be created without an assignmentId');
  });
});
