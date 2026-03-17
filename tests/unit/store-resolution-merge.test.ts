import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../../src/core/context.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { loadState, saveState } from '../../src/core/state.js';

function makeTmpDir(prefix = 'bclaw-merge-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initStore(dir: string, projectName = 'test', projectId?: string): void {
  ensureMemoryDir(dir);
  const cfg = defaultConfig(projectName, { projectId: projectId ?? `prj_${projectName}` });
  saveConfig(cfg, dir);
}

function addDecision(dir: string, id: string, text: string): void {
  const state = loadState(dir);
  state.recent_decisions.push({
    id,
    text,
    author: 'test',
    author_id: 'agt_test',
    project_id: 'prj_test',
    created_at: new Date().toISOString(),
    tags: [],
  });
  saveState(state, dir);
}

function addTrap(dir: string, id: string, text: string, severity: 'low' | 'medium' | 'high' = 'low'): void {
  const state = loadState(dir);
  state.known_traps.push({
    id,
    text,
    severity,
    visibility: 'shared' as const,
    author: 'test',
    author_id: 'agt_test',
    project_id: 'prj_test',
    created_at: new Date().toISOString(),
    tags: [],
  });
  saveState(state, dir);
}

function addConstraint(dir: string, id: string, text: string): void {
  const state = loadState(dir);
  state.active_constraints.push({
    id,
    text,
    status: 'active',
    author: 'test',
    author_id: 'agt_test',
    project_id: 'prj_test',
    created_at: new Date().toISOString(),
    tags: [],
  });
  saveState(state, dir);
}

describe('multi-store context merge', () => {
  it('single store returns no stores field', () => {
    const root = makeTmpDir();
    try {
      initStore(root, 'solo', 'prj_solo');
      const ctx = buildContext({ cwd: root });
      assert.equal(ctx.stores, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('two-level hierarchy: items from parent appear in context', () => {
    const workspace = makeTmpDir();
    try {
      // workspace store at root
      initStore(workspace, 'workspace', 'prj_workspace');
      addDecision(workspace, 'dec_workspace_01', 'Global workspace decision');
      addTrap(workspace, 'trap_workspace_01', 'Global workspace trap', 'high');

      // service store as child
      const serviceDir = path.join(workspace, 'services', 'app1');
      fs.mkdirSync(serviceDir, { recursive: true });
      initStore(serviceDir, 'app1', 'prj_app1');
      addDecision(serviceDir, 'dec_app1_01', 'App1 local decision');

      const ctx = buildContext({ cwd: serviceDir });

      // stores chain should be present
      assert.ok(ctx.stores, 'stores chain should be present in multi-store context');
      assert.equal(ctx.stores!.length, 2);

      const ids = ctx.selected.map((i) => i.id);

      // local decision is included
      assert.ok(ids.includes('dec_app1_01'), 'local app1 decision should be included');
      // parent decision is included (if within maxItems)
      assert.ok(ids.includes('dec_workspace_01'), 'workspace decision should be merged in');
      assert.ok(ids.includes('trap_workspace_01'), 'workspace trap should be merged in');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('items from parent are tagged with [from:<role>]', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace', 'prj_ws');
      // mark workspace store_type in config
      const cfgPath = path.join(workspace, '.brainclaw', 'config.yaml');
      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf-8') + 'store_type: workspace\n');
      addConstraint(workspace, 'cst_ws_01', 'Workspace-level constraint');

      const serviceDir = path.join(workspace, 'app');
      fs.mkdirSync(serviceDir, { recursive: true });
      initStore(serviceDir, 'app', 'prj_app');

      const ctx = buildContext({ cwd: serviceDir });
      const parentConstraint = ctx.selected.find((i) => i.id === 'cst_ws_01');
      assert.ok(parentConstraint, 'parent constraint should appear in merged context');
      assert.ok(parentConstraint!.extra?.includes('[from:workspace]'), `extra should contain [from:workspace], got: ${parentConstraint!.extra}`);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('duplicate IDs across stores appear only once', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace', 'prj_ws');
      addDecision(workspace, 'dec_shared_01', 'Same decision in both stores');

      const serviceDir = path.join(workspace, 'svc');
      fs.mkdirSync(serviceDir, { recursive: true });
      initStore(serviceDir, 'svc', 'prj_svc');
      addDecision(serviceDir, 'dec_shared_01', 'Same decision in both stores');

      const ctx = buildContext({ cwd: serviceDir });
      const matches = ctx.selected.filter((i) => i.id === 'dec_shared_01');
      assert.equal(matches.length, 1, 'duplicate IDs should appear only once');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('three-level hierarchy: workspace > repo > service all merged', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'workspace', 'prj_ws');
      addConstraint(workspace, 'cst_ws_01', 'Workspace constraint');

      const repo = path.join(workspace, 'repo');
      fs.mkdirSync(repo, { recursive: true });
      initStore(repo, 'repo', 'prj_repo');
      addTrap(repo, 'trap_repo_01', 'Repo-level trap');

      const svc = path.join(repo, 'services', 'auth');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'auth', 'prj_auth');
      addDecision(svc, 'dec_auth_01', 'Auth service decision');

      const ctx = buildContext({ cwd: svc });
      assert.ok(ctx.stores, 'stores chain present');
      assert.equal(ctx.stores!.length, 3, 'three stores in chain');

      const ids = ctx.selected.map((i) => i.id);
      assert.ok(ids.includes('dec_auth_01'), 'local service decision');
      assert.ok(ids.includes('trap_repo_01'), 'repo-level trap merged in');
      assert.ok(ids.includes('cst_ws_01'), 'workspace constraint merged in');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('stores field is ordered closest-first', () => {
    const workspace = makeTmpDir();
    try {
      initStore(workspace, 'ws');
      const svc = path.join(workspace, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'svc');

      const ctx = buildContext({ cwd: svc });
      assert.ok(ctx.stores!.length >= 2);
      assert.equal(ctx.stores![0].depth, 0, 'first store is closest (depth 0)');
      assert.ok(ctx.stores![1].depth > 0, 'second store is farther');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
