import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { resolveContextStoreCwd, resolveStoreChain, resolvePrimaryStore } from '../../src/core/store-resolution.js';

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
});
