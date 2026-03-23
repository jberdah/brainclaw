import fs from 'node:fs';
import path from 'node:path';
import { ensureMemoryDir, writeFileAtomic } from './io.js';
import { defaultConfig, saveConfig } from './config.js';

export interface SetupState {
  completed_at: string;
  roots: string[];
  initialised_repos: string[];
  global_configs_written: string[];
}

export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

export function setupStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = resolveHomeDir(env);
  if (!home) return undefined;
  return path.join(home, '.brainclaw', 'setup.json');
}

export function userStoreConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = resolveHomeDir(env);
  if (!home) return undefined;
  return path.join(home, '.brainclaw', 'config.yaml');
}

export function readSetupState(env: NodeJS.ProcessEnv = process.env): SetupState | undefined {
  const statePath = setupStatePath(env);
  if (!statePath) return undefined;
  try {
    if (!fs.existsSync(statePath)) return undefined;
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as SetupState;
  } catch {
    return undefined;
  }
}

export function writeSetupState(state: SetupState, env: NodeJS.ProcessEnv = process.env): void {
  const statePath = setupStatePath(env);
  if (!statePath) return;
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + '\n');
}

export function hasCompletedSetup(env: NodeJS.ProcessEnv = process.env): boolean {
  if (readSetupState(env)) {
    return true;
  }

  const configPath = userStoreConfigPath(env);
  return configPath ? fs.existsSync(configPath) : false;
}

/**
 * Ensure the user-global store (~/.brainclaw/) exists, creating it implicitly
 * if absent. This replaces the old "setup required before init" guard —
 * init can now auto-create the minimal user store on first run.
 *
 * Idempotent: returns immediately if the user store already exists.
 * Non-fatal: logs a warning if creation fails but does not throw.
 */
export function ensureUserStore(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = resolveHomeDir(env);
  if (!home) return false;

  const configPath = path.join(home, '.brainclaw', 'config.yaml');
  if (fs.existsSync(configPath)) {
    return true; // already exists
  }

  try {
    ensureMemoryDir(home);
    const cfg = defaultConfig('user-global');
    saveConfig(cfg, home);
    fs.appendFileSync(configPath, 'store_type: user\n');
    return true;
  } catch (err) {
    console.warn(
      `Warning: could not create user store at ${path.join(home, '.brainclaw')}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
