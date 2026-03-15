import fs from 'node:fs';
import path from 'node:path';
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