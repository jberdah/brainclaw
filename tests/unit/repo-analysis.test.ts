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
});
