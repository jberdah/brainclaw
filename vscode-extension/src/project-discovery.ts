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

    if (relativePath === '.' && !shouldScanNestedProjects(normalizedPath)) {
      return;
    }
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

// Dependency-free, quote/comment-tolerant scalar read. The extension ships
// zero runtime deps by design, so we don't pull a YAML parser in just to read
// the handful of canonical fields brainclaw writes in config.yaml. Unlike a
// line-anchored regex, this tolerates quoted values (project_mode: "multi")
// and trailing comments (strategy: manual  # note). If the config shape ever
// grows richer, swap this for a real parser.
function readScalar(yaml: string, key: string): string | undefined {
  const match = new RegExp(`^[\\t ]*${key}:[\\t ]*(.*)$`, 'm').exec(yaml);
  if (!match) return undefined;
  let value = match[1];
  const comment = value.search(/\s#/);
  if (comment >= 0) value = value.slice(0, comment);
  value = value.trim();
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && first === last && (first === '"' || first === "'")) {
    value = value.slice(1, -1);
  }
  return value;
}

function shouldScanNestedProjects(projectPath: string): boolean {
  const configPath = path.join(projectPath, '.brainclaw', 'config.yaml');
  let config = '';
  try {
    config = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return false;
  }

  // Explicit multi-project mode → scan nested.
  if (readScalar(config, 'project_mode') === 'multi') {
    return true;
  }

  // A non-empty `known` list (inline `[a, b]`) → multi-project.
  const known = readScalar(config, 'known');
  if (known !== undefined && known !== '' && known !== '[]') {
    return true;
  }

  // A `projects:` block that lists project entries (`- name`) → multi-project.
  const projectsBlock = /\nprojects:\s*\n([\s\S]*?)(?=\n\S|\s*$)/m.exec(config)?.[1] ?? '';
  if (/^\s*-\s+\S+/m.test(projectsBlock)) {
    return true;
  }

  // Default: scan nested unless this root is an explicitly manual single-project.
  return readScalar(projectsBlock, 'strategy') !== 'manual';
}
