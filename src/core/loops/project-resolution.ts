/**
 * pln#521 P1 — loop project resolution gate.
 *
 * A review loop that lands in the wrong store is worse than a review loop that
 * never opened: the candidate, claim, assignment and loop all persist in a
 * project nobody is watching, and the reviewer spawns against the wrong repo
 * (DGX misroute, 2026-05). This module answers ONE question before any
 * persistence happens: *which project does this loop belong to, and did anyone
 * actually choose it?*
 *
 * Resolution ladder (B2 of art_18e7c6101880):
 *   1. explicit `project` argument            → routed, source='explicit'
 *   2. a real selector already won upstream   → routed, source=<that selector>
 *      (env_project / session / cwd_child / global — `resolveEffectiveCwdInfo`
 *      has already applied them by the time a handler receives its cwd)
 *   3. bare cwd fallback in a store that can host several projects
 *                                             → `needs_project_selection`
 *
 * There is deliberately NO inference from ref / scope / path: B3 was rejected
 * (art_e29e88878209) because a wrong guess costs more than an explicit choice.
 *
 * @module
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { resolveProjectCwd } from '../cross-project.js';
import { resolvePrimaryStore, type EffectiveCwdSource } from '../store-resolution.js';
import { scanNestedBrainclawProjects, summarizeWorkspaceProjects } from '../workspace-projects.js';

export type LoopProjectSelector = EffectiveCwdSource;

export interface LoopProjectCandidate {
  name?: string;
  /**
   * Absolute path, when the candidate is a store on disk. Config-declared
   * namespaces (`projects.known`) are names without a path of their own.
   */
  path?: string;
  /** How this candidate was discovered — `config` covers declared namespaces. */
  source: 'config' | 'registry' | 'filesystem' | 'store_chain';
}

/**
 * Observability payload. Ships on `dispatch_status` only (`_resolution_trace`):
 * the coordinate response carries the decision (`project_name`/`project_cwd`),
 * not the reasoning behind it.
 */
export interface LoopProjectResolutionTrace {
  /** cwd the handler was called with, before this gate. */
  source_cwd: string;
  /** cwd the loop will actually be written to. */
  effective_cwd: string;
  /** Which selector won. */
  active_source: LoopProjectSelector;
  /** The `project` argument as passed, when present. */
  project_arg?: string;
  /** Sibling projects this store can host — populated only when it can host any. */
  candidates: LoopProjectCandidate[];
}

export interface LoopProjectResolved {
  ok: true;
  project_cwd: string;
  project_name?: string;
  source: LoopProjectSelector;
  trace: LoopProjectResolutionTrace;
}

export interface LoopProjectAmbiguous {
  ok: false;
  code: 'needs_project_selection';
  message: string;
  candidates: LoopProjectCandidate[];
  trace: LoopProjectResolutionTrace;
}

export type LoopProjectResolution = LoopProjectResolved | LoopProjectAmbiguous;

export interface ValidateLoopProjectResolutionInput {
  /** Effective cwd as resolved by the caller's entry point. */
  cwd: string;
  /** Raw `project` argument from the tool call, when the caller passed one. */
  projectArg?: string;
  /**
   * Which selector produced `cwd`. MCP handlers get this from
   * `resolveEffectiveCwdInfo` via their tool context; omitting it is treated as
   * the bare-cwd fallback, which is the safe reading (it can only make the gate
   * stricter, never looser).
   */
  activeSource?: LoopProjectSelector;
}

/**
 * Decide which project a loop belongs to, or refuse when nobody chose.
 *
 * Throws only when an explicit `project` cannot be resolved — that error is
 * `resolveProjectCwd`'s (unknown project, unavailable link) and callers already
 * surface it as a tool error rather than silently falling back.
 */
