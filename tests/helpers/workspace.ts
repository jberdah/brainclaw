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

export interface CleanupTestEnvOptions {
  dir?: string;
  fakeHome?: string;
  envBackup?: Record<string, string | undefined>;
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

export function cleanupTestEnv(options: CleanupTestEnvOptions): void {
  if (options.envBackup) {
    for (const [key, value] of Object.entries(options.envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (options.dir) {
    fs.rmSync(options.dir, { recursive: true, force: true });
  }

  if (options.fakeHome) {
    fs.rmSync(options.fakeHome, { recursive: true, force: true });
  }
}

/**
 * Save and clear all agent detection env vars.
 * Returns a restore function to call in afterEach.
 * Also creates an isolated fake homeDir to prevent filesystem-based detection,
 * and clears BRAINCLAW_STORE_BOUNDARY so a leaked parent boundary does not
 * widen the store chain into the host machine (trp#7 + trp#17, pln#450).
 * Tests that need a specific boundary can set process.env.BRAINCLAW_STORE_BOUNDARY
 * themselves after calling this.
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
  saved.BRAINCLAW_STORE_BOUNDARY = process.env.BRAINCLAW_STORE_BOUNDARY;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  delete process.env.BRAINCLAW_STORE_BOUNDARY;
  return {
    fakeHome,
    restore: () => cleanupTestEnv({ fakeHome, envBackup: saved }),
  };
}

export function createTestWorkspace(options: TestWorkspaceOptions = {}): TestWorkspace {
  // By default, isolate agent env vars to prevent host-machine leakage
  const envIsolation = options.isolateEnv !== false ? isolateAgentEnv() : undefined;
  const fakeHome = envIsolation?.fakeHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'bclaw-workspace-'));
  ensureMemoryDir(dir);

  // Tight store boundary pinned to this workspace — store chain resolution
  // does not walk outside `dir`, so a user-level ~/.brainclaw/ or a CI tmpdir
  // that sits outside $HOME cannot leak into the test's view of memory.
  // Restored by the cleanup path via the envBackup captured in isolateAgentEnv.
  process.env.BRAINCLAW_STORE_BOUNDARY = dir;

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
      if (envIsolation) {
        envIsolation.restore();
        cleanupTestEnv({ dir });
        return;
      }
      cleanupTestEnv({ dir, fakeHome });
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
