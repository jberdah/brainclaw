import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './io.js';

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