export function validateLoopProjectResolution(
  input: ValidateLoopProjectResolutionInput,
): LoopProjectResolution {
  const sourceCwd = path.resolve(input.cwd);
  const projectArg = input.projectArg?.trim() || undefined;

  // 1. Explicit project wins outright and needs no ambiguity check: the caller
  //    named it, so there is nothing left to disambiguate.
  if (projectArg) {
    const projectCwd = path.resolve(resolveProjectCwd(projectArg, sourceCwd));
    return resolved(projectCwd, 'explicit', {
      source_cwd: sourceCwd,
      effective_cwd: projectCwd,
      active_source: 'explicit',
      project_arg: projectArg,
      candidates: [],
    });
  }

  // 2. A selector other than the bare cwd fallback means somebody DID choose —
  //    `--cwd`, BRAINCLAW_PROJECT, a session switch, the physical child store,
  //    or the workspace's active-project pointer. Honour it as-is.
  const activeSource: LoopProjectSelector = input.activeSource ?? 'cwd';
  if (activeSource !== 'cwd') {
    return resolved(sourceCwd, activeSource, {
      source_cwd: sourceCwd,
      effective_cwd: sourceCwd,
      active_source: activeSource,
      candidates: [],
    });
  }

  // 3. Bare fallback. Harmless in a single-project store (there is exactly one
  //    answer), a misroute waiting to happen in a store that hosts children.
  const candidates = collectCandidateProjects(sourceCwd);
  const trace: LoopProjectResolutionTrace = {
    source_cwd: sourceCwd,
    effective_cwd: sourceCwd,
    active_source: 'cwd',
    candidates,
  };
  if (candidates.length === 0) {
    return resolved(sourceCwd, 'cwd', trace);
  }

  const rendered = candidates
    .map((c) => {
      const label = c.name ?? (c.path ? path.basename(c.path) : '(unnamed)');
      return `  - ${label}${c.path ? ` (${c.path})` : ''}`;
    })
    .join('\n');
  return {
    ok: false,
    code: 'needs_project_selection',
    message:
      `This store hosts ${candidates.length} project(s) and no project was selected, so the loop would land in `
      + `${sourceCwd} by default rather than where the work is. Nothing was created.\n`
      + `Candidates:\n${rendered}\n`
      + `Choose one explicitly — pass project='<name>' on this call, or make it sticky with `
      + `bclaw_switch(project='<name>'). Ref/scope/path are never used to guess (B3, art_e29e88878209).`,
    candidates,
    trace,
  };
}

function resolved(
  projectCwd: string,
  source: LoopProjectSelector,
  trace: LoopProjectResolutionTrace,
): LoopProjectResolved {
  return {
    ok: true,
    project_cwd: projectCwd,
    project_name: projectNameFor(projectCwd),
    source,
    trace,
  };
}

function projectNameFor(cwd: string): string | undefined {
  try {
    return loadConfig(cwd).project_name;
  } catch {
    return undefined;
  }
}

/**
 * Sibling projects the store at `cwd` can host. Empty for an ordinary
 * single-project repo — which is what keeps this gate a strict no-op there.
 *
 * Two signals, both already load-bearing elsewhere in the codebase:
 * `project_mode === 'multi-project'` (the convention used by doctor / status /
 * code-map) and a `workspace`-role store with nested project stores under it.
 */
function collectCandidateProjects(cwd: string): LoopProjectCandidate[] {
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    // Uninitialised store: loop creation will fail downstream on its own terms.
    // Refusing here would only swap a clear error for a vaguer one.
    return [];
  }

  const seen = new Map<string, LoopProjectCandidate>();
  const add = (candidate: LoopProjectCandidate): void => {
    // A config-declared namespace has no store of its own yet, so it is keyed
    // by name; anything on disk is keyed by its absolute path.
    const abs = candidate.path ? path.resolve(cwd, candidate.path) : undefined;
    if (abs === cwd) return;
    const key = abs ?? `name:${candidate.name ?? ''}`;
    if (seen.has(key)) return;
    seen.set(key, { ...candidate, ...(abs ? { path: abs } : {}) });
  };

  if (config.project_mode === 'multi-project') {
    for (const project of summarizeWorkspaceProjects(cwd, config).discovered_projects) {
      add({
        name: project.project_name,
        // `config` entries carry a namespace name in `path`, not a real path.
        ...(project.source === 'config' ? {} : { path: project.path }),
        source: project.source,
      });
    }
  }

  if (resolvePrimaryStore(cwd)?.role === 'workspace') {
    for (const project of scanNestedBrainclawProjects(cwd)) {
      add({ name: project.project_name, path: project.path, source: 'store_chain' });
    }
  }

  return [...seen.values()].sort((a, b) => (a.path ?? a.name ?? '').localeCompare(b.path ?? b.name ?? ''));
}
