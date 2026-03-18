import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { MEMORY_DIR } from './io.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RegisteredProject {
  project_id: string;
  project_name: string;
  path: string;
  git_remote?: string;
  git_users: Array<{ name: string; email: string }>;
  last_activity?: string;
  agents_seen: string[];
}

export interface GlobalProjectRegistry {
  schema_version: number;
  updated_at: string;
  projects: RegisteredProject[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function runGit(args: string[], cwd: string): string | undefined {
  try {
    const r = spawnSync('git', args, { encoding: 'utf-8', timeout: 5000, cwd, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readJsonSafe(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function readYamlSafe(filePath: string): Record<string, unknown> | undefined {
  try {
    return yaml.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ── Scan a project directory ───────────────────────────────────────────────────

/**
 * Extract registry metadata from a single brainclaw-initialized project.
 */
export function scanProject(projectPath: string): RegisteredProject | undefined {
  const brainclawDir = path.join(projectPath, MEMORY_DIR);
  if (!fs.existsSync(brainclawDir)) return undefined;

  const identity = readJsonSafe(path.join(brainclawDir, 'project.identity.json'));
  const config = readYamlSafe(path.join(brainclawDir, 'config.yaml'));
  if (!identity && !config) return undefined;

  const projectId = (identity?.project_id ?? config?.project_id ?? 'unknown') as string;
  const projectName = (identity?.project_name ?? config?.project_name ?? path.basename(projectPath)) as string;

  // Git remote
  const gitRemote = runGit(['remote', 'get-url', 'origin'], projectPath);

  // Git user for this repo
  const gitUsers: Array<{ name: string; email: string }> = [];
  const userName = runGit(['config', 'user.name'], projectPath);
  const userEmail = runGit(['config', 'user.email'], projectPath);
  if (userName && userEmail) {
    gitUsers.push({ name: userName, email: userEmail });
  }

  // Agents seen
  const agentsSeen: string[] = [];
  const agentsDir = path.join(brainclawDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    try {
      for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'))) {
        const agent = readJsonSafe(path.join(agentsDir, f));
        const name = agent?.agent_name as string | undefined;
        if (name && !agentsSeen.includes(name)) agentsSeen.push(name);
      }
    } catch { /* non-fatal */ }
  }

  // Last activity from audit.log mtime
  let lastActivity: string | undefined;
  try {
    const auditLog = path.join(brainclawDir, 'audit.log');
    if (fs.existsSync(auditLog)) {
      lastActivity = fs.statSync(auditLog).mtime.toISOString();
    }
  } catch { /* non-fatal */ }

  return { project_id: projectId, project_name: projectName, path: projectPath, git_remote: gitRemote, git_users: gitUsers, last_activity: lastActivity, agents_seen: agentsSeen };
}

// ── Registry CRUD ──────────────────────────────────────────────────────────────

export function globalRegistryPath(): string {
  return path.join(os.homedir(), MEMORY_DIR, 'projects.yaml');
}

export function loadGlobalRegistry(): GlobalProjectRegistry | undefined {
  const filePath = globalRegistryPath();
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return yaml.parse(fs.readFileSync(filePath, 'utf-8')) as GlobalProjectRegistry;
  } catch {
    return undefined;
  }
}

export function saveGlobalRegistry(registry: GlobalProjectRegistry): string {
  const filePath = globalRegistryPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, yaml.stringify(registry, { lineWidth: 120 }), 'utf-8');
  return filePath;
}

/**
 * Register or update a single project in the global registry (upsert by project_id).
 */
export function upsertProject(entry: RegisteredProject): GlobalProjectRegistry {
  const registry = loadGlobalRegistry() ?? { schema_version: 1, updated_at: new Date().toISOString(), projects: [] };
  const idx = registry.projects.findIndex(p => p.project_id === entry.project_id);
  if (idx >= 0) {
    registry.projects[idx] = entry;
  } else {
    registry.projects.push(entry);
  }
  registry.updated_at = new Date().toISOString();
  saveGlobalRegistry(registry);
  return registry;
}

/**
 * Scan directories for brainclaw projects and update the global registry.
 */
export function scanAndRegister(roots: string[]): GlobalProjectRegistry {
  const registry = loadGlobalRegistry() ?? { schema_version: 1, updated_at: new Date().toISOString(), projects: [] };

  for (const root of roots) {
    const resolved = path.resolve(root);

    // Check root itself
    const rootEntry = scanProject(resolved);
    if (rootEntry) {
      const idx = registry.projects.findIndex(p => p.project_id === rootEntry.project_id);
      if (idx >= 0) registry.projects[idx] = rootEntry;
      else registry.projects.push(rootEntry);
    }

    // Scan immediate subdirectories
    if (!fs.existsSync(resolved)) continue;
    try {
      for (const e of fs.readdirSync(resolved, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const entry = scanProject(path.join(resolved, e.name));
        if (entry) {
          const idx = registry.projects.findIndex(p => p.project_id === entry.project_id);
          if (idx >= 0) registry.projects[idx] = entry;
          else registry.projects.push(entry);
        }
      }
    } catch { /* non-fatal */ }
  }

  registry.updated_at = new Date().toISOString();
  saveGlobalRegistry(registry);
  return registry;
}

/**
 * Render human-readable summary of the global project registry.
 */
export function renderGlobalRegistrySummary(registry: GlobalProjectRegistry): string {
  const lines: string[] = [];
  lines.push(`Projects registered: ${registry.projects.length}`);
  lines.push('');

  for (const p of registry.projects) {
    lines.push(`● ${p.project_name} (${p.project_id})`);
    lines.push(`  Path: ${p.path}`);
    if (p.git_remote) lines.push(`  Remote: ${p.git_remote}`);
    if (p.git_users.length > 0) lines.push(`  Git user: ${p.git_users.map(u => `${u.name} <${u.email}>`).join(', ')}`);
    if (p.agents_seen.length > 0) lines.push(`  Agents: ${p.agents_seen.join(', ')}`);
    if (p.last_activity) lines.push(`  Last activity: ${p.last_activity}`);
    lines.push('');
  }

  lines.push(`Registry updated: ${registry.updated_at}`);
  return lines.join('\n');
}
