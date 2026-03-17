import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../../src/commands/doctor.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { emptyState, saveState } from '../../src/core/state.js';
import { generateMarkdown } from '../../src/core/markdown.js';
import { memoryPath, writeFileAtomic } from '../../src/core/io.js';

function makeTmpDir(prefix = 'bclaw-doctor-ms-'): string {
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
  const state = emptyState();
  saveState(state, dir);
  writeFileAtomic(memoryPath('project.md', dir), generateMarkdown(state, dir));
}

describe('doctor store_hierarchy check', () => {
  it('single store shows ok with no hierarchy mention', () => {
    const root = makeTmpDir();
    try {
      initStore(root);
      const result = captureDoctor(root);
      const hierarchyCheck = result.checks.find((c: { name: string }) => c.name === 'store_hierarchy');
      assert.ok(hierarchyCheck, 'store_hierarchy check should be present');
      assert.equal(hierarchyCheck.status, 'ok');
      assert.match(hierarchyCheck.message, /Single store/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('two-level hierarchy shows ok with chain description', () => {
    const root = makeTmpDir();
    try {
      initStore(root, 'workspace');
      const svc = path.join(root, 'app');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');

      const prev = process.cwd();
      process.chdir(svc);
      try {
        const result = captureDoctor(svc);
        const hierarchyCheck = result.checks.find((c: { name: string }) => c.name === 'store_hierarchy');
        assert.ok(hierarchyCheck, 'store_hierarchy check should be present');
        assert.equal(hierarchyCheck.status, 'ok');
        assert.match(hierarchyCheck.message, /Store chain \(2 stores\)/);
        assert.match(hierarchyCheck.message, /service/);
        assert.match(hierarchyCheck.message, /workspace/);
      } finally {
        process.chdir(prev);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('duplicate roles warn', () => {
    const root = makeTmpDir();
    try {
      initStore(root, 'workspace');
      const mid = path.join(root, 'repo');
      fs.mkdirSync(mid, { recursive: true });
      initStore(mid, 'workspace'); // duplicate role!
      const svc = path.join(mid, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      initStore(svc, 'service');

      const result = captureDoctor(svc);
      const hierarchyCheck = result.checks.find((c: { name: string }) => c.name === 'store_hierarchy');
      assert.ok(hierarchyCheck, 'store_hierarchy check should be present');
      assert.equal(hierarchyCheck.status, 'warn');
      assert.match(hierarchyCheck.message, /duplicate roles/);
      assert.match(hierarchyCheck.message, /workspace/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function captureDoctor(cwd: string): { ok: boolean; checks: Array<{ name: string; status: string; message: string }> } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    runDoctor({ json: true, cwd });
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join(''));
}
