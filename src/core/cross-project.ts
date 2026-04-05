import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadState } from './state.js';
import { generateId, nowISO } from './ids.js';
import { memoryExists, resolveEntityDir } from './io.js';
import type { CrossProjectLink } from './schema.js';
import type { Candidate, Handoff, State, RuntimeNote } from './schema.js';

export type CrossProjectSignalEntity = 'candidate' | 'handoff' | 'runtime_note';

export interface CrossProjectSignalEnvelope {
  schema_version: 1;
  id: string;
  entity_type: CrossProjectSignalEntity;
  created_at: string;
  from_project: {
    id?: string;
    name: string;
    path: string;
  };
  from_agent: {
    name: string;
    id?: string;
    host_id?: string;
    session_id?: string;
  };
  target_project: {
    name: string;
    path: string;
  };
  payload: Candidate | Handoff | RuntimeNote;
}

export interface ResolvedCrossProjectLink extends CrossProjectLink {
  absolutePath: string;
  projectName: string;
  available: boolean;
}

function crossProjectSignalDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return path.join(resolveEntityDir('inbox', cwd ?? process.cwd(), mode), 'cross-project');
}

function ensureCrossProjectSignalDir(cwd?: string): string {
  const dir = crossProjectSignalDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveCrossProjectWritableTarget(
  nameOrPath: string,
  entityType: CrossProjectSignalEntity,
  cwd?: string,
): ResolvedCrossProjectLink {
  const link = resolveCrossProjectTarget(nameOrPath, cwd);
  if (link.role !== 'publisher') {
    throw new Error(`Cross-project link to '${link.projectName}' is role=subscriber — cannot push ${entityType} signals. Set role: publisher to enable push.`);
  }
  if (!link.available) {
    throw new Error(`Target project not found or not initialized: ${link.absolutePath}`);
  }
  if (link.channels?.length && !link.channels.includes(entityType)) {
    throw new Error(`Cross-project link to '${link.projectName}' does not allow ${entityType} signals. Allowed channels: ${link.channels.join(', ')}.`);
  }
  return link;
}

/**
 * Resolves cross_project_links from config, converting relative paths to absolute.
 */
export function resolveCrossProjectLinks(cwd?: string): ResolvedCrossProjectLink[] {
  const baseCwd = cwd ?? process.cwd();
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    return [];
  }

  return (config.cross_project_links ?? []).map((link) => {
    const absolutePath = path.isAbsolute(link.path)
      ? link.path
      : path.resolve(baseCwd, link.path);
    const available = memoryExists(absolutePath);
    let projectName = link.name ?? path.basename(absolutePath);
    if (available) {
      try {
        const linkedConfig = loadConfig(absolutePath);
        projectName = link.name ?? linkedConfig.project_name ?? projectName;
      } catch { /* use basename fallback */ }
    }
    return { ...link, absolutePath, projectName, available };
  });
}

/**
 * Detects cycles in cross_project_links (A → B → A).
 * Returns the paths involved in any cycle found.
 */
export function detectCrossProjectCycles(cwd?: string): string[][] {
  const baseCwd = path.resolve(cwd ?? process.cwd());
  const cycles: string[][] = [];

  function walk(currentCwd: string, visited: string[]): void {
    let links: ResolvedCrossProjectLink[] = [];
    try {
      links = resolveCrossProjectLinks(currentCwd);
    } catch { return; }

    for (const link of links) {
      const normalized = path.resolve(link.absolutePath);
      if (visited.includes(normalized)) {
        cycles.push([...visited, normalized]);
        return;
      }
      walk(normalized, [...visited, normalized]);
    }
  }

  walk(baseCwd, [baseCwd]);
  return cycles;
}

/**
 * Loads state from a linked project (read-only).
 */
export function loadCrossProjectState(absolutePath: string): State {
  return loadState(absolutePath);
}

/**
 * Writes a structured signal into a target (publisher-linked) project's inbox.
 */
export function writeCrossProjectSignal(
  target: string | ResolvedCrossProjectLink,
  entityType: CrossProjectSignalEntity,
  payload: Candidate | Handoff | RuntimeNote,
  sourceCwd?: string,
): CrossProjectSignalEnvelope {
  const link = typeof target === 'string'
    ? resolveCrossProjectWritableTarget(target, entityType, sourceCwd)
    : target;
  const sourceRoot = path.resolve(sourceCwd ?? process.cwd());
  const sourceConfig = loadConfig(sourceRoot);
  const agentName = 'author' in payload ? payload.author : ('agent' in payload ? payload.agent : 'unknown');
  const agentId = 'author_id' in payload ? payload.author_id : ('agent_id' in payload ? payload.agent_id : undefined);
  const signal: CrossProjectSignalEnvelope = {
    schema_version: 1,
    id: generateId('sig'),
    entity_type: entityType,
    created_at: nowISO(),
    from_project: {
      id: sourceConfig.project_id,
      name: sourceConfig.project_name ?? path.basename(sourceRoot),
      path: sourceRoot,
    },
    from_agent: {
      name: agentName,
      id: agentId,
      host_id: payload.host_id,
      session_id: payload.session_id,
    },
    target_project: {
      name: link.projectName,
      path: link.absolutePath,
    },
    payload,
  };

  const dir = ensureCrossProjectSignalDir(link.absolutePath);
  const filepath = path.join(dir, `${signal.id}.json`);
  fs.writeFileSync(filepath, JSON.stringify(signal, null, 2) + '\n', 'utf-8');
  return signal;
}

/**
 * Lists cross-project signals materialized in the local inbox.
 */
export function listIncomingCrossProjectSignals(cwd?: string): CrossProjectSignalEnvelope[] {
  const dir = crossProjectSignalDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const signals: CrossProjectSignalEnvelope[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const filepath = path.join(dir, entry);
    try {
      signals.push(JSON.parse(fs.readFileSync(filepath, 'utf-8')) as CrossProjectSignalEnvelope);
    } catch {
      // Ignore malformed signal files.
    }
  }

  return signals.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Returns the absolute path of a cross-project link by name or path fragment.
 */
export function resolveCrossProjectTarget(nameOrPath: string, cwd?: string): ResolvedCrossProjectLink {
  const links = resolveCrossProjectLinks(cwd);
  const match = links.find(
    (l) => l.projectName === nameOrPath ||
           l.path === nameOrPath ||
           l.absolutePath === nameOrPath ||
           path.basename(l.absolutePath) === nameOrPath,
  );
  if (!match) {
    throw new Error(`No cross_project_link found matching: '${nameOrPath}'. Check your config.yaml cross_project_links.`);
  }
  return match;
}
