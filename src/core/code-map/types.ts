/**
 * Brainclaw Code Map — durable store schemas (spec §5).
 *
 * Every persisted object carries `schema_version`. zod schemas are the runtime
 * source of truth; the exported TS types are inferred from them so the two can
 * never drift.
 */
import { z } from 'zod';

/** Current schema version for all Code Map objects in P0. */
export const CODE_MAP_SCHEMA_VERSION = 1;

const Sha256Hash = z.string();

// --- Enums (spec §5) ---

/** spec §5.3 — per-file shard parse outcome. */
export const ParseStatusSchema = z.enum([
  'parsed',
  'skipped_too_large',
  'skipped_unsupported',
  'parse_error',
]);
export type ParseStatus = z.infer<typeof ParseStatusSchema>;

/** spec §5.4 — node kinds. */
export const NodeKindSchema = z.enum(['file', 'module', 'symbol']);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** spec §5.4 — symbol subtypes. */
export const NodeSubtypeSchema = z.enum([
  'function',
  'class',
  'type',
  'interface',
  'component',
  'hook',
  'variable',
  'export',
]);
export type NodeSubtype = z.infer<typeof NodeSubtypeSchema>;

/** spec §5.5 — reliable edge kinds (no calls/renders/uses in P0). */
export const EdgeKindSchema = z.enum(['contains', 'imports', 'exports', 'defines']);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/** spec §5.1 — freshness status enum, shared by manifest + read responses. */
export const FreshnessStatusSchema = z.enum([
  'fresh',
  'stale_changed_files',
  'stale_extractor',
  'stale_grammar',
  'partial',
  'missing_index',
]);
export type FreshnessStatus = z.infer<typeof FreshnessStatusSchema>;

/** Per-file language tag. */
export const CodeLangSchema = z.enum(['javascript', 'typescript', 'tsx', 'jsx']);
export type CodeLang = z.infer<typeof CodeLangSchema>;

// --- Node / Edge / Span (spec §5.4, §5.5) ---

export const SpanSchema = z.object({
  start_line: z.number().int(),
  start_col: z.number().int(),
  end_line: z.number().int(),
  end_col: z.number().int(),
});
export type Span = z.infer<typeof SpanSchema>;

export const NodeSchema = z.object({
  id: z.string(),
  kind: NodeKindSchema,
  subtype: NodeSubtypeSchema.nullable().optional(),
  lang: CodeLangSchema,
  name: z.string(),
  path: z.string(),
  span: SpanSchema.nullable().optional(),
  exported: z.boolean().default(false),
  confidence: z.number().default(1.0),
  related_memory_ids: z.array(z.string()).default([]),
  /**
   * For `module` nodes: the named bindings pulled from this import/re-export
   * (e.g. ["useEffect","useMemo"]). Default import → ["default"], namespace
   * import → ["*"]. Feeds index.imports.v1 `imported[]` (spec §5.7). Empty/absent
   * for non-module nodes.
   */
  imported_names: z.array(z.string()).default([]),
});
export type CodeNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  confidence: z.number().default(1.0),
  source: z
    .object({
      path: z.string(),
      line: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type CodeEdge = z.infer<typeof EdgeSchema>;

// --- Per-file shard (spec §5.3) ---

export const ShardFreshnessSchema = z.object({
  status: FreshnessStatusSchema,
  reason: z.string().nullable().default(null),
});
export type ShardFreshness = z.infer<typeof ShardFreshnessSchema>;

export const FileShardSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  file_id: Sha256Hash,
  project_id: z.string(),
  worktree_id: z.string().nullable().optional(),
  path: z.string(),
  lang: CodeLangSchema,
  file_hash: Sha256Hash,
  mtime_ms: z.number(),
  size_bytes: z.number().int(),
  parse_status: ParseStatusSchema,
  git_head: z.string().nullable().optional(),
  extractor_version: z.string(),
  extractor_config_hash: Sha256Hash,
  grammar_name: z.string().nullable().optional(),
  grammar_version: z.string().nullable().optional(),
  tree_sitter_grammar_hash: Sha256Hash.nullable().optional(),
  freshness: ShardFreshnessSchema,
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  diagnostics: z.array(z.unknown()).default([]),
});
export type FileShard = z.infer<typeof FileShardSchema>;

// --- manifest.json (spec §5.1) ---

export const ExtractorConfigSchema = z.object({
  included_extensions: z.array(z.string()),
  ignored_patterns_hash: Sha256Hash,
  max_parse_file_bytes: z.number().int(),
  max_query_wait_ms: z.number().int(),
});
export type ExtractorConfig = z.infer<typeof ExtractorConfigSchema>;

export const LanguageEntrySchema = z.object({
  enabled: z.boolean(),
  grammar_name: z.string(),
  grammar_version: z.string(),
  tree_sitter_grammar_hash: Sha256Hash,
});
export type LanguageEntry = z.infer<typeof LanguageEntrySchema>;

