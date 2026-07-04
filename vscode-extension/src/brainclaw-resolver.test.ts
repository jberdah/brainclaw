/**
 * Unit tests for the brainclaw CLI resolver (trp#927 fix, pln#611).
 *
 * The resolver's job is to produce a spawn plan that `cp.spawn(shell:false)`
 * can execute directly on any OS — never a `.cmd` shim. Each of the three
 * tiers (local-bin, workspace-dist, global) is probed with the SAME mechanic
 * the MCP client uses. On failure every attempt is classified so the caller
 * can surface a speaking error.
 *
 * These tests exercise real `node` subprocesses against synthesised
 * cli.js fixtures, which is the only credible way to validate spawn
 * behaviour (mocking the shell layer would defeat the purpose).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatResolveError,
  probeScriptCandidate,
  resolveBrainclawSpawnPlan,
  workspaceDistCandidate,
  localCliCandidate,
  type ProbeAttempt,
} from './brainclaw-resolver';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-resolver-'));
}

function writeCliOk(script: string): void {
  fs.mkdirSync(path.dirname(script), { recursive: true });
  // A CLI stub that supports `--version` (exits 0) and `mcp` (exits 0).
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      'const arg = process.argv[2];',
      'if (arg === "--version") { process.stdout.write("stub 1.0.0\\n"); process.exit(0); }',
      'if (arg === "mcp") { process.exit(0); }',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeCliRequiringMissingModule(script: string): void {
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      '// Emulate a rased node_modules: script itself is present, but a',
      '// dependency it eagerly requires cannot be resolved.',
      'require("this-module-does-not-exist-brainclaw-test");',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeCliCrashesGeneric(script: string): void {
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      'console.error("boom: something else broke");',
      'process.exit(2);',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('brainclaw-resolver — probe classification (trp#927 fix)', () => {
  it('classifies a missing script file as binary-missing without spawning', async () => {
    const root = tmpDir();
    try {
      const script = path.join(root, 'nope.js');
      const attempt = await probeScriptCandidate('workspace-dist', script, root);
      assert.equal(attempt.outcome, 'binary-missing');
      assert.equal(attempt.script, script);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a working cli.js as ok', async () => {
    const root = tmpDir();
    try {
      const script = path.join(root, 'dist', 'cli.js');
      writeCliOk(script);
      const attempt = await probeScriptCandidate('workspace-dist', script, root);
      assert.equal(attempt.outcome, 'ok');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('probes with the same spawn options/env used for the real MCP spawn', async () => {
    const root = tmpDir();
    const previousAgent = process.env.BRAINCLAW_AGENT;
    const previousAgentId = process.env.BRAINCLAW_AGENT_ID;
    const previousAgentName = process.env.BRAINCLAW_AGENT_NAME;
    process.env.BRAINCLAW_AGENT = 'parent-agent';
    process.env.BRAINCLAW_AGENT_ID = 'parent-agent-id';
    process.env.BRAINCLAW_AGENT_NAME = 'parent-agent-name';
    try {
      const script = path.join(root, 'dist', 'cli.js');
      writeCliOk(script);
      const calls: Array<{ command: string; args: readonly string[]; options: cp.SpawnOptions }> = [];
      const spawnFn = ((command: string, args?: readonly string[], options?: cp.SpawnOptions) => {
        calls.push({ command, args: args ?? [], options: options ?? {} });
        const proc = new EventEmitter() as cp.ChildProcess;
        (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
        (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
        (proc as unknown as { kill: () => boolean }).kill = () => true;
        process.nextTick(() => proc.emit('exit', 0));
        return proc;
      }) as typeof cp.spawn;

      const attempt = await probeScriptCandidate('workspace-dist', script, root, { spawnFn });

      assert.equal(attempt.outcome, 'ok');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'node');
      assert.deepEqual(calls[0].args, [script, '--version']);
      assert.equal(calls[0].options.cwd, root);
      assert.equal(calls[0].options.shell, false);
      assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(calls[0].options.windowsHide, true);
      const env = calls[0].options.env as NodeJS.ProcessEnv;
      assert.equal(env.BRAINCLAW_OBSERVER, '1');
      assert.equal(env.BRAINCLAW_AGENT, undefined);
      assert.equal(env.BRAINCLAW_AGENT_ID, undefined);
      assert.equal(env.BRAINCLAW_AGENT_NAME, undefined);
    } finally {
      if (previousAgent === undefined) delete process.env.BRAINCLAW_AGENT;
      else process.env.BRAINCLAW_AGENT = previousAgent;
      if (previousAgentId === undefined) delete process.env.BRAINCLAW_AGENT_ID;
      else process.env.BRAINCLAW_AGENT_ID = previousAgentId;
      if (previousAgentName === undefined) delete process.env.BRAINCLAW_AGENT_NAME;
      else process.env.BRAINCLAW_AGENT_NAME = previousAgentName;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a script whose eager require() fails as module-missing (rased-node_modules regression)', async () => {
    // This is the shape of the trp#927 incident once we probe with the real
    // spawn mechanic: dist/cli.js is on disk, but node_modules got wiped so
    // one of its imports throws MODULE_NOT_FOUND. The old cp.exec probe
    // silently reported success on `brainclaw --version` via the global
    // shim; this test locks in the new behaviour.
    const root = tmpDir();
    try {
      const script = path.join(root, 'dist', 'cli.js');
      writeCliRequiringMissingModule(script);
      const attempt = await probeScriptCandidate('workspace-dist', script, root);
      assert.equal(attempt.outcome, 'module-missing');
      assert.match(attempt.detail ?? '', /Cannot find module|MODULE_NOT_FOUND/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies other non-zero exits as nonzero-exit (not module-missing)', async () => {
    const root = tmpDir();
    try {
      const script = path.join(root, 'dist', 'cli.js');
      writeCliCrashesGeneric(script);
      const attempt = await probeScriptCandidate('workspace-dist', script, root);
      assert.equal(attempt.outcome, 'nonzero-exit');
      assert.match(attempt.detail ?? '', /boom: something else broke/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('brainclaw-resolver — resolveBrainclawSpawnPlan tiers', () => {
  const skipGlobal = async () => undefined;

  it('picks the local-bin tier first when node_modules/brainclaw/dist/cli.js works', async () => {
    const root = tmpDir();
    try {
      writeCliOk(localCliCandidate(root));
      writeCliOk(workspaceDistCandidate(root));
      const result = await resolveBrainclawSpawnPlan(root, { whichBrainclaw: skipGlobal });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.plan.tier, 'local-bin');
      assert.equal(result.plan.command, 'node');
      assert.deepEqual(result.plan.args, [localCliCandidate(root)]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to workspace-dist when local-bin is absent', async () => {
    const root = tmpDir();
    try {
      writeCliOk(workspaceDistCandidate(root));
      const result = await resolveBrainclawSpawnPlan(root, { whichBrainclaw: skipGlobal });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.plan.tier, 'workspace-dist');
      assert.deepEqual(result.plan.args, [workspaceDistCandidate(root)]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to global via shim → cli.js target derivation (win32 shim path regression)', async () => {
    // Simulate the win32 layout: the shim itself is `brainclaw.cmd`, and
    // its concrete cli.js lives at `<dir>/node_modules/brainclaw/dist/cli.js`.
    // The resolver must NEVER hand the .cmd to spawn(shell:false) — it must
    // derive and probe the .js target instead.
    const root = tmpDir();
    const globalPrefix = tmpDir();
    try {
      const shimPath = path.join(globalPrefix, 'brainclaw.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\n');
      const globalCli = path.join(globalPrefix, 'node_modules', 'brainclaw', 'dist', 'cli.js');
      writeCliOk(globalCli);

      const result = await resolveBrainclawSpawnPlan(root, {
        whichBrainclaw: async () => shimPath,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.plan.tier, 'global');
      // The spawn plan must reference the .js file, not the .cmd shim.
      assert.equal(result.plan.script, globalCli);
      assert.equal(result.plan.command, 'node');
      assert.ok(!result.plan.script.endsWith('.cmd'), 'plan.script must never be a .cmd shim');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(globalPrefix, { recursive: true, force: true });
    }
  });

  it('falls back to global via POSIX npm prefix bin shim → lib/node_modules cli.js target', async () => {
    const root = tmpDir();
    const base = tmpDir();
    const globalPrefix = path.join(base, 'prefix with spaces');
    try {
      const shimPath = path.join(globalPrefix, 'bin', 'brainclaw');
      fs.mkdirSync(path.dirname(shimPath), { recursive: true });
      fs.writeFileSync(shimPath, '#!/bin/sh\n');
      const globalCli = path.join(globalPrefix, 'lib', 'node_modules', 'brainclaw', 'dist', 'cli.js');
      writeCliOk(globalCli);

      const result = await resolveBrainclawSpawnPlan(root, {
        whichBrainclaw: async () => shimPath,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.plan.tier, 'global');
      assert.equal(result.plan.script, globalCli);
      assert.equal(result.plan.command, 'node');
      assert.deepEqual(result.plan.args, [globalCli]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('records global-tier binary-missing when the shim path has no derivable cli.js target', async () => {
    const root = tmpDir();
    const globalPrefix = tmpDir();
    try {
      const shimPath = path.join(globalPrefix, 'brainclaw.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\n');
      // Deliberately do NOT create node_modules/brainclaw/dist/cli.js.

      const result = await resolveBrainclawSpawnPlan(root, {
        whichBrainclaw: async () => shimPath,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      const global = result.attempts.find((a) => a.tier === 'global');
      assert.ok(global, 'expected a global attempt');
      assert.equal(global!.outcome, 'binary-missing');
      assert.match(global!.detail ?? '', /cli\.js target could not be located/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(globalPrefix, { recursive: true, force: true });
    }
  });

  it('regression: dist/cli.js present but node_modules rased → speaking error names the fix', async () => {
    // The exact shape of the trp#927 incident, but locked in end-to-end
    // through the tier walker: no local-bin, workspace dist/cli.js present
    // but its imports fail, no global. The error message must name what
    // was tried, why it failed, and hint at `npm ci`.
    const root = tmpDir();
    try {
      writeCliRequiringMissingModule(workspaceDistCandidate(root));
      const result = await resolveBrainclawSpawnPlan(root, { whichBrainclaw: async () => undefined });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Could not locate a runnable brainclaw/);
      assert.match(result.error, /workspace-dist/);
      assert.match(result.error, /module missing/);
      assert.match(result.error, /npm ci/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('when nothing is installed anywhere, the error hints at install commands', async () => {
    const root = tmpDir();
    try {
      const result = await resolveBrainclawSpawnPlan(root, { whichBrainclaw: async () => undefined });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Could not locate a runnable brainclaw/);
      assert.match(result.error, /npm i (-g )?brainclaw/);
      // Every non-global attempt must be reported as binary-missing.
      const nonGlobal = result.attempts.filter((a) => a.tier !== 'global');
      for (const attempt of nonGlobal) {
        assert.equal(attempt.outcome, 'binary-missing');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('brainclaw-resolver — formatResolveError', () => {
  it('lists every attempt with its classified outcome', () => {
    const attempts: ProbeAttempt[] = [
      { tier: 'local-bin', script: '/a/node_modules/brainclaw/dist/cli.js', outcome: 'binary-missing' },
      {
        tier: 'workspace-dist',
        script: '/a/dist/cli.js',
        outcome: 'module-missing',
        detail: "Error: Cannot find module 'foo'",
      },
      { tier: 'global', script: '/g/cli.js', outcome: 'timeout' },
    ];
    const msg = formatResolveError(attempts);
    assert.match(msg, /\[local-bin\].*binary-missing|script file not present/);
    assert.match(msg, /\[workspace-dist\].*module missing/);
    assert.match(msg, /\[global\].*timed out/);
    // Hint should key off the module-missing attempt.
    assert.match(msg, /npm ci/);
  });

  it('degrades gracefully on empty attempts (should not throw)', () => {
    const msg = formatResolveError([]);
    assert.match(msg, /no candidates were probed/);
  });
});
