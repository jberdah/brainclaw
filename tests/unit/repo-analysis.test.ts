import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRepository } from '../../src/core/repo-analysis.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-repo-analysis-'));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('core/repo-analysis', () => {
  it('recommends single-project when no markers are found', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'single-project');
    assert.deepEqual(result.reasons, ['No monorepo or multi-project markers detected']);
  });

  it('recommends multi-project when workspace markers are present', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf-8');
    fs.mkdirSync(path.join(dir, 'packages'));

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('pnpm-workspace.yaml')));
    assert.ok(result.reasons.some((reason) => reason.includes('packages')));
  });

  it('recommends multi-project when package.json declares workspaces', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }, null, 2), 'utf-8');

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('workspace configuration')));
  });

  it('recommends multi-project when brainclaw config has project_mode=multi-project', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainclawDir, 'config.yaml'),
      'schema_version: 2\nversion: 1\nproject_name: test\nproject_mode: multi-project\nprojects:\n  strategy: folder\n  known: []\n',
      'utf-8',
    );

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('brainclaw config')));
  });

  it('recommends multi-project when brainclaw config has known projects', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainclawDir, 'config.yaml'),
      'schema_version: 2\nversion: 1\nproject_name: test\nproject_mode: auto\nprojects:\n  strategy: manual\n  known:\n    - name: api\n      path: ./api\n',
      'utf-8',
    );

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('1 known project')));
  });

  it('recommends multi-project when child brainclaw stores exist', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    // Create a child directory with its own .brainclaw store
    const childDir = path.join(dir, 'api');
    fs.mkdirSync(path.join(childDir, '.brainclaw'), { recursive: true });

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('child brainclaw store')));
  });

  it('recommends multi-project with folder strategy even without classic monorepo markers', () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(brainclawDir, 'config.yaml'),
      'schema_version: 2\nversion: 1\nproject_name: test\nproject_mode: auto\nprojects:\n  strategy: folder\n  known: []\n',
      'utf-8',
    );

    const result = analyzeRepository(dir);
    assert.equal(result.recommendedMode, 'multi-project');
    assert.ok(result.reasons.some((reason) => reason.includes('strategy=folder')));
  });
});
