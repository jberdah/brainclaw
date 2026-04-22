import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverBrainclawProjects, PROJECT_SCAN_MAX_DEPTH } from './project-discovery';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-vscode-projects-'));
}

describe('project discovery', () => {
  it('finds brainclaw projects recursively through the configured six-level monorepo depth', () => {
    const root = tmpDir();
    try {
      const deepProject = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(path.join(deepProject, '.brainclaw'), { recursive: true });

      const projects = discoverBrainclawProjects([{ uri: { fsPath: root } }]);

      assert.equal(PROJECT_SCAN_MAX_DEPTH, 6);
      assert.ok(projects.some((project) => project.path === deepProject));
      assert.equal(projects.find((project) => project.path === deepProject)?.relativePath, path.join('a', 'b', 'c', 'd', 'e', 'f'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not scan beyond the six-level boundary', () => {
    const root = tmpDir();
    try {
      const tooDeepProject = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
      fs.mkdirSync(path.join(tooDeepProject, '.brainclaw'), { recursive: true });

      const projects = discoverBrainclawProjects([{ uri: { fsPath: root } }]);

      assert.ok(!projects.some((project) => project.path === tooDeepProject));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
