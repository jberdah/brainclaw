/**
 * pln#649 step 2 (dec#153) — locate the store that OWNS an entity, by id.
 *
 * THE PROBLEM THIS SOLVES. dec#153 made the entity the routing authority: for any
 * work unit, `owner_project` is fixed at creation and every read/mutation must
 * reach THAT store, regardless of pid, cwd, session or the shared global pointer.
 * Step 1 persisted the owner *inside* the record — but to read that field you must
 * first find the file, which is the very thing ambient resolution gets wrong. This
 * module breaks that circle: it finds the record by probing a BOUNDED candidate
 * set, so a worker holding only an `assignment_id` can be routed correctly without
 * anything ambient being trusted.
 *
 * WHY A PROBE AND NOT AN INDEX. The plan allowed an index; the code does not need
 * one, and an index would be strictly worse here:
 *   - the candidate set is already enumerable and small (the store itself, the
 *     workspace's nested children, declared cross-project links) — one `existsSync`
 *     each, and the current store is probed FIRST so the overwhelmingly common
 *     single-project case costs exactly one stat;
 *   - an index is a second source of truth that can go stale, be half-written, or
 *     disagree with the filesystem — and the whole point of dec#153 is to stop
 *     trusting a derived answer over the record itself;
 *   - `resolveEntityDir` is store-LOCAL (io.ts:79-107 — it joins memoryDir(cwd)
 *     and falls back only to a legacy path inside the SAME store), so each probe
 *     is properly isolated and cannot leak a parent store's hit.
 * If enumeration ever becomes expensive (hundreds of projects), a cache belongs in
 * FRONT of this function, not instead of it.
 *
 * AMBIGUITY IS A RESULT, NOT AN ERROR. Two stores holding the same id is exactly
 * the divergence T3 must refuse on (step 4), so it is reported as `ambiguous` with
 * every match rather than silently resolved by first-wins. Callers decide; this
 * module never picks a winner it cannot justify.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { resolveCrossProjectLinks } from './cross-project.js';
import { MEMORY_DIR, resolveEntityDir } from './io.js';
import { resolvePrimaryStore, resolveWorkspaceRoot } from './store-resolution.js';
import { scanNestedBrainclawProjects, summarizeWorkspaceProjects } from './workspace-projects.js';

/** Entity kinds whose records live in a per-store directory keyed by id. */
export type LocatableEntity = 'assignment' | 'claim' | 'agent_run' | 'plan' | 'loop';

/** Where an entity's record actually is. */
export interface EntityLocation {
  /** Absolute path of the project directory (the store's cwd, not the .brainclaw dir). */
  cwd: string;
  project_id?: string;
  project_name?: string;
}

export interface LocateEntityResult {
  /**
   * found       — exactly one store holds the id.
   * not_found   — no candidate holds it (the caller decides whether that is an
   *               error; a legacy id in an unlinked store looks the same).
   * ambiguous   — two or more stores hold it. Fuel for the T3 hard refusal; never
   *               resolved by first-wins here.
   */
  status: 'found' | 'not_found' | 'ambiguous';
  /** Set only when status === 'found'. */
  location?: EntityLocation;
  /** Every store that holds the id (length 0, 1, or ≥2, matching `status`). */
  matches: EntityLocation[];
  /** Stores probed, in probe order — the cost of this call, observable for tests. */
  probed: string[];
}

/** Relative record path for an entity kind, within one store. */
function recordPath(entity: LocatableEntity, id: string, storeCwd: string): string {
  if (entity === 'loop') {
    // Loops are not in the ENTITY_DIR_MAP — their threads live under loops/threads.
    return path.join(storeCwd, MEMORY_DIR, 'loops', 'threads', `${id}.json`);
  }
  const subdir = entity === 'assignment' ? 'assignments'
    : entity === 'claim' ? 'claims'
      : entity === 'agent_run' ? 'runs'
        : 'plans';
  return path.join(resolveEntityDir(subdir, storeCwd, 'read'), `${id}.json`);
}

/**
 * One probe. A candidate whose store is mid-write, permission-denied or otherwise
 * unreadable counts as a miss rather than an exception: routing must not depend on
 * the health of a project the caller has nothing to do with.
 */
function recordExists(entity: LocatableEntity, id: string, storeCwd: string): boolean {
  try {
    return fs.existsSync(recordPath(entity, id, storeCwd));
  } catch {
    return false;
  }
}

function describe(storeCwd: string): EntityLocation {
  try {
    const config = loadConfig(storeCwd);
    return { cwd: storeCwd, project_id: config.project_id, project_name: config.project_name };
  } catch {
    // A store we can enumerate but not read config for is still a valid location.
    return { cwd: storeCwd };
  }
}

/**
 * Candidate stores, in probe order: the caller's own store first (so the common
 * single-project case stops after one stat), then the workspace's children, then
 * declared cross-project links. Deduplicated by resolved absolute path.
 *
 * Enumeration mirrors the loop project-resolution gate (loops/project-resolution.ts)
 * on purpose — two different candidate sets for "which projects exist here" is how
 * routing surfaces drift apart.
 */
export function enumerateCandidateStores(cwd: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    const abs = path.resolve(candidate);
    if (seen.has(abs)) return;
    // Only real stores are candidates — an unreadable path costs nothing later.
    if (!fs.existsSync(path.join(abs, MEMORY_DIR, 'config.yaml'))) return;
    seen.add(abs);
    ordered.push(abs);
  };

  const here = path.resolve(cwd);
  add(here);

  let config;
  try {
    config = loadConfig(here);
  } catch {
    // Uninitialised store: `here` was already rejected by `add`, and there is
    // nothing to enumerate from. Returning what we have keeps callers simple.
    return ordered;
  }

  if (config.project_mode === 'multi-project') {
    for (const project of summarizeWorkspaceProjects(here, config).discovered_projects) {
      // `config`-sourced entries are declared namespaces without a path of their own.
      if (project.source !== 'config') add(project.path);
    }
  }

  // A workspace root can host nested project stores; so can the workspace root
  // ABOVE us, which is how a child project reaches its siblings.
  const wsRoot = resolveWorkspaceRoot(here);
  if (wsRoot) {
    add(wsRoot);
    for (const project of scanNestedBrainclawProjects(wsRoot)) add(project.path);
  } else if (resolvePrimaryStore(here)?.role === 'workspace') {
    for (const project of scanNestedBrainclawProjects(here)) add(project.path);
  }

  for (const link of resolveCrossProjectLinks(here)) add(link.absolutePath);

  return ordered;
}

/**
 * Find the store holding `id`. Never throws for a missing store or unreadable
 * config — a locator that fails loudly on an unrelated broken sibling would make
 * routing depend on the health of projects the caller has nothing to do with.
 */
export function locateEntity(
  entity: LocatableEntity,
  id: string,
  cwd: string,
  options: { candidates?: string[] } = {},
): LocateEntityResult {
  const candidates = options.candidates ?? enumerateCandidateStores(cwd);
  const matches: EntityLocation[] = [];
  const probed: string[] = [];

  for (const candidate of candidates) {
    probed.push(candidate);
    if (recordExists(entity, id, candidate)) matches.push(describe(candidate));
  }

  if (matches.length === 1) return { status: 'found', location: matches[0], matches, probed };
  if (matches.length > 1) return { status: 'ambiguous', matches, probed };
  return { status: 'not_found', matches, probed };
}
