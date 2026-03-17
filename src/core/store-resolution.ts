import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';

export type StoreRole = 'service' | 'repo' | 'workspace' | 'unknown';

export interface StoreRef {
  /** Absolute path to the .brainclaw/ directory */
  storePath: string;
  /** Absolute path to the directory containing .brainclaw/ */
  cwd: string;
  /** Distance from the origin cwd: 0 = closest (highest priority) */
  depth: number;
  /** Role declared in config.yaml store_type, or inferred */
  role: StoreRole;
}

export interface ResolveStoreChainOptions {
  /** Override the directory name (default: .brainclaw) */
  dirName?: string;
  /**
   * Absolute path at which to stop walking up.
   * Defaults to os.homedir(). Walk never goes above this directory.
   */
  boundary?: string;
  /**
   * If true, include stores even when their .brainclaw/ directory exists
   * but has no config.yaml (partially initialised stores).
   */
  includePartial?: boolean;
}

/**
 * Walk up the filesystem from `cwd`, collecting every `.brainclaw/` directory
 * found along the way, up to (and including) `boundary`.
 *
 * The returned array is ordered from closest to farthest (index 0 = highest
 * priority). Returns an empty array when no store is found.
 */
export function resolveStoreChain(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef[] {
  const dirName = options.dirName ?? MEMORY_DIR;
  const boundary = options.boundary ?? os.homedir();
  const includePartial = options.includePartial ?? false;

  const results: StoreRef[] = [];
  let current = path.resolve(cwd);
  const boundaryResolved = path.resolve(boundary);
  let depth = 0;

  while (true) {
    const candidate = path.join(current, dirName);
    if (fs.existsSync(candidate)) {
      const configPath = path.join(candidate, 'config.yaml');
      const hasConfig = fs.existsSync(configPath);
      if (hasConfig || includePartial) {
        results.push({
          storePath: candidate,
          cwd: current,
          depth,
          role: inferRole(candidate, configPath, hasConfig),
        });
      }
    }

    // Stop at boundary (inclusive — we already checked it above if applicable)
    if (current === boundaryResolved) break;

    const parent = path.dirname(current);
    // Stop if we've hit the filesystem root (dirname returns same path)
    if (parent === current) break;

    // Stop if we'd go above the boundary
    if (!isAtOrBelow(parent, boundaryResolved)) break;

    current = parent;
    depth++;
  }

  return results;
}

/**
 * Return the single "primary" store for a given cwd — the closest one.
 * Returns undefined when no store exists in the chain.
 */
export function resolvePrimaryStore(
  cwd: string = process.cwd(),
  options: ResolveStoreChainOptions = {},
): StoreRef | undefined {
  return resolveStoreChain(cwd, options)[0];
}

/**
 * Return true if `dir` is at or below `ancestor` in the filesystem hierarchy.
 */
function isAtOrBelow(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  // If relative path starts with '..', dir is above ancestor
  return !rel.startsWith('..');
}

/**
 * Infer the store role from config.yaml store_type field, or fall back to
 * heuristics (presence of .git sibling = repo, no parent store = workspace).
 */
function inferRole(
  storePath: string,
  configPath: string,
  hasConfig: boolean,
): StoreRole {
  if (hasConfig) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const match = raw.match(/store_type:\s*(\S+)/);
      if (match) {
        const val = match[1].trim();
        if (val === 'workspace' || val === 'repo' || val === 'service') {
          return val;
        }
      }
    } catch {
      // non-fatal — fall through to heuristics
    }
  }
  // Heuristic: if a .git directory lives alongside .brainclaw/, treat as repo
  const siblingGit = path.join(path.dirname(storePath), '.git');
  if (fs.existsSync(siblingGit)) return 'repo';
  return 'unknown';
}
