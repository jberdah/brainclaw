import fs from 'node:fs';
import path from 'node:path';
import { loadGlobalRegistry, scanProject, type RegisteredProject } from './global-registry.js';
import type { Config } from './schema.js';

const SKIP_DIRS = new Set([
  '.brainclaw',
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.next',
  '.nuxt',
]);

export interface DiscoveredWorkspaceProject {
  path: string;
  relative_path: string;
  project_id?: string;
  project_name?: string;
  source: 'config' | 'registry' | 'filesystem';
}

export interface WorkspaceProjectSummary {
  strategy: Config['projects']['strategy'];
  configured_projects: string[];
  discovered_projects: DiscoveredWorkspaceProject[];
  effective_project_count: number;
  uses_folder_resolution: boolean;
}

export function summarizeWorkspaceProjects(cwd: string, config: Pick<Config, 'project_mode' | 'projects'>): WorkspaceProjectSummary {
  const configuredProjects = config.projects?.known ?? [];
  const usesFolderResolution = config.project_mode === 'multi-project' && (config.projects?.strategy ?? 'manual') === 'folder';
  const discovered = new Map<string, DiscoveredWorkspaceProject>();

  for (const name of configuredProjects) {
    const key = `config:${name}`;
    discovered.set(key, {
      path: name,
      relative_path: name,
      project_name: name,
      source: 'config',
    });
  }

  if (usesFolderResolution) {
    for (const project of collectRegistryProjectsUnder(cwd)) {
      const normalized = path.resolve(project.path);
      if (normalized === path.resolve(cwd)) {
        continue;
      }
      discovered.set(`path:${normalized}`, {
        path: normalized,
        relative_path: path.relative(cwd, normalized) || '.',
        project_id: project.project_id,
        project_name: project.project_name,
        source: 'registry',
      });
    }

    for (const project of scanNestedBrainclawProjects(cwd)) {
      const normalized = path.resolve(project.path);
      if (normalized === path.resolve(cwd)) {
        continue;
      }
      if (!discovered.has(`path:${normalized}`)) {
        discovered.set(`path:${normalized}`, {
          path: normalized,
          relative_path: path.relative(cwd, normalized) || '.',
          project_id: project.project_id,
          project_name: project.project_name,
          source: 'filesystem',
        });
      }
    }
  }

  return {
    strategy: config.projects?.strategy ?? 'manual',
    configured_projects: configuredProjects,
    discovered_projects: [...discovered.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
    effective_project_count: discovered.size,
    uses_folder_resolution: usesFolderResolution,
  };
}

/**
 * pln#649 step 3 review P1-1 — the scan plus whether it was TRUNCATED.
 *
 * A caller that turns "no project found" into a refusal must be able to tell that
 * apart from "I stopped looking". Inferring it from the results is not enough, and
 * that mistake was reproduced: with a store at `root/d1/…/d7` and nothing in
 * `d1…d6`, the walk cut the branch without ever returning a project near the
 * ceiling, so a heuristic based on the deepest RESULT reported completeness while
 * the target sat one level below the cut. Truncation is a property of the WALK, so
 * only the walk can report it.
 */
export function scanNestedBrainclawProjectsDetailed(
  rootDir: string,
  maxDepth = 6,
): { projects: RegisteredProject[]; truncated: boolean } {
  const resolvedRoot = path.resolve(rootDir);
  const results = new Map<string, RegisteredProject>();
  let truncated = false;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) {
      // A branch we were asked to descend is being cut: anything below is unseen.
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.brainclaw') continue;

      const childDir = path.join(dir, entry.name);
      const maybeProject = scanProject(childDir);
      if (maybeProject) {
        results.set(path.resolve(maybeProject.path), maybeProject);
      }
      walk(childDir, depth + 1);
    }
  }

  walk(resolvedRoot, 1);
  return {
    projects: [...results.values()].sort((a, b) => a.path.localeCompare(b.path)),
    truncated,
  };
}

/** Backward-compatible projection: the projects only, for every existing caller. */
export function scanNestedBrainclawProjects(rootDir: string, maxDepth = 6): RegisteredProject[] {
  return scanNestedBrainclawProjectsDetailed(rootDir, maxDepth).projects;
}

function collectRegistryProjectsUnder(rootDir: string): RegisteredProject[] {
  const registry = loadGlobalRegistry();
  if (!registry) {
    return [];
  }

  const resolvedRoot = path.resolve(rootDir);
  return registry.projects.filter((project) => isWithinRoot(project.path, resolvedRoot));
}

function isWithinRoot(candidatePath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
