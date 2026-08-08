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

/**
 * A copy of process.env that is safe to spread into a spawned CLI-under-test.
 * Agent shells export BRAINCLAW_CWD / BRAINCLAW_AGENT / BRAINCLAW_CLAIM_ID,
 * which anchor the spawned CLI on the developer's REAL store instead of the
 * test workspace (the e2e false-failure + store-leak class root-caused in
 * lop_e2d566765b8b4ce3). Strips every BRAINCLAW_* key plus the agent-detection
 * keys. Spread this instead of `...process.env` in e2e run() helpers; tests
 * that need specific BRAINCLAW_* values set them explicitly after the spread.
 */
export function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  // Harness-owned flags that MUST propagate to the CLI-under-test (the test
  // runner sets them intentionally; they carry no store-location state).
  const keep = new Set([
    'BRAINCLAW_TEST_MODE',
    'BRAINCLAW_SKIP_SETUP_REQUIREMENT',
    'BRAINCLAW_SKIP_REPO_ANALYSIS',
    'BRAINCLAW_SKIP_AGENT_BOOTSTRAP',
    'BRAINCLAW_NO_SPAWN',
  ]);
  const env: NodeJS.ProcessEnv = {};
  const agentKeys = new Set<string>(AGENT_ENV_KEYS);
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BRAINCLAW_') && !keep.has(key)) continue;
    if (agentKeys.has(key)) continue;
    env[key] = value;
  }
  return env;
}

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
  // Agent shells also export BRAINCLAW_CWD/_PROJECT/_CLAIM_ID; in-process
  // handlers (resolveEffectiveCwd) anchor on them, so a test run from an agent
  // shell silently operates on the developer's REAL store — observed live on
  // 2026-06-10: a direct `node --test` of bclaw-coordinate leaked 60 runs,
  // 53 assignments, 29 claims and 94 inbox files into the real project store.
  saved.BRAINCLAW_CWD = process.env.BRAINCLAW_CWD;
  saved.BRAINCLAW_PROJECT = process.env.BRAINCLAW_PROJECT;
  saved.BRAINCLAW_CLAIM_ID = process.env.BRAINCLAW_CLAIM_ID;
  saved.BRAINCLAW_SESSION_ID = process.env.BRAINCLAW_SESSION_ID;
  // dec#156 (pln#651 wave 1 demolition) removed the cloud egress path entirely,
  // and with it the BRAINCLAW_CLOUD_* opt-in. These variables no longer control
  // any behavior in-process; the isolation still strips them so a leftover value
  // in a dev shell can never be mistaken for a re-enablement by wave-2 code.
  const cloudEnvKeys = ['BRAINCLAW_CLOUD_URL', 'BRAINCLAW_CLOUD_API_KEY', 'BRAINCLAW_PROJECT_ID', 'BRAINCLAW_CLOUD_REQUIRE_SIGNED', 'BRAINCLAW_CLOUD_AGENT_ID'];
  for (const key of cloudEnvKeys) saved[key] = process.env[key];
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  delete process.env.BRAINCLAW_STORE_BOUNDARY;
  delete process.env.BRAINCLAW_CWD;
  delete process.env.BRAINCLAW_PROJECT;
  delete process.env.BRAINCLAW_CLAIM_ID;
  delete process.env.BRAINCLAW_SESSION_ID;
  for (const key of cloudEnvKeys) delete process.env[key];
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
