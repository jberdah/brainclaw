import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';
import type { ProjectMode } from './schema.js';

export interface RepoAnalysisResult {
  recommendedMode: ProjectMode;
  reasons: string[];
}

const MULTI_PROJECT_MARKERS = [
  'pnpm-workspace.yaml',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'rush.json',
];

const MULTI_PROJECT_DIRS = ['apps', 'packages', 'services'];

export function analyzeRepository(cwd: string): RepoAnalysisResult {
  const reasons: string[] = [];

  for (const marker of MULTI_PROJECT_MARKERS) {
    if (fs.existsSync(path.join(cwd, marker))) {
      reasons.push(`Found workspace marker: ${marker}`);
    }
  }

  const matchedDirs = MULTI_PROJECT_DIRS.filter((dirName) => {
    const dirPath = path.join(cwd, dirName);
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  });
  if (matchedDirs.length > 0) {
    reasons.push(`Found top-level project folders: ${matchedDirs.join(', ')}`);
  }

  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        workspaces?: unknown;
      };
      if (packageJson.workspaces) {
        reasons.push('Found workspace configuration in package.json');
      }
    } catch {
      // Ignore package.json parse errors during advisory analysis.
    }
  }

  if (reasons.length > 0) {
    return {
      recommendedMode: 'multi-project',
      reasons,
    };
  }

  return {
    recommendedMode: 'single-project',
    reasons: ['No monorepo or multi-project markers detected'],
  };
}

/** Markers whose presence indicates a service/project boundary worth initialising. */
const SERVICE_MARKERS = [
  'package.json',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'go.mod',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

/** Directories to skip when scanning for service boundaries. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'build',
  '.brainclaw',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
]);

export interface WorkspaceScanResult {
  /** Directories that look like service roots and don't have .brainclaw/ yet. */
  suggestions: Array<{
    dir: string;
    relativePath: string;
    markers: string[];
  }>;
  /** Directories already initialised (have .brainclaw/). */
  alreadyInitialised: Array<{ dir: string; relativePath: string }>;
}

/**
 * Walk up to `maxDepth` levels below `rootDir`, find subdirectories that
 * contain service markers but no `.brainclaw/` yet.
 *
 * `rootDir` itself is excluded (the caller is presumably about to `init` it).
 */
export function scanWorkspaceBoundaries(
  rootDir: string,
  maxDepth = 3,
): WorkspaceScanResult {
  const suggestions: WorkspaceScanResult['suggestions'] = [];
  const alreadyInitialised: WorkspaceScanResult['alreadyInitialised'] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

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
      const childEntries = (() => {
        try {
          return fs.readdirSync(childDir).map((n) => n);
        } catch {
          return [] as string[];
        }
      })();

      const hasMemory = childEntries.includes(MEMORY_DIR);
      const foundMarkers = SERVICE_MARKERS.filter((m) => childEntries.includes(m));

      const relPath = path.relative(rootDir, childDir);

      if (hasMemory) {
        alreadyInitialised.push({ dir: childDir, relativePath: relPath });
      } else if (foundMarkers.length > 0) {
        suggestions.push({ dir: childDir, relativePath: relPath, markers: foundMarkers });
      }

      // Only recurse into dirs that didn't already match a boundary
      if (!hasMemory && foundMarkers.length === 0) {
        walk(childDir, depth + 1);
      }
    }
  }

  walk(rootDir, 1);
  return { suggestions, alreadyInitialised };
}