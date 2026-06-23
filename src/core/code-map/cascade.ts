/**
 * Monorepo Code Map cascade (DGX Finding 2, 2026-06-22).
 *
 * Plain `refresh` is topology-blind: run at a multi-project workspace root it
 * builds ONE monolithic index that descends every child subtree, while the 27
 * sibling projects keep `missing_index`. The cascade (opt-in: `--cascade` /
 * `bclaw_code_refresh(cascade=true)`) instead refreshes EACH nested brainclaw
 * project into its own `<child>/.brainclaw/code/` store, and refreshes the root
 * store SCOPED to the files no child owns.
 *
 * Zero double-indexing — and correct under nesting — by a single rule: when
 * refreshing project P, exclude the subtree of every OTHER discovered project
 * that sits strictly under P. So a file is indexed by exactly one project: the
 * most specific brainclaw project that contains it.
 *
 * Topology source = `scanNestedBrainclawProjects` (a pure filesystem scan for
 * nested `.brainclaw/config.yaml`), so it works regardless of
 * `projects.strategy` (folder/manual) and matches what `bclaw_switch --list`
 * shows. Children without a `.brainclaw/` are NOT created here — the cascade
 * refreshes existing brainclaw projects, it does not initialise new ones.
 */
import path from 'node:path';
import { scanNestedBrainclawProjects } from '../workspace-projects.js';
import { loadConfig } from '../config.js';
import { refresh as runRefresh } from './refresh.js';
import { readManifest } from './store.js';
import type { Manifest } from './types.js';

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `dir` is strictly below `ancestor` (not equal, not above, same drive). */
function isStrictlyUnder(dir: string, ancestor: string): boolean {
  const rel = path.relative(path.resolve(ancestor), path.resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function projectIdFor(cwd: string, fallbackId?: string): string {
  const manifest = readManifest(cwd);
  if (manifest?.project_id) return manifest.project_id;
  if (fallbackId) return fallbackId;
  try {
    const id = loadConfig(cwd).project_id;
    if (id) return id;
  } catch {
    /* no config — fall through to a cwd-derived default */
  }
  return `prj_${path.basename(path.resolve(cwd))}`;
}

export interface CascadeProjectResult {
  /** Path relative to the workspace root ('.' for the root project itself). */
  path: string;
  project_id: string;
  is_root: boolean;
  ran: boolean;
  files_parsed: number;
  files_compacted: number;
  freshness: Manifest['freshness']['status'];
  lock_status?: string;
}

export interface CascadeResult {
  is_cascade: true;
  /** Absolute workspace root the cascade ran at. */
  root: string;
  /** The root project's own (child-scoped) result. */
  root_result: CascadeProjectResult;
  /** One entry per nested brainclaw project refreshed (excludes the root). */
  children: CascadeProjectResult[];
  children_refreshed: number;
}

export interface RefreshCascadeInput {
  rootCwd: string;
  scope: 'changed' | 'all';
  ownerAgent?: string | null;
  ownerAgentId?: string | null;
}

/**
 * Nested brainclaw projects strictly under `rootCwd`, as absolute paths, deduped
 * and sorted. Pure filesystem scan (strategy-agnostic). Shared by the refresh
 * cascade and the `status --cascade` recap so both agree on the project set.
 */
export function listNestedProjects(rootCwd: string): string[] {
  const root = path.resolve(rootCwd);
  return Array.from(
    new Set(
      scanNestedBrainclawProjects(root)
        .map((c) => path.resolve(c.path))
        .filter((abs) => abs !== root && isStrictlyUnder(abs, root)),
    ),
  ).sort();
}

/**
 * Refresh the whole multi-project workspace: every nested brainclaw project +
 * a child-scoped root store. Callers should only invoke this when the root is a
 * multi-project workspace (the backend gates on `project_mode`).
 */
export async function refreshWorkspaceCascade(input: RefreshCascadeInput): Promise<CascadeResult> {
  const rootCwd = path.resolve(input.rootCwd);

  // Enumerate nested brainclaw projects strictly under the root (FS scan, so it
  // is strategy-agnostic). De-dup + sort by path for deterministic output.
  const childAbsPaths = listNestedProjects(rootCwd);

  // Every project to refresh, root first.
  const allProjects = [rootCwd, ...childAbsPaths];

  const refreshOne = async (projectCwd: string, isRoot: boolean): Promise<CascadeProjectResult> => {
    // Exclude the subtree of every OTHER project that sits strictly under this
    // one → each file is owned by exactly the most specific project.
    const nestedUnder = allProjects.filter((p) => p !== projectCwd && isStrictlyUnder(p, projectCwd));
    const extraIgnorePatterns = nestedUnder.map((p) => `${toPosix(path.relative(projectCwd, p))}/**`);
    const projectId = projectIdFor(projectCwd);
    const result = await runRefresh({
      projectId,
      projectRoot: projectCwd,
      scope: input.scope,
      cwd: projectCwd,
      extraIgnorePatterns,
      ownerAgent: input.ownerAgent ?? null,
      ownerAgentId: input.ownerAgentId ?? null,
    });
    return {
      path: isRoot ? '.' : toPosix(path.relative(rootCwd, projectCwd)),
      project_id: projectId,
      is_root: isRoot,
      ran: result.ran,
      files_parsed: result.files_parsed,
      files_compacted: result.files_compacted,
      freshness: result.freshness.status,
      ...(result.lock_status ? { lock_status: result.lock_status } : {}),
    };
  };

  // Children first, then the root (sequential — each holds its own project lock
  // briefly; never blocks bclaw_work, rule 8).
  const children: CascadeProjectResult[] = [];
  for (const childCwd of childAbsPaths) {
    children.push(await refreshOne(childCwd, false));
  }
  const rootResult = await refreshOne(rootCwd, true);

  return {
    is_cascade: true,
    root: rootCwd,
    root_result: rootResult,
    children,
    children_refreshed: children.length,
  };
}
