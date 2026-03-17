import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTargetStore } from '../../src/core/store-resolution.js';
import { runPlan } from '../../src/commands/plan.js';
import { runTrap } from '../../src/commands/trap.js';
import { loadState } from '../../src/core/state.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';

function makeTmpDir(prefix = 'bclaw-write-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initStore(dir: string, storeType?: 'workspace' | 'repo' | 'service'): void {
  ensureMemoryDir(dir);
  const cfg = defaultConfig('test', { projectId: `prj_${path.basename(dir)}` });
  saveConfig(cfg, dir);
  if (storeType) {
    const cfgPath = path.join(dir, '.brainclaw', 'config.yaml');
    fs.appendFileSync(cfgPath, `store_type: ${storeType}\n`);
  }
}

describe('resolveTargetStore', () => {
  it('local returns the given cwd unchanged', () => {
    const root = makeTmpDir();
    try {
      initStore(root);
      assert.equal(resolveTargetStore(root, 'local'), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('workspace resolves to the farthest store when no role declared', () => {
    const root = makeTmpDir();
    try {
      initStore(root);
      const svc = path.join(root, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc);
      const resolved = resolveTargetStore(svc, 'workspace');
      assert.equal(resolved, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('workspace resolves to declared workspace store', () => {
    const root = makeTmpDir();
    try {
      initStore(root, 'workspace');
      const mid = path.join(root, 'repo');
      fs.mkdirSync(mid, { recursive: true });
      initStore(mid, 'repo');
      const svc = path.join(mid, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');
      const resolved = resolveTargetStore(svc, 'workspace');
      assert.equal(resolved, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('repo resolves to .git sibling store', () => {
    const root = makeTmpDir();
    try {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      initStore(root);
      const svc = path.join(root, 'services', 'app');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');
      const resolved = resolveTargetStore(svc, 'repo');
      assert.equal(resolved, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to closest store when target role not found', () => {
    const root = makeTmpDir();
    try {
      initStore(root, 'workspace');
      const svc = path.join(root, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');
      // asking for 'repo' but no repo store exists → closest
      const resolved = resolveTargetStore(svc, 'repo');
      assert.equal(resolved, svc);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns cwd when chain is empty (no stores at all)', () => {
    const root = makeTmpDir();
    try {
      const resolved = resolveTargetStore(root, 'workspace');
      assert.equal(resolved, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('directed writes via --store option', () => {
  it('plan --store workspace writes to workspace store', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace');
      const svc = path.join(workspace, 'app');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');

      const prev = process.cwd();
      process.chdir(svc);
      try {
        runPlan('cross-cutting workspace plan', { store: 'workspace', cwd: svc });
      } finally {
        process.chdir(prev);
      }

      // plan should be in workspace store, NOT in svc store
      const wsState = loadState(workspace);
      const svcState = loadState(svc);
      assert.ok(wsState.plan_items.some((p) => p.text === 'cross-cutting workspace plan'), 'plan should be in workspace store');
      assert.ok(!svcState.plan_items.some((p) => p.text === 'cross-cutting workspace plan'), 'plan should NOT be in local store');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('trap --store workspace writes to workspace store', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace');
      const svc = path.join(workspace, 'app');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');

      runTrap('workspace-level trap', { store: 'workspace', cwd: svc });

      const wsState = loadState(workspace);
      const svcState = loadState(svc);
      assert.ok(wsState.known_traps.some((t) => t.text === 'workspace-level trap'), 'trap should be in workspace store');
      assert.ok(!svcState.known_traps.some((t) => t.text === 'workspace-level trap'), 'trap should NOT be in local store');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('plan defaults to local store when --store not given', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace');
      const svc = path.join(workspace, 'app');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');

      runPlan('local plan', { cwd: svc });

      const svcState = loadState(svc);
      const wsState = loadState(workspace);
      assert.ok(svcState.plan_items.some((p) => p.text === 'local plan'), 'plan should be in local store');
      assert.ok(!wsState.plan_items.some((p) => p.text === 'local plan'), 'plan should NOT be in workspace store');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
