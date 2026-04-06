/**
 * Agent profile system — load, list, and save reusable agent profiles.
 *
 * Profiles are YAML files in .brainclaw/agents/profiles/{name}.yaml
 * that define a reusable agent invocation: prompt, invoke template,
 * trust level, trigger mode, and optional scope.
 *
 * Built-in default profiles ship with the package in default-profiles/
 * and are merged with user profiles (user overrides defaults).
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { AgentProfileSchema, type AgentProfile } from './schema.js';
import { memoryDir } from './io.js';

const PROFILES_DIR = path.join('agents', 'profiles');

/** Directory containing built-in default profiles shipped with the package. */
const DEFAULT_PROFILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'default-profiles',
);

/** Resolve the user profiles directory for a given cwd. */
function profilesDir(cwd: string): string {
  return path.join(memoryDir(cwd), PROFILES_DIR);
}

/** Resolve the path to a specific user profile YAML file. */
function profilePath(name: string, cwd: string): string {
  return path.join(profilesDir(cwd), `${name}.yaml`);
}

/** Read and validate all .yaml profiles from a directory. */
function readProfilesFromDir(dir: string): AgentProfile[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .sort()
    .map(f => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const parsed = yaml.parse(raw);
      return AgentProfileSchema.safeParse(parsed);
    })
    .filter(r => r.success)
    .map(r => r.data);
}

/**
 * Load a single agent profile by name.
 * Checks user profiles first, then built-in defaults.
 * Throws if the profile does not exist or fails validation.
 */
export function loadProfile(name: string, cwd: string = process.cwd()): AgentProfile {
  // User profile takes priority
  const userPath = profilePath(name, cwd);
  if (fs.existsSync(userPath)) {
    const raw = fs.readFileSync(userPath, 'utf-8');
    return AgentProfileSchema.parse(yaml.parse(raw));
  }

  // Fall back to built-in default
  const defaultPath = path.join(DEFAULT_PROFILES_DIR, `${name}.yaml`);
  if (fs.existsSync(defaultPath)) {
    const raw = fs.readFileSync(defaultPath, 'utf-8');
    return AgentProfileSchema.parse(yaml.parse(raw));
  }

  throw new Error(`Profile not found: ${name} (checked ${userPath} and built-in defaults)`);
}

/**
 * List all available agent profiles.
 * Merges built-in defaults with user profiles. User profiles override defaults
 * with the same name.
 */
export function listProfiles(cwd: string = process.cwd()): AgentProfile[] {
  const defaults = readProfilesFromDir(DEFAULT_PROFILES_DIR);
  const user = readProfilesFromDir(profilesDir(cwd));

  // Index by name — user profiles override defaults
  const merged = new Map<string, AgentProfile>();
  for (const p of defaults) merged.set(p.name, p);
  for (const p of user) merged.set(p.name, p);

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Save an agent profile to disk.
 * Creates the profiles directory if it doesn't exist.
 */
export function saveProfile(profile: AgentProfile, cwd: string = process.cwd()): string {
  const validated = AgentProfileSchema.parse(profile);
  const dir = profilesDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = profilePath(validated.name, cwd);
  fs.writeFileSync(filepath, yaml.stringify(validated), 'utf-8');
  return filepath;
}
