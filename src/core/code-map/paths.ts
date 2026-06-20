/**
 * Code Map store layout path helpers (spec §4).
 *
 * All paths are relative to `<project>/.brainclaw/code/`. The store root is
 * derived from the Brainclaw memory dir convention (`.brainclaw/`).
 */
import path from 'node:path';
import { MEMORY_DIR } from '../io.js';
import { shardPrefix } from './ids.js';

/** Subdirectory under `.brainclaw/` that holds the Code Map store. */
export const CODE_MAP_SUBDIR = 'code';

/** Absolute path to `<project>/.brainclaw/code/`. */
export function codeMapDir(cwd: string = process.cwd(), preferredDirName?: string): string {
  return path.join(cwd, preferredDirName ?? MEMORY_DIR, CODE_MAP_SUBDIR);
}

export function manifestPath(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), 'manifest.json');
}

export function profilerPath(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), 'profiler.json');
}

export function lockPath(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), '.lock');
}

export function filesDir(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), 'files');
}

/** Absolute path to a per-file shard: files/<prefix>/<file_id>.json. */
export function shardPath(fileIdHash: string, cwd?: string, preferredDirName?: string): string {
  return path.join(filesDir(cwd, preferredDirName), shardPrefix(fileIdHash), `${fileIdHash}.json`);
}

export function indexesDir(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), 'indexes');
}

export function symbolsIndexPath(cwd?: string, preferredDirName?: string): string {
  return path.join(indexesDir(cwd, preferredDirName), 'index.symbols.v1.json');
}

export function importsIndexPath(cwd?: string, preferredDirName?: string): string {
  return path.join(indexesDir(cwd, preferredDirName), 'index.imports.v1.json');
}

export function resolutionIndexPath(cwd?: string, preferredDirName?: string): string {
  return path.join(indexesDir(cwd, preferredDirName), 'index.resolution.v1.json');
}

export function materializedDir(cwd?: string, preferredDirName?: string): string {
  return path.join(codeMapDir(cwd, preferredDirName), 'materialized');
}

export function materializedNodesPath(cwd?: string, preferredDirName?: string): string {
  return path.join(materializedDir(cwd, preferredDirName), 'nodes.v1.jsonl');
}

export function materializedEdgesPath(cwd?: string, preferredDirName?: string): string {
  return path.join(materializedDir(cwd, preferredDirName), 'edges.v1.jsonl');
}
