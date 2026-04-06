/**
 * Agent profile system — load, list, and save reusable agent profiles.
 *
 * Profiles are YAML files in .brainclaw/agents/profiles/{name}.yaml
 * that define a reusable agent invocation: prompt, invoke template,
 * trust level, trigger mode, and optional scope.
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { AgentProfileSchema, type AgentProfile } from './schema.js';
import { memoryDir } from './io.js';

const PROFILES_DIR = path.join('agents', 'profiles');

/** Resolve the profiles directory for a given cwd. */
function profilesDir(cwd: string): string {
  return path.join(memoryDir(cwd), PROFILES_DIR);
}

/** Resolve the path to a specific profile YAML file. */
function profilePath(name: string, cwd: string): string {
  return path.join(profilesDir(cwd), `${name}.yaml`);
}

/**
 * Load a single agent profile by name.
 * Throws if the profile does not exist or fails validation.
 */
export function loadProfile(name: string, cwd: string = process.cwd()): AgentProfile {
  const filepath = profilePath(name, cwd);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Profile not found: ${name} (expected at ${filepath})`);
  }
  const raw = fs.readFileSync(filepath, 'utf-8');
  const parsed = yaml.parse(raw);
  return AgentProfileSchema.parse(parsed);
}

/**
 * List all available agent profiles.
 * Returns validated profile objects for every .yaml file in the profiles directory.
 */
export function listProfiles(cwd: string = process.cwd()): AgentProfile[] {
  const dir = profilesDir(cwd);
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