export const ManifestGitSchema = z.object({
  head: z.string().nullable(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
});
export type ManifestGit = z.infer<typeof ManifestGitSchema>;

export const ManifestWorktreeSchema = z.object({
  worktree_id: z.string().nullable(),
  path: z.string().nullable(),
});
export type ManifestWorktree = z.infer<typeof ManifestWorktreeSchema>;

export const ManifestStatsSchema = z.object({
  files_indexed: z.number().int().default(0),
  nodes: z.number().int().default(0),
  edges: z.number().int().default(0),
  last_full_refresh_ms: z.number().nullable().default(null),
  last_changed_refresh_ms: z.number().nullable().default(null),
});
export type ManifestStats = z.infer<typeof ManifestStatsSchema>;

export const ManifestFreshnessSchema = z.object({
  status: FreshnessStatusSchema,
  stale_file_count: z.number().int().default(0),
  partial_reason: z.string().nullable().default(null),
});
export type ManifestFreshness = z.infer<typeof ManifestFreshnessSchema>;

export const ManifestSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  project_id: z.string(),
  code_map_enabled: z.boolean().default(true),
  project_root: z.string(),
  code_map_version: z.number().int().default(1),
  store_created_at: z.string(),
  updated_at: z.string(),
  active_backend: z.string().default('jsonl'),
  extractor_version: z.string(),
  extractor_config_hash: Sha256Hash,
  engine_glue_hash: Sha256Hash.nullable().default(null),
  extractor_config: ExtractorConfigSchema,
  languages: z.record(z.string(), LanguageEntrySchema).default({}),
  git: ManifestGitSchema,
  worktree: ManifestWorktreeSchema,
  stats: ManifestStatsSchema,
  freshness: ManifestFreshnessSchema,
});
export type Manifest = z.infer<typeof ManifestSchema>;

// --- profiler.json (spec §5.2) ---

export const ProfilerRootSchema = z.object({
  path: z.string(),
  kind: z.string(),
  manifest_files: z.array(z.string()).default([]),
  source_file_count: z.number().int().default(0),
  estimated_loc: z.number().int().default(0),
  recommended: z.boolean().default(false),
});
export type ProfilerRoot = z.infer<typeof ProfilerRootSchema>;

export const ProfilerSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  project_id: z.string(),
  last_profiled_at: z.string(),
  detection_method: z.string().default('manifest-and-source-scan'),
  updated_at: z.string(),
  roots: z.array(ProfilerRootSchema).default([]),
  ignored: z.object({
    patterns: z.array(z.string()).default([]),
    source: z.array(z.string()).default([]),
  }),
});
export type Profiler = z.infer<typeof ProfilerSchema>;

// --- indexes (spec §5.6, §5.7) ---

export const SymbolIndexEntrySchema = z.object({
  node_id: z.string(),
  name: z.string(),
  kind: NodeKindSchema,
  subtype: NodeSubtypeSchema.nullable().optional(),
  path: z.string(),
  file_id: Sha256Hash,
  score_hint: z.number().default(1.0),
});
export type SymbolIndexEntry = z.infer<typeof SymbolIndexEntrySchema>;

export const SymbolsIndexSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  project_id: z.string(),
  updated_at: z.string(),
  extractor_version: z.string(),
  /** Keys are normalized lowercase tokens. */
  entries: z.record(z.string(), z.array(SymbolIndexEntrySchema)).default({}),
});
export type SymbolsIndex = z.infer<typeof SymbolsIndexSchema>;

export const ImportIndexEntrySchema = z.object({
  path: z.string(),
  file_id: Sha256Hash,
  imported: z.array(z.string()).default([]),
});
export type ImportIndexEntry = z.infer<typeof ImportIndexEntrySchema>;

export const ImportsIndexSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  project_id: z.string(),
  updated_at: z.string(),
  /** Keys are module specifiers (e.g. "react"). */
  entries: z.record(z.string(), z.array(ImportIndexEntrySchema)).default({}),
});
export type ImportsIndex = z.infer<typeof ImportsIndexSchema>;

// --- .lock (spec §5.8) ---

export const CodeLockSchema = z.object({
  schema_version: z.number().int().default(CODE_MAP_SCHEMA_VERSION),
  lock_id: z.string(),
  project_id: z.string().nullable().optional(),
  worktree_id: z.string().nullable().optional(),
  owner_agent: z.string().nullable().optional(),
  owner_agent_id: z.string().nullable().optional(),
  pid: z.number().int(),
  operation: z.string(),
  scope: z.string(),
  created_at: z.string(),
  heartbeat_at: z.string(),
  stale_after_ms: z.number().int(),
});
export type CodeLock = z.infer<typeof CodeLockSchema>;

/** Freshness badge attached to every agent-facing read response (spec §9). */
export const FreshnessBadgeSchema = z.object({
  status: FreshnessStatusSchema,
  details: z.record(z.string(), z.unknown()).default({}),
});
export type FreshnessBadge = z.infer<typeof FreshnessBadgeSchema>;
