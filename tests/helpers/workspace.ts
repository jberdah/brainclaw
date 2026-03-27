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
  /** If true, save and clear all agent detection env vars and use a fake homeDir. Default: true. */
  isolateEnv?: boolean;
}

export interface TestWorkspace {
  dir: string;
  fakeHome: string;
  currentAgent: AgentIdentityDocument;
  cleanup: () => void;
  registerAgent: (agentName: string, kind?: AgentKind) => AgentIdentityDocument;
  setHostId: (hostId: string) => () => void;
  updateConfig: (mutate: (config: Config) => void) => Config;
  useCwd: () => () => void;
}

/**
 * All environment variable keys that influence agent detection.
 * Tests that check agent resolution must clear these to avoid
 * host-machine leakage (e.g. CLAUDE_CODE_VERSION, ~/.gemini/).
 */
export const AGENT_ENV_KEYS = [
  'BRAINCLAW_AGENT', 'BRAINCLAW_AGENT_NAME', 'BRAINCLAW_AGENT_ID',
  'CLAUDE_CODE_VERSION', 'CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_AI_PRODUCT',
  'CURSOR_TRACE_ID', 'WINDSURF_SESSION_ID', 'CODEX_HOME',
  'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_AGENT', 'CODEX_SESSION_ID',
  'GITHUB_COPILOT_TOKEN', 'GITHUB_COPILOT_CHAT',
  'OPENCODE_SESSION_ID', 'OPENCODE_AGENT',
  'ANTIGRAVITY_SESSION_ID', 'ANTIGRAVITY_AGENT',
  'OPENCLAW_SESSION_ID', 'OPENCLAW_AGENT',
] as const;

/**
 * Save and clear all agent detection env vars.
 * Returns a restore function to call in afterEach.
 * Also creates an isolated fake homeDir to prevent filesystem-based detection.
 */
export function isolateAgentEnv(): { fakeHome: string; restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const key of AGENT_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  saved.HOME = process.env.HOME;
  saved.USERPROFILE = process.env.USERPROFILE;
  saved.HOMEDRIVE = process.env.HOMEDRIVE;
  saved.HOMEPATH = process.env.HOMEPATH;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  return {
    fakeHome,
    restore: () => {
      for (const key of AGENT_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
      if (saved.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = saved.HOMEDRIVE;
      if (saved.HOMEPATH === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = saved.HOMEPATH;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

export function createTestWorkspace(options: TestWorkspaceOptions = {}): TestWorkspace {
  // By default, isolate agent env vars to prevent host-machine leakage
  const envIsolation = options.isolateEnv !== false ? isolateAgentEnv() : undefined;
  const fakeHome = envIsolation?.fakeHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));

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
  process.env.BRAINCLAW_AGENT_NAME = currentAgent.agent_name;
  process.env.BRAINCLAW_AGENT = currentAgent.agent_name;
  process.env.BRAINCLAW_AGENT_ID = currentAgent.agent_id;

  return {
    dir,
    fakeHome,
    currentAgent,
    cleanup: () => {
      envIsolation?.restore();
      fs.rmSync(dir, { recursive: true, force: true });
      if (!envIsolation) fs.rmSync(fakeHome, { recursive: true, force: true });
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
