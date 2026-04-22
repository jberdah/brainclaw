import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface DiscoveredBrainclawProject {
  path: string;
  name: string;
  relativePath: string;
  isWorkspaceRoot: boolean;
}

export const PROJECT_SCAN_MAX_DEPTH = 6;

const PROJECT_SCAN_SKIP_DIRS = new Set([
  '.brainclaw',
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

export function discoverBrainclawProjects(
  workspaceFolders: readonly WorkspaceFolderLike[],
  maxDepth = PROJECT_SCAN_MAX_DEPTH,
): DiscoveredBrainclawProject[] {
  const discovered = new Map<string, DiscoveredBrainclawProject>();
  for (const folder of workspaceFolders) {
    scanWorkspaceFolder(folder.uri.fsPath, folder.uri.fsPath, 0, maxDepth, discovered);
  }

  return [...discovered.values()].sort((left, right) => {
    if (left.isWorkspaceRoot !== right.isWorkspaceRoot) {
      return left.isWorkspaceRoot ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath) || left.path.localeCompare(right.path);
  });
}

function scanWorkspaceFolder(
  rootPath: string,
  currentPath: string,
  depth: number,
  maxDepth: number,
  discovered: Map<string, DiscoveredBrainclawProject>,
): void {
  if (depth > maxDepth) {
    return;
  }

  const normalizedPath = path.resolve(currentPath);
  if (fs.existsSync(path.join(normalizedPath, '.brainclaw'))) {
    const relativePath = path.relative(rootPath, normalizedPath) || '.';
    discovered.set(normalizedPath, {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      relativePath,
      isWorkspaceRoot: relativePath === '.',
    });
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.brainclaw') continue;
    scanWorkspaceFolder(rootPath, path.join(normalizedPath, entry.name), depth + 1, maxDepth, discovered);
  }
}
