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

  it('does not treat nested fixture stores as projects when the root config is single-project manual', () => {
    const root = tmpDir();
    try {
      fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(root, '.brainclaw', 'config.yaml'), [
        'project_name: root',
        'project_mode: auto',
        'projects:',
        '  strategy: manual',
        '  known: []',
        '',
      ].join('\n'));
      fs.mkdirSync(path.join(root, 'tmp_switch_direct', '.brainclaw'), { recursive: true });
      fs.mkdirSync(path.join(root, 'tmp_switch_direct', 'applications', 'lodestar', '.brainclaw'), { recursive: true });

      const projects = discoverBrainclawProjects([{ uri: { fsPath: root } }]);

      assert.deepEqual(projects.map((project) => project.relativePath), ['.']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a single-project manual root as single even with quotes and inline comments', () => {
    // Regression guard for the dependency-free config read: the prior
    // line-anchored regex (strategy:\s*manual\s*$) silently failed on a
    // trailing comment, flipping the root into nested-scan mode.
    const root = tmpDir();
    try {
      fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(root, '.brainclaw', 'config.yaml'), [
        'project_name: root',
        'project_mode: "auto"          # quoted scalar',
        'projects:',
        '  strategy: manual   # single-project root',
        '  known: []',
        '',
      ].join('\n'));
      fs.mkdirSync(path.join(root, 'apps', 'child', '.brainclaw'), { recursive: true });

      const projects = discoverBrainclawProjects([{ uri: { fsPath: root } }]);

      assert.deepEqual(projects.map((project) => project.relativePath), ['.']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps nested discovery enabled for explicit multi-project roots', () => {
    const root = tmpDir();
    try {
      fs.mkdirSync(path.join(root, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(root, '.brainclaw', 'config.yaml'), [
        'project_name: root',
        'project_mode: multi',
        'projects:',
        '  strategy: manual',
        '  known: []',
        '',
      ].join('\n'));
      const child = path.join(root, 'applications', 'lodestar');
      fs.mkdirSync(path.join(child, '.brainclaw'), { recursive: true });

      const projects = discoverBrainclawProjects([{ uri: { fsPath: root } }]);

      assert.ok(projects.some((project) => project.relativePath === '.'));
      assert.ok(projects.some((project) => project.path === child));
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
