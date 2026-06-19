/**
 * Code Map durable store — init/read/write for manifest, profiler, and shards
 * (spec §4, §5). All writes go through `writeFileAtomic` (io.ts), which is the
 * spec's NTFS-safe atomic temp+rename with EPERM/EBUSY backoff.
 *
 * Queries must be answerable from `files/**` + `indexes/**` alone; the
 * `materialized/` cache is rebuildable and never required (spec §4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../io.js';
import {
  CODE_MAP_SCHEMA_VERSION,
  FileShardSchema,
  ImportsIndexSchema,
  ManifestSchema,
  ProfilerSchema,
  SymbolsIndexSchema,
  type FileShard,
  type ImportsIndex,
  type Manifest,
  type Profiler,
  type SymbolsIndex,
} from './types.js';
import {
  codeMapDir,
  filesDir,
  importsIndexPath,
  indexesDir,
  manifestPath,
  profilerPath,
  shardPath,
  symbolsIndexPath,
} from './paths.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Read whole JSON file into memory before parsing (spec §6 — NTFS handle contention). */
function readJsonFile(filepath: string): unknown | null {
  if (!fs.existsSync(filepath)) return null;
  try {
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Create the on-disk skeleton: code/, files/, indexes/ (materialized/ is lazy). */
export function ensureStoreDirs(cwd?: string, preferredDirName?: string): void {
  ensureDir(codeMapDir(cwd, preferredDirName));
  ensureDir(filesDir(cwd, preferredDirName));
  ensureDir(indexesDir(cwd, preferredDirName));
}

export interface InitStoreInput {
  projectId: string;
  projectRoot: string;
  extractorVersion: string;
  extractorConfig: Manifest['extractor_config'];
  extractorConfigHash: string;
  languages?: Manifest['languages'];
  git?: Partial<Manifest['git']>;
  worktree?: Partial<Manifest['worktree']>;
  engineGlueHash?: string | null;
  cwd?: string;
  preferredDirName?: string;
}

/**
 * Initialize a fresh Code Map store. A brand-new store starts in
 * `missing_index` freshness (nothing parsed yet — spec §5.1).
 */
export function initStore(input: InitStoreInput): Manifest {
  ensureStoreDirs(input.cwd, input.preferredDirName);
  const now = new Date().toISOString();
  const manifest: Manifest = ManifestSchema.parse({
    schema_version: CODE_MAP_SCHEMA_VERSION,
    project_id: input.projectId,
    code_map_enabled: true,
    project_root: input.projectRoot,
    code_map_version: 1,
    store_created_at: now,
    updated_at: now,
    active_backend: 'jsonl',
    extractor_version: input.extractorVersion,
    extractor_config_hash: input.extractorConfigHash,
    engine_glue_hash: input.engineGlueHash ?? null,
    extractor_config: input.extractorConfig,
    languages: input.languages ?? {},
    git: { head: null, branch: null, dirty: false, ...input.git },
    worktree: { worktree_id: null, path: null, ...input.worktree },
    stats: {
      files_indexed: 0,
      nodes: 0,
      edges: 0,
      last_full_refresh_ms: null,
      last_changed_refresh_ms: null,
    },
    freshness: { status: 'missing_index', stale_file_count: 0, partial_reason: null },
  });
  writeManifest(manifest, input.cwd, input.preferredDirName);
  return manifest;
}

/**
 * Read the manifest. Tolerates a missing store: returns `null` so callers can
 * surface a `missing_index` freshness badge instead of throwing (spec §6.1).
 */
export function readManifest(cwd?: string, preferredDirName?: string): Manifest | null {
  const raw = readJsonFile(manifestPath(cwd, preferredDirName));
  if (raw === null) return null;
  const parsed = ManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function writeManifest(manifest: Manifest, cwd?: string, preferredDirName?: string): void {
  ensureDir(codeMapDir(cwd, preferredDirName));
  const next = { ...manifest, updated_at: new Date().toISOString() };
  writeFileAtomic(manifestPath(cwd, preferredDirName), JSON.stringify(next, null, 2));
}

export function readProfiler(cwd?: string, preferredDirName?: string): Profiler | null {
  const raw = readJsonFile(profilerPath(cwd, preferredDirName));
  if (raw === null) return null;
  const parsed = ProfilerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function writeProfiler(profiler: Profiler, cwd?: string, preferredDirName?: string): void {
  ensureDir(codeMapDir(cwd, preferredDirName));
  const next = { ...profiler, updated_at: new Date().toISOString() };
  writeFileAtomic(profilerPath(cwd, preferredDirName), JSON.stringify(next, null, 2));
}

/** Read one shard by file id. Returns null on missing/corrupt (readers tolerate). */
export function readShard(
  fileIdHash: string,
  cwd?: string,
  preferredDirName?: string,
): FileShard | null {
  const raw = readJsonFile(shardPath(fileIdHash, cwd, preferredDirName));
  if (raw === null) return null;
  const parsed = FileShardSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Write one shard. Ensures the hash-prefix dir exists, then atomic write. */
export function writeShard(shard: FileShard, cwd?: string, preferredDirName?: string): void {
  const target = shardPath(shard.file_id, cwd, preferredDirName);
  ensureDir(path.dirname(target));
  writeFileAtomic(target, JSON.stringify(shard, null, 2));
}

export function deleteShard(fileIdHash: string, cwd?: string, preferredDirName?: string): void {
  const target = shardPath(fileIdHash, cwd, preferredDirName);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch {
    /* best effort */
  }
}

/** Enumerate every shard under files/** (used by index rebuild + queries). */
export function listShards(cwd?: string, preferredDirName?: string): FileShard[] {
  const root = filesDir(cwd, preferredDirName);
  if (!fs.existsSync(root)) return [];
  const shards: FileShard[] = [];
  for (const prefix of fs.readdirSync(root)) {
    const prefixDir = path.join(root, prefix);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(prefixDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(prefixDir)) {
      // Readers never consume a temp file (spec §6 rule 6).
      if (!entry.endsWith('.json') || entry.includes('.tmp')) continue;
      const raw = readJsonFile(path.join(prefixDir, entry));
      if (raw === null) continue;
      const parsed = FileShardSchema.safeParse(raw);
      if (parsed.success) shards.push(parsed.data);
    }
  }
  return shards;
}

export function readSymbolsIndex(cwd?: string, preferredDirName?: string): SymbolsIndex | null {
  const raw = readJsonFile(symbolsIndexPath(cwd, preferredDirName));
  if (raw === null) return null;
  const parsed = SymbolsIndexSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Re-home entries onto a null-proto object so a token lookup like
  // entries['constructor'] / entries['toString'] cannot resolve to an inherited
  // Object.prototype member (a non-iterable function) on a JSON-parsed object.
  parsed.data.entries = Object.assign(Object.create(null), parsed.data.entries);
  return parsed.data;
}

export function writeSymbolsIndex(index: SymbolsIndex, cwd?: string, preferredDirName?: string): void {
  ensureDir(indexesDir(cwd, preferredDirName));
  writeFileAtomic(symbolsIndexPath(cwd, preferredDirName), JSON.stringify(index, null, 2));
}

export function readImportsIndex(cwd?: string, preferredDirName?: string): ImportsIndex | null {
  const raw = readJsonFile(importsIndexPath(cwd, preferredDirName));
  if (raw === null) return null;
  const parsed = ImportsIndexSchema.safeParse(raw);
  if (!parsed.success) return null;
  parsed.data.entries = Object.assign(Object.create(null), parsed.data.entries);
  return parsed.data;
}

export function writeImportsIndex(index: ImportsIndex, cwd?: string, preferredDirName?: string): void {
  ensureDir(indexesDir(cwd, preferredDirName));
  writeFileAtomic(importsIndexPath(cwd, preferredDirName), JSON.stringify(index, null, 2));
}

/** True when a Code Map store has been initialized for this project. */
export function storeExists(cwd?: string, preferredDirName?: string): boolean {
  return fs.existsSync(manifestPath(cwd, preferredDirName));
}
