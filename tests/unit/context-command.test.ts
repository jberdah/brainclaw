import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { runContext } from '../../src/commands/context.js';
import { saveState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureStdout(fn: () => void): string {
  const writes: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    writes.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return writes.join('\n');
}

describe('commands/context', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-context-command-',
      projectId: 'prj_workspace_test',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
  });

  it('writes context and freshness markers against the resolved child store', () => {
    workspace.updateConfig((config) => {
      config.project_mode = 'multi-project';
      config.projects.strategy = 'folder';
    });

    const childDir = path.join(workspace.dir, 'apps', 'lodestar');
    fs.mkdirSync(childDir, { recursive: true });
    ensureMemoryDir(childDir);
    saveConfig(defaultConfig('lodestar', {
      projectId: 'prj_lodestar_cmd',
    }), childDir);
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_lodestar_cmd',
          text: 'Lodestar child context should resolve from workspace root',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_lodestar_cmd',
          related_paths: ['src/app.ts'],
          tags: ['lodestar'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, childDir);

    const stdout = captureStdout(() => {
      runContext({
        cwd: workspace.dir,
        for: 'apps/lodestar/src/app.ts',
        json: true,
      });
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.project_id, 'prj_lodestar_cmd');
    assert.ok(parsed.selected.some((item: { id: string }) => item.id === 'dec_lodestar_cmd'));
    assert.ok(fs.existsSync(path.join(childDir, '.brainclaw', '.last-context')));
    assert.ok(!fs.existsSync(path.join(workspace.dir, '.brainclaw', '.last-context')));
  });
});
