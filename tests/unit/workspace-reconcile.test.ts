import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../../src/commands/doctor.js';
import { runStatus } from '../../src/commands/status.js';
import { runReconcile } from '../../src/commands/reconcile.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir, memoryPath, writeFileAtomic } from '../../src/core/io.js';
import { generateMarkdown } from '../../src/core/markdown.js';
import { emptyState, saveState } from '../../src/core/state.js';

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join('');
}

async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join('');
}

function initStore(dir: string, options: { projectName: string; projectId: string; projectMode?: 'single-project' | 'multi-project' | 'auto'; projectStrategy?: 'manual' | 'folder'; knownProjects?: string[] }): void {
  ensureMemoryDir(dir);
  const config = defaultConfig(options.projectName, { projectId: options.projectId });
  if (options.projectMode) {
    config.project_mode = options.projectMode;
  }
  if (options.projectStrategy) {
    config.projects.strategy = options.projectStrategy;
  }
  if (options.knownProjects) {
    config.projects.known = options.knownProjects;
  }
  saveConfig(config, dir);

  const state = emptyState();
  saveState(state, dir);
  writeFileAtomic(memoryPath('project.md', dir), generateMarkdown(state, dir));
}

describe('workspace reconciliation flow', () => {
  let rootDir: string;
  let workspaceDir: string;
  let childDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-reconcile-'));
    workspaceDir = path.join(rootDir, 'workspace');
    childDir = path.join(workspaceDir, 'repos', 'global');
    fs.mkdirSync(childDir, { recursive: true });

    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = rootDir;
    process.env.USERPROFILE = rootDir;

    initStore(workspaceDir, {
      projectName: 'workspace-root',
      projectId: 'prj_workspace_root',
      projectMode: 'multi-project',
      projectStrategy: 'folder',
      knownProjects: [],
    });
    initStore(childDir, {
      projectName: 'global-repo',
      projectId: 'prj_global_repo',
      projectMode: 'single-project',
      projectStrategy: 'manual',
      knownProjects: [],
    });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('doctor does not warn for folder-mode workspace when child stores resolve from filesystem', () => {
    const parsed = JSON.parse(captureStdout(() => {
      runDoctor({ json: true, cwd: workspaceDir });
    }));

    const projectMode = parsed.checks.find((check: { name: string }) => check.name === 'project_mode');
    assert.ok(projectMode);
    assert.equal(projectMode.status, 'ok');
    assert.equal(projectMode.details.strategy, 'folder');
    assert.equal(projectMode.details.effective_project_count, 1);
    assert.equal(projectMode.details.discovered_projects[0].relative_path, path.join('repos', 'global'));
  });

  it('status json exposes effective workspace projects for folder-mode workspaces', () => {
    const parsed = JSON.parse(captureStdout(() => {
      const previousCwd = process.cwd();
      process.chdir(workspaceDir);
      try {
        runStatus({ json: true });
      } finally {
        process.chdir(previousCwd);
      }
    }));

    assert.equal(parsed.config.project_mode, 'multi-project');
    assert.equal(parsed.workspace_projects.strategy, 'folder');
    assert.equal(parsed.workspace_projects.effective_project_count, 1);
    assert.equal(parsed.workspace_projects.discovered_projects[0].project_name, 'global-repo');
  });

  it('reconcile dry-run plans refresh across workspace and nested child stores', async () => {
    const parsed = JSON.parse(await captureStdoutAsync(async () => {
      await runReconcile({
        cwd: workspaceDir,
        json: true,
        dryRun: true,
      });
    }));

    assert.equal(parsed.mode, 'dry_run');
    assert.equal(parsed.workspace_summary.strategy, 'folder');
    assert.equal(parsed.workspace_summary.effective_project_count, 1);
    assert.equal(parsed.planned_actions.machine_profile_refresh, true);
    assert.equal(parsed.planned_actions.agent_inventory_refresh, true);
    assert.equal(parsed.planned_actions.bootstrap_refresh.length, 2);
    assert.deepEqual(
      parsed.planned_actions.bootstrap_refresh.map((entry: { relative_path: string }) => entry.relative_path).sort(),
      ['.', path.join('repos', 'global')],
    );
  });
});
