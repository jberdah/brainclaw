import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { emptyState, saveState } from '../../src/core/state.js';
import { ensureMemoryDir } from '../../src/core/io.js';

export interface FastStoreOptions {
  projectName?: string;
  projectId?: string;
  agentName?: string;
  agentId?: string;
  cwd: string;
}

/**
 * Creates a minimal valid .brainclaw/ store in <100ms.
 * Use this instead of run(['init', '-y']) in tests that don't test init itself.
 */
export function createFastStore(options: FastStoreOptions): void {
  const { cwd, projectName, projectId, agentName, agentId } = options;

  // Set BRAINCLAW_TEST_MODE to skip expensive operations
  process.env.BRAINCLAW_TEST_MODE = '1';

  ensureMemoryDir(cwd);

  const config = defaultConfig(projectName ?? 'test-project', {
    projectId: projectId ?? `prj_test_${Date.now().toString(36)}`,
    currentAgent: agentName,
    currentAgentId: agentId,
  });
  saveConfig(config, cwd);

  const state = emptyState();
  saveState(state, cwd);

  // Create required subdirectories
  const dirs = [
    'coordination/plans', 'coordination/claims', 'coordination/handoffs',
    'coordination/sessions', 'coordination/sequences', 'coordination/inbox',
    'memory/constraints', 'memory/decisions', 'memory/traps', 'memory/instructions',
    'agents', 'discovery',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(cwd, '.brainclaw', dir), { recursive: true });
  }
}
