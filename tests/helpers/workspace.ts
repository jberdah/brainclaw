import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgentIdentity, setCurrentAgentIdentity } from '../../src/core/agent-registry.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import type { AgentIdentityDocument, AgentKind, Config } from '../../src/core/schema.js';

export interface TestWorkspaceOptions {
  prefix?: string;
  projectName?: string;
  projectId?: string;
  currentAgent?: string;
  reputationEnabled?: boolean;
  knownProjects?: string[];
}

export interface TestWorkspace {
  dir: string;
  currentAgent: AgentIdentityDocument;
  cleanup: () => void;
  registerAgent: (agentName: string, kind?: AgentKind) => AgentIdentityDocument;
  setHostId: (hostId: string) => () => void;
  updateConfig: (mutate: (config: Config) => void) => Config;
  useCwd: () => () => void;
}

export function createTestWorkspace(options: TestWorkspaceOptions = {}): TestWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'bclaw-workspace-'));
  ensureMemoryDir(dir);

  const config = defaultConfig(options.projectName ?? 'brainclaw-tests', {
    projectId: options.projectId ?? 'prj_test_workspace',
  });
  config.projects.known = options.knownProjects ?? [];
  if (config.reputation && options.reputationEnabled) {
    config.reputation.enabled = true;
  }
  saveConfig(config, dir);

  const currentAgent = registerAgentIdentity({
    agentName: options.currentAgent ?? 'testuser',
    kind: 'agent',
    cwd: dir,
  });
  setCurrentAgentIdentity(currentAgent, dir);

  return {
    dir,
    currentAgent,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
    registerAgent: (agentName: string, kind: AgentKind = 'agent') => registerAgentIdentity({
      agentName,
      kind,
      cwd: dir,
    }),
    setHostId: (hostId: string) => {
      const previous = process.env.BRAINCLAW_HOST_ID;
      process.env.BRAINCLAW_HOST_ID = hostId;
      return () => {
        if (previous === undefined) {
          delete process.env.BRAINCLAW_HOST_ID;
          return;
        }
        process.env.BRAINCLAW_HOST_ID = previous;
      };
    },
    updateConfig: (mutate: (next: Config) => void) => {
      const next = loadConfig(dir);
      mutate(next);
      saveConfig(next, dir);
      return next;
    },
    useCwd: () => {
      const previous = process.cwd();
      process.chdir(dir);
      return () => {
        process.chdir(previous);
      };
    },
  };
}
