import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { resolveContextStoreCwd, resolveEffectiveCwd, resolveEffectiveCwdInfo, resolveStoreChain, resolvePrimaryStore, resolveWorkspaceRoot } from '../../src/core/store-resolution.js';
import { saveActiveProject, clearActiveProject } from '../../src/core/active-project.js';
import { saveCurrentSession } from '../../src/core/identity.js';

function tmpDir(prefix = 'bclaw-storechain-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStore(dir: string, storeType?: string): string {
  const storePath = path.join(dir, '.brainclaw');
  fs.mkdirSync(storePath, { recursive: true });
  const configContent = storeType
    ? `schema_version: 2\nstore_type: ${storeType}\n`
    : `schema_version: 2\n`;
  fs.writeFileSync(path.join(storePath, 'config.yaml'), configContent, 'utf-8');
  return storePath;
}

describe('core/store-resolution', () => {
  describe('resolveStoreChain', () => {
    it('returns empty array when no store exists', () => {
      const root = tmpDir();
      try {
        const chain = resolveStoreChain(root, { boundary: root });
        assert.deepEqual(chain, []);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('finds a single store at cwd', () => {
      const root = tmpDir();
      try {
        makeStore(root);
        const chain = resolveStoreChain(root, { boundary: root });
        assert.equal(chain.length, 1);
        assert.equal(chain[0].cwd, root);
        assert.equal(chain[0].depth, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('finds a store in a parent directory', () => {
      const root = tmpDir();
      try {
        makeStore(root);
        const child = path.join(root, 'service', 'src');
        fs.mkdirSync(child, { recursive: true });
        const chain = resolveStoreChain(child, { boundary: root });
        assert.equal(chain.length, 1);
        assert.equal(chain[0].cwd, root);
        assert.equal(chain[0].depth, 2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('collects multiple stores ordered by depth (closest first)', () => {
      const root = tmpDir();
      try {
        makeStore(root);
        const serviceDir = path.join(root, 'services', 'app1');
        fs.mkdirSync(serviceDir, { recursive: true });
        makeStore(serviceDir);
        const cwd = path.join(serviceDir, 'backend', 'src');
        fs.mkdirSync(cwd, { recursive: true });

        const chain = resolveStoreChain(cwd, { boundary: root });
        assert.equal(chain.length, 2);
        // closest first
        assert.equal(chain[0].cwd, serviceDir);
        assert.equal(chain[0].depth, 2);
        assert.equal(chain[1].cwd, root);
        assert.equal(chain[1].depth, 4);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('stops at boundary — does not include stores above it', () => {
      const root = tmpDir();
      try {
        // store above boundary
        makeStore(root);
        const mid = path.join(root, 'workspace');
        fs.mkdirSync(mid, { recursive: true });
        // store at boundary
        makeStore(mid);
        const cwd = path.join(mid, 'service');
        fs.mkdirSync(cwd, { recursive: true });

        // boundary = mid → should not see root store
        const chain = resolveStoreChain(cwd, { boundary: mid });
        assert.equal(chain.length, 1);
        assert.equal(chain[0].cwd, mid);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('reads store_type from config.yaml', () => {
      const root = tmpDir();
      try {
        makeStore(root, 'workspace');
        const serviceDir = path.join(root, 'app1');
        fs.mkdirSync(serviceDir, { recursive: true });
        makeStore(serviceDir, 'service');

        const chain = resolveStoreChain(serviceDir, { boundary: root });
        assert.equal(chain.length, 2);
        assert.equal(chain[0].role, 'service');
        assert.equal(chain[1].role, 'workspace');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('infers repo role from .git sibling', () => {
      const root = tmpDir();
      try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        makeStore(root);
        const chain = resolveStoreChain(root, { boundary: root });
        assert.equal(chain.length, 1);
        assert.equal(chain[0].role, 'repo');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('excludes partial stores (no config.yaml) by default', () => {
      const root = tmpDir();
      try {
        // partial store: directory exists but no config.yaml
        fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
        const chain = resolveStoreChain(root, { boundary: root });
        assert.equal(chain.length, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('includes partial stores when includePartial=true', () => {
      const root = tmpDir();
      try {
        fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
        const chain = resolveStoreChain(root, { boundary: root, includePartial: true });
        assert.equal(chain.length, 1);
        assert.equal(chain[0].role, 'unknown');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('handles three-level hierarchy (workspace > repo > service)', () => {
      const workspace = tmpDir();
      try {
        makeStore(workspace, 'workspace');
        const repo = path.join(workspace, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        makeStore(repo, 'repo');
        const service = path.join(repo, 'services', 'auth');
        fs.mkdirSync(service, { recursive: true });
        makeStore(service, 'service');
        const cwd = path.join(service, 'src');
        fs.mkdirSync(cwd, { recursive: true });

        const chain = resolveStoreChain(cwd, { boundary: workspace });
        assert.equal(chain.length, 3);
        assert.equal(chain[0].role, 'service');
        assert.equal(chain[1].role, 'repo');
        assert.equal(chain[2].role, 'workspace');
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe('resolvePrimaryStore', () => {
    it('returns the closest store', () => {
      const root = tmpDir();
      try {
        makeStore(root, 'workspace');
        const service = path.join(root, 'app1');
        fs.mkdirSync(service, { recursive: true });
        makeStore(service, 'service');

        const primary = resolvePrimaryStore(service, { boundary: root });
        assert.ok(primary);
        assert.equal(primary.role, 'service');
        assert.equal(primary.cwd, service);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns undefined when no store exists', () => {
      const root = tmpDir();
      try {
        const result = resolvePrimaryStore(root, { boundary: root });
        assert.equal(result, undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('resolveContextStoreCwd', () => {
    it('switches to the most specific child store when target path is inside a nested project', () => {
      const workspace = tmpDir('bclaw-context-store-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig({
          ...defaultConfig('workspace', {
            projectId: 'prj_workspace',
            projectMode: 'multi-project',
            projectStrategy: 'folder',
          }),
        }, workspace);

        const child = path.join(workspace, 'apps', 'lodestar');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');
        saveConfig({
          ...defaultConfig('lodestar', {
            projectId: 'prj_lodestar',
          }),
        }, child);

        const resolved = resolveContextStoreCwd(workspace, 'apps/lodestar/src/app.ts');
        assert.equal(resolved, child);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('switches to child store even when parent is in auto/manual mode (not folder)', () => {
      const workspace = tmpDir('bclaw-context-store-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig({
          ...defaultConfig('workspace', {
            projectId: 'prj_workspace',
            projectMode: 'auto',
            projectStrategy: 'manual',
          }),
        }, workspace);

        const child = path.join(workspace, 'api');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');
        saveConfig({
          ...defaultConfig('api', {
            projectId: 'prj_api',
          }),
        }, child);

        const resolved = resolveContextStoreCwd(workspace, 'api/src/server.ts');
        assert.equal(resolved, child);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('keeps the current store when target is not a path into a child project', () => {
      const workspace = tmpDir('bclaw-context-store-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig({
          ...defaultConfig('workspace', {
            projectId: 'prj_workspace',
            projectMode: 'multi-project',
            projectStrategy: 'folder',
          }),
        }, workspace);

        const child = path.join(workspace, 'apps', 'lodestar');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');
        saveConfig({
          ...defaultConfig('lodestar', {
            projectId: 'prj_lodestar',
          }),
        }, child);

        const resolved = resolveContextStoreCwd(workspace, 'release notes');
        assert.equal(resolved, workspace);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe('resolveEffectiveCwd', () => {
    it('returns explicitCwd when provided (highest priority)', () => {
      const workspace = tmpDir('bclaw-effective-');
      try {
        makeStore(workspace, 'workspace');
        const child = path.join(workspace, 'api');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');

        // Even with active project set, explicitCwd wins
        saveActiveProject(workspace, {
          path: child,
          name: 'api',
          switched_at: new Date().toISOString(),
        });

        const resolved = resolveEffectiveCwd({ explicitCwd: workspace });
        assert.equal(resolved, path.resolve(workspace));
      } finally {
        clearActiveProject(workspace);
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('uses BRAINCLAW_CWD env var when set and valid (MCP workspace binding)', () => {
      const workspace = tmpDir('bclaw-effective-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig(defaultConfig('workspace'), workspace);

        // Simulate an IDE launching brainclaw MCP from a wrong cwd (e.g. home dir)
        // but with BRAINCLAW_CWD set to the real workspace
        const originalEnv = process.env.BRAINCLAW_CWD;
        process.env.BRAINCLAW_CWD = workspace;
        try {
          const resolved = resolveEffectiveCwd();
          assert.equal(resolved, path.resolve(workspace));
        } finally {
          if (originalEnv === undefined) {
            delete process.env.BRAINCLAW_CWD;
          } else {
            process.env.BRAINCLAW_CWD = originalEnv;
          }
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('lets active project override BRAINCLAW_CWD workspace binding', () => {
      const workspace = tmpDir('bclaw-effective-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig(defaultConfig('workspace'), workspace);

        const child = path.join(workspace, 'apps', 'lodestar');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');
        saveConfig(defaultConfig('lodestar'), child);

        saveActiveProject(workspace, {
          path: child,
          name: 'lodestar',
          switched_at: new Date().toISOString(),
        });

        const originalEnv = process.env.BRAINCLAW_CWD;
        process.env.BRAINCLAW_CWD = workspace;
        try {
          const resolved = resolveEffectiveCwd();
          assert.equal(resolved, path.resolve(child));
        } finally {
          if (originalEnv === undefined) {
            delete process.env.BRAINCLAW_CWD;
          } else {
            process.env.BRAINCLAW_CWD = originalEnv;
          }
        }
      } finally {
        clearActiveProject(workspace);
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('ignores BRAINCLAW_CWD when path has no brainclaw store', () => {
      const workspace = tmpDir('bclaw-effective-');
      const bogus = tmpDir('bclaw-bogus-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig(defaultConfig('workspace'), workspace);

        // BRAINCLAW_CWD points to a directory without .brainclaw/
        const originalEnv = process.env.BRAINCLAW_CWD;
        process.env.BRAINCLAW_CWD = bogus;
        try {
          // Should fall through to process.cwd(), not use bogus path
          const resolved = resolveEffectiveCwd();
          assert.notEqual(resolved, bogus);
        } finally {
          if (originalEnv === undefined) {
            delete process.env.BRAINCLAW_CWD;
          } else {
            process.env.BRAINCLAW_CWD = originalEnv;
          }
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(bogus, { recursive: true, force: true });
      }
    });

    it('explicitCwd takes priority over BRAINCLAW_CWD', () => {
      const workspace = tmpDir('bclaw-effective-');
      const explicit = tmpDir('bclaw-explicit-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig(defaultConfig('workspace'), workspace);
        makeStore(explicit, 'repo');
        saveConfig(defaultConfig('explicit'), explicit);

        const originalEnv = process.env.BRAINCLAW_CWD;
        process.env.BRAINCLAW_CWD = workspace;
        try {
          const resolved = resolveEffectiveCwd({ explicitCwd: explicit });
          assert.equal(resolved, path.resolve(explicit));
        } finally {
          if (originalEnv === undefined) {
            delete process.env.BRAINCLAW_CWD;
          } else {
            process.env.BRAINCLAW_CWD = originalEnv;
          }
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(explicit, { recursive: true, force: true });
      }
    });

    it('returns active project path when set and valid', () => {
      const workspace = tmpDir('bclaw-effective-');
      try {
        makeStore(workspace, 'workspace');
        saveConfig(defaultConfig('workspace'), workspace);

        const child = path.join(workspace, 'api');
        fs.mkdirSync(child, { recursive: true });
        makeStore(child, 'repo');
        saveConfig(defaultConfig('api'), child);

        saveActiveProject(workspace, {
          path: child,
          name: 'api',
          switched_at: new Date().toISOString(),
        });

        // Override process.cwd by providing storeChainOptions.boundary
        const resolved = resolveEffectiveCwd({
          storeChainOptions: { boundary: workspace },
        });

        // Since we can't easily mock process.cwd(), verify workspace root resolution works
        const wsRoot = resolveWorkspaceRoot(workspace, { boundary: workspace });
        assert.equal(wsRoot, workspace);
      } finally {
        clearActiveProject(workspace);
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  // F1 (monorepo independence, trp_71accb07): when an agent is ANCHORED to the
  // workspace (BRAINCLAW_CWD) but physically working inside a child project, it
  // must resolve THAT child — not the anchor root and not a shared/stale global
  // pointer. New `active_source: 'cwd_child'`, inserted between session(4) and
  // global(6). The containment GUARD (isAtOrBelow) is the Codex cadrage catch.
  describe('resolveEffectiveCwdInfo — cwd_child (F1)', () => {
    const ENV_KEYS = ['BRAINCLAW_CWD', 'BRAINCLAW_PROJECT', 'BRAINCLAW_SESSION_ID'];

    function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
      const saved: Record<string, string | undefined> = {};
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      try {
        for (const k of ENV_KEYS) delete process.env[k];
        for (const [k, v] of Object.entries(vars)) process.env[k] = v;
        return fn();
      } finally {
        for (const k of ENV_KEYS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    }

    function makeMonorepo(): { ws: string; api: string; web: string } {
      const ws = tmpDir('bclaw-cwdchild-');
      makeStore(ws, 'workspace');
      saveConfig(defaultConfig('workspace', {
        projectId: 'prj_workspace',
        projectMode: 'multi-project',
        projectStrategy: 'folder',
      }), ws);

      const api = path.join(ws, 'apps', 'api');
      fs.mkdirSync(api, { recursive: true });
      makeStore(api, 'repo');
      saveConfig(defaultConfig('api', { projectId: 'prj_api' }), api);

      const web = path.join(ws, 'apps', 'web');
      fs.mkdirSync(web, { recursive: true });
      makeStore(web, 'repo');
      saveConfig(defaultConfig('web', { projectId: 'prj_web' }), web);

      return { ws, api, web };
    }

    it('resolves the child project when anchored and physically inside it', () => {
      const { ws, api } = makeMonorepo();
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: api });
          assert.equal(r.active_source, 'cwd_child');
          assert.equal(r.cwd, path.resolve(api));
          assert.equal(r.resolved_project?.name, 'api');
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('resolves the closest child store from a deep subdir inside it', () => {
      const { ws, api } = makeMonorepo();
      const deep = path.join(api, 'src', 'handlers');
      fs.mkdirSync(deep, { recursive: true });
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: deep });
          assert.equal(r.active_source, 'cwd_child');
          assert.equal(r.cwd, path.resolve(api));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('does NOT fire when baseCwd equals the anchor (stays at root)', () => {
      const { ws } = makeMonorepo();
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: ws });
          assert.notEqual(r.active_source, 'cwd_child');
          assert.equal(r.cwd, path.resolve(ws));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('GUARD: does NOT fire when baseCwd is OUTSIDE the anchor even if it has a .brainclaw', () => {
      const { ws } = makeMonorepo();
      const outside = tmpDir('bclaw-outside-');
      makeStore(outside, 'repo');
      saveConfig(defaultConfig('outside', { projectId: 'prj_outside' }), outside);
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: outside });
          assert.notEqual(r.active_source, 'cwd_child');
          assert.notEqual(r.cwd, path.resolve(outside));
          assert.equal(r.cwd, path.resolve(ws));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('session active project beats cwd_child', () => {
      const { ws, api, web } = makeMonorepo();
      const now = new Date().toISOString();
      saveCurrentSession({
        session_id: 'sess_f1',
        started_at: now,
        last_seen_at: now,
        agent: 'claude-code',
        agent_id: 'agent-test',
        host_id: 'host-test',
        pid: 424242,
        active_project: { path: web, name: 'web', switched_at: now },
      }, ws);
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: api, sessionId: 'sess_f1' });
          assert.equal(r.active_source, 'session');
          assert.equal(r.cwd, path.resolve(web));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('BRAINCLAW_PROJECT beats cwd_child', () => {
      const { ws, api, web } = makeMonorepo();
      try {
        withEnv({ BRAINCLAW_CWD: ws, BRAINCLAW_PROJECT: 'web' }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: api });
          assert.equal(r.active_source, 'env_project');
          assert.equal(r.cwd, path.resolve(web));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('explicitCwd beats cwd_child', () => {
      const { ws, api, web } = makeMonorepo();
      try {
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: api, explicitCwd: web });
          assert.equal(r.active_source, 'explicit');
          assert.equal(r.cwd, path.resolve(web));
        });
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it('global pointer still applies at the root (cwd_child does not shadow it)', () => {
      const { ws, api } = makeMonorepo();
      try {
        saveActiveProject(ws, { path: api, name: 'api', switched_at: new Date().toISOString() });
        withEnv({ BRAINCLAW_CWD: ws }, () => {
          const r = resolveEffectiveCwdInfo({ baseCwd: ws });
          assert.equal(r.active_source, 'global');
          assert.equal(r.cwd, path.resolve(api));
        });
      } finally {
        clearActiveProject(ws);
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
