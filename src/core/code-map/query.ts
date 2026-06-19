/**
 * Code Map query logic (spec §6.1, §9, §11, §12.1) — the agent-facing
 * `find()` / `brief()` implementations live here; backend.ts is the thin
 * CodeQueryBackend adapter that wires this to the durable store.
 *
 * Everything reads from `indexes/**` + `files/**` (store.ts readers). No WASM,
 * no graph DB. The hot correctness feature is the bounded lazy read-path
 * freshness check (§6.1): before a shard selected from an index is trusted, we
 * stat the live file and, when cheap, hash it — detecting modifications and
 * deletions (NOT additions) within a per-query budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hashContent } from './extractor.js';
import {
  readImportsIndex,
  readManifest,
  readShard,
  readSymbolsIndex,
} from './store.js';
import type {
  FreshnessBadge,
  FreshnessStatus,
  ImportsIndex,
  SymbolIndexEntry,
  SymbolsIndex,
} from './types.js';

// --- lazy read-path freshness budget (spec §6.1) ---

/** Default per-query lazy-check budget (spec §6.1). */
export const LAZY_BUDGET = {
  maxFilesChecked: 32,
  maxWallMs: 2500,
} as const;

interface LazyChecker {
  /** Per-query budget config. */
  readonly budget: { maxFilesChecked: number; maxWallMs: number };
  /** Wall clock start of this query (for max_wall_ms). */
  readonly startedAt: number;
  /** Memoizes a path's outcome so one file spends one budget slot, not many. */
  readonly memo: Map<string, boolean>;
  /** Number of content hashes actually performed (budget consumption). */
  filesChecked: number;
  /** True once max_files_checked or max_wall_ms is exhausted. */
  exhausted: boolean;
}

/**
 * Build a bounded lazy freshness checker for a single query (spec §6.1). The
 * stat/hash logic lives in `validateEntry`, which compares against the stored
 * shard's mtime/size/file_hash; this object only carries the shared budget +
 * per-path memoization so a brief() that touches one file from several ranking
 * signals spends a single budget slot.
 */
function makeLazyChecker(
  budget: { maxFilesChecked: number; maxWallMs: number } = LAZY_BUDGET,
): LazyChecker {
  return {
    budget,
    startedAt: Date.now(),
    memo: new Map(),
    filesChecked: 0,
    exhausted: false,
  };
}

/** Has the lazy-check budget (file count or wall clock) been spent? */
function budgetExhausted(checker: LazyChecker): boolean {
  if (checker.exhausted) return true;
  if (checker.filesChecked >= checker.budget.maxFilesChecked) {
    checker.exhausted = true;
  } else if (Date.now() - checker.startedAt >= checker.budget.maxWallMs) {
    checker.exhausted = true;
  }
  return checker.exhausted;
}

/** Reasons attached to the response badge details. */
interface FreshnessAccumulator {
  staleChangedPaths: Set<string>;
  missingPaths: Set<string>;
  /** Could not validate this path. Superset that includes `budgetSkippedPaths`. */
  uncheckedPaths: Set<string>;
  /**
   * Subset of `uncheckedPaths` left unverified specifically because the lazy
   * budget (file count / wall clock) was spent — the only case §6.1.6 maps to a
   * `partial` badge. Unchecked-for-other-reasons (oversized file, missing shard,
   * unreadable file) must NOT be mislabeled as budget exhaustion.
   */
  budgetSkippedPaths: Set<string>;
}

function newAccumulator(): FreshnessAccumulator {
  return {
    staleChangedPaths: new Set(),
    missingPaths: new Set(),
    uncheckedPaths: new Set(),
    budgetSkippedPaths: new Set(),
  };
}

/**
 * Validate a single index entry's backing shard against the live file. Uses the
 * shard's stored mtime/size + file_hash for an accurate content comparison.
 * Records the outcome on the accumulator. Returns whether the entry may be
 * served as a *confident* (fresh) result.
 */
function validateEntry(
  entry: { path: string; file_id: string },
  checker: LazyChecker,
  acc: FreshnessAccumulator,
  projectRoot: string,
  maxParseFileBytes: number,
  cwd: string | undefined,
  preferredDirName: string | undefined,
): boolean {
  const cached = checker.memo.get(entry.path);
  if (cached !== undefined) return cached;

  const abs = path.join(projectRoot, entry.path);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    acc.missingPaths.add(entry.path); // §6.1.2 — deletion.
    checker.memo.set(entry.path, false);
    return false;
  }
  const shard = readShard(entry.file_id, cwd, preferredDirName);
  if (!shard) {
    // No backing shard to compare against — treat as unchecked, not confident.
    acc.uncheckedPaths.add(entry.path);
    checker.memo.set(entry.path, false);
    return false;
  }
  // §6.1.3 — cheap gate: mtime + size match => fresh for this read.
  if (stat.mtimeMs === shard.mtime_ms && stat.size === shard.size_bytes) {
    checker.memo.set(entry.path, true);
    return true;
  }
  // §6.1.4/§6.1.6 — gate tripped: hash only when within budget AND not oversized.
  // These are distinct reasons: an oversized file can never be hashed on the read
  // path (§6.1.4), whereas a budget-exhausted skip is what §6.1.6 maps to
  // `partial`. Keep them separable so the badge reason is accurate.
  if (stat.size > maxParseFileBytes) {
    acc.uncheckedPaths.add(entry.path); // structurally unverifiable, not budget.
    checker.memo.set(entry.path, false);
    return false;
  }
  if (budgetExhausted(checker)) {
    acc.uncheckedPaths.add(entry.path);
    acc.budgetSkippedPaths.add(entry.path);
    checker.memo.set(entry.path, false);
    return false;
  }
  checker.filesChecked++;
  let live: string;
  try {
    live = fs.readFileSync(abs, 'utf-8');
  } catch {
    acc.uncheckedPaths.add(entry.path);
    checker.memo.set(entry.path, false);
    return false;
  }
  if (hashContent(live) === shard.file_hash) {
    checker.memo.set(entry.path, true); // §6.1 — identical despite mtime touch.
    return true;
  }
  acc.staleChangedPaths.add(entry.path); // §6.1.5 — confirmed content change.
  checker.memo.set(entry.path, false);
  return false;
}

/**
 * Derive the response freshness badge from the base manifest status + the
 * outcomes recorded during this query's lazy check (spec §6.1, §9).
 *
 * Precedence: an exhausted budget yields `partial`; otherwise any detected
 * change/deletion yields `stale_changed_files`; else the manifest base status.
 */
function deriveBadge(
  base: FreshnessStatus,
  acc: FreshnessAccumulator,
  budgetExhausted: boolean,
  hadConfidentMatch: boolean,
  emptyIndex: boolean,
): FreshnessBadge {
  const details: Record<string, unknown> = {};
  if (acc.staleChangedPaths.size > 0) {
    details.stale_changed_files = [...acc.staleChangedPaths].sort();
  }
  if (acc.missingPaths.size > 0) {
    details.deleted_files = [...acc.missingPaths].sort();
  }
  if (acc.uncheckedPaths.size > 0) {
    details.unchecked_files = [...acc.uncheckedPaths].sort();
  }

  let status: FreshnessStatus = base;
  if (emptyIndex && base !== 'missing_index') {
    // §6.1 — zero confident matches: hint refresh rather than imply absence.
    details.hint = 'missing_index_or_refresh';
  }

  if (acc.staleChangedPaths.size > 0 || acc.missingPaths.size > 0) {
    status = 'stale_changed_files';
  }

  // §6.1.6 — `partial` means the lazy-check budget (file count / wall clock) ran
  // out before we could validate everything. Reserve it for that cause only:
  // unchecked-for-other-reasons (oversized file per §6.1.4, missing shard,
  // unreadable file) must NOT be mislabeled as budget exhaustion. When the budget
  // truly ran out, `partial` wins the top-line status — the agent should refresh
  // before trusting the result — and the confirmed-stale list still rides along
  // in `details.stale_changed_files`.
  if (budgetExhausted || acc.budgetSkippedPaths.size > 0) {
    status = 'partial';
    details.partial_reason = 'lazy_check_budget_exhausted';
    details.budget = { ...LAZY_BUDGET };
  }
  void hadConfidentMatch;
  return { status, details };
}

// --- find() (spec §12.1) ---

export interface FindMatch {
  node_id: string;
  name: string;
  path: string;
  file_id: string;
  kind: string;
  subtype: string | null;
  score: number;
}

export interface FindOutput {
  query: string;
  matches: FindMatch[];
  freshness_badge: FreshnessBadge;
}

export interface QueryContext {
  cwd?: string;
  preferredDirName?: string;
  /** Source root for the live freshness stat/hash (falls back to manifest/cwd). */
  projectRoot?: string;
}

const DEFAULT_FIND_LIMIT = 20;

/** Lowercase token normalization mirroring indexes.ts (spec §5.6 keys). */
function queryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens = new Set<string>([lower]);
  for (const part of query.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    for (const sub of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (sub) tokens.add(sub.toLowerCase());
    }
  }
  return [...tokens];
}

/**
 * Score a symbol index entry against the query. Exact (full-query) token match
 * scores highest; a prefix/substring match scores lower. Exported symbols and
 * components/hooks get a small boost (these are what agents most want to find).
 */
function scoreEntry(entry: SymbolIndexEntry, query: string): number {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  let score = 0;
  if (name === q) score += 10;
  else if (name.startsWith(q)) score += 6;
  else if (name.includes(q)) score += 3;
  else score += 1; // matched only via a sub-token bucket
  score *= entry.score_hint; // exported (1.0) vs internal (0.8)
  if (entry.subtype === 'component' || entry.subtype === 'hook') score += 1;
  return score;
}

function resolveRoot(ctx: QueryContext): string {
  if (ctx.projectRoot) return ctx.projectRoot;
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  return manifest?.project_root ?? ctx.cwd ?? process.cwd();
}

function maxParseBytes(ctx: QueryContext): number {
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  return manifest?.extractor_config.max_parse_file_bytes ?? 1024 * 1024;
}

function baseStatus(ctx: QueryContext): FreshnessStatus {
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  return manifest ? manifest.freshness.status : 'missing_index';
}

/** Gather candidate symbol entries from the symbols index for a query. */
function gatherSymbolEntries(index: SymbolsIndex, query: string): SymbolIndexEntry[] {
  const seen = new Set<string>();
  const out: SymbolIndexEntry[] = [];
  for (const token of queryTokens(query)) {
    const bucket = index.entries[token];
    if (!bucket) continue;
    for (const entry of bucket) {
      if (seen.has(entry.node_id)) continue;
      seen.add(entry.node_id);
      out.push(entry);
    }
  }
  return out;
}

export function find(query: string, limit: number | undefined, ctx: QueryContext): FindOutput {
  const base = baseStatus(ctx);
  const index = readSymbolsIndex(ctx.cwd, ctx.preferredDirName);
  if (!index) {
    return {
      query,
      matches: [],
      freshness_badge: { status: 'missing_index', details: { hint: 'run refresh' } },
    };
  }

  const root = resolveRoot(ctx);
  const maxBytes = maxParseBytes(ctx);
  const checker = makeLazyChecker();
  const acc = newAccumulator();

  const candidates = gatherSymbolEntries(index, query);
  const ranked: FindMatch[] = [];
  for (const entry of candidates) {
    // §6.1 — lazy validate before serving as confident.
    const confident = validateEntry(
      entry,
      checker,
      acc,
      root,
      maxBytes,
      ctx.cwd,
      ctx.preferredDirName,
    );
    if (!confident) continue;
    ranked.push({
      node_id: entry.node_id,
      name: entry.name,
      path: entry.path,
      file_id: entry.file_id,
      kind: entry.kind,
      subtype: entry.subtype ?? null,
      score: scoreEntry(entry, query),
    });
  }

  ranked.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
  const capped = ranked.slice(0, limit ?? DEFAULT_FIND_LIMIT);

  const badge = deriveBadge(base, acc, checker.exhausted, capped.length > 0, candidates.length === 0);
  return { query, matches: capped, freshness_badge: badge };
}

// --- related memory (spec §11) ---

export interface RelatedMemoryItem {
  id: string;
  /** entity kind: decision | trap | constraint | plan | ... */
  kind: string;
  text: string;
  tags: string[];
  related_paths: string[];
}

/**
 * Injectable read seam for brainclaw memory (spec §11). The default
 * implementation reads decisions/traps/constraints/plans via the canonical
 * entity read path; tests inject an in-memory reader to assert attachment
 * deterministically without standing up a full store.
 */
export type MemoryReader = (ctx: QueryContext) => RelatedMemoryItem[];

/** spec §11 — cap related memory at top 5 by relevance. */
export const RELATED_MEMORY_CAP = 5;

interface ScoredMemory {
  item: RelatedMemoryItem;
  score: number;
}

/**
 * Match memory items to a set of candidate file paths + the query symbol name
 * by (spec §11): related_paths, tags, or a literal file-path mention in the
 * memory text. Returns the top `RELATED_MEMORY_CAP` by relevance.
 */
export function attachRelatedMemory(
  items: RelatedMemoryItem[],
  paths: string[],
  symbolNames: string[],
): RelatedMemoryItem[] {
  const pathSet = new Set(paths.map((p) => p.replace(/\\/g, '/')));
  const baseNames = new Set(paths.map((p) => path.basename(p)));
  const symLower = new Set(symbolNames.map((s) => s.toLowerCase()));

  const scored: ScoredMemory[] = [];
  for (const item of items) {
    let score = 0;
    // related_paths — strongest signal.
    for (const rp of item.related_paths ?? []) {
      const norm = rp.replace(/\\/g, '/');
      if (pathSet.has(norm)) score += 5;
      else if (baseNames.has(path.basename(norm))) score += 3;
    }
    // literal file-path mention in the memory text.
    const text = item.text ?? '';
    for (const p of pathSet) {
      if (text.includes(p)) score += 2;
    }
    for (const bn of baseNames) {
      if (text.includes(bn)) score += 1;
    }
    // tags matching a symbol name (e.g. tag "App" / "useAuth").
    for (const tag of item.tags ?? []) {
      if (symLower.has(tag.toLowerCase())) score += 2;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, RELATED_MEMORY_CAP).map((s) => s.item);
}

// --- brief() (spec §9) ---

export interface BriefReadEntry {
  path: string;
  reason: string;
  score: number;
  related_memory_ids: string[];
}

export interface BriefOutput {
  target: string;
  suggested_files_to_read: BriefReadEntry[];
  related_memory: RelatedMemoryItem[];
  freshness_badge: FreshnessBadge;
}

/** spec §9 — the brief reading list is capped at 12 files. */
export const BRIEF_FILE_CAP = 12;

interface RankedFile {
  path: string;
  file_id: string;
  reason: string;
  score: number;
}

/**
 * Build the ranked suggested_files_to_read for a brief (spec §9).
 *
 * Relevance signals, highest first:
 *  - a file that DEFINES the matching symbol (from the symbols index)
 *  - files that import a module whose path/name relates, or are imported by it
 *  - files that share the directory of a defining file
 */
function rankFiles(
  defining: SymbolIndexEntry[],
  symbolsIndex: SymbolsIndex,
  importsIndex: ImportsIndex | null,
  query: string,
): RankedFile[] {
  const byPath = new Map<string, RankedFile>();
  const bump = (p: string, fileId: string, reason: string, delta: number): void => {
    const cur = byPath.get(p);
    if (cur) {
      cur.score += delta;
      // keep the strongest (first-set) reason; defining always wins because it
      // is bumped first with the largest delta.
    } else {
      byPath.set(p, { path: p, file_id: fileId, reason, score: delta });
    }
  };

  // 1. defining files — strongest.
  const definingDirs = new Set<string>();
  for (const entry of defining) {
    const subtypeNote = entry.subtype ? ` (${entry.subtype})` : '';
    bump(entry.path, entry.file_id, `defines matching symbol ${entry.name}${subtypeNote}`, 12);
    definingDirs.add(path.posix.dirname(entry.path.replace(/\\/g, '/')));
  }

  // 2. files that import the same module specifier as the symbol name, OR import
  //    a module that resolves (by basename) to a defining file. P0 keeps this
  //    cheap: match the query token against import module specifiers.
  if (importsIndex) {
    const qLower = query.toLowerCase();
    for (const [moduleSpec, entries] of Object.entries(importsIndex.entries)) {
      const specLower = moduleSpec.toLowerCase();
      const relevant =
        specLower.includes(qLower) ||
        [...definingDirs].some((d) => moduleSpec.includes(path.posix.basename(d)));
      if (!relevant) continue;
      for (const e of entries) {
        bump(e.path, e.file_id, `imports ${moduleSpec}`, 3);
      }
    }
  }

  // 3. files that share a directory with a defining file.
  if (definingDirs.size > 0) {
    for (const bucket of Object.values(symbolsIndex.entries)) {
      for (const entry of bucket) {
        const dir = path.posix.dirname(entry.path.replace(/\\/g, '/'));
        if (definingDirs.has(dir)) {
          bump(entry.path, entry.file_id, `shares directory with the matching symbol`, 1);
        }
      }
    }
  }

  return [...byPath.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  );
}

/** Find files whose path matches the target directly (path-target briefs). */
function filesMatchingPath(symbolsIndex: SymbolsIndex, target: string): SymbolIndexEntry[] {
  const norm = target.replace(/\\/g, '/');
  const seenPaths = new Set<string>();
  const out: SymbolIndexEntry[] = [];
  for (const bucket of Object.values(symbolsIndex.entries)) {
    for (const entry of bucket) {
      const p = entry.path.replace(/\\/g, '/');
      if ((p === norm || p.endsWith(`/${norm}`) || p.includes(norm)) && !seenPaths.has(entry.path)) {
        seenPaths.add(entry.path);
        out.push(entry);
      }
    }
  }
  return out;
}

export function brief(
  target: string,
  limit: number | undefined,
  ctx: QueryContext,
  memoryReader: MemoryReader,
): BriefOutput {
  const base = baseStatus(ctx);
  const symbolsIndex = readSymbolsIndex(ctx.cwd, ctx.preferredDirName);
  if (!symbolsIndex) {
    return {
      target,
      suggested_files_to_read: [],
      related_memory: [],
      freshness_badge: { status: 'missing_index', details: { hint: 'run refresh' } },
    };
  }
  const importsIndex = readImportsIndex(ctx.cwd, ctx.preferredDirName);

  // Resolve target -> defining symbol entries (symbol query first, then path).
  let defining = gatherSymbolEntries(symbolsIndex, target);
  if (defining.length === 0) defining = filesMatchingPath(symbolsIndex, target);

  const root = resolveRoot(ctx);
  const maxBytes = maxParseBytes(ctx);
  const checker = makeLazyChecker();
  const acc = newAccumulator();

  const ranked = rankFiles(defining, symbolsIndex, importsIndex, target);

  // §6.1 — lazy validate each suggested file; exclude deletions from the
  // confident list (still recorded in the badge).
  const confident: RankedFile[] = [];
  for (const rf of ranked) {
    const ok = validateEntry(
      { path: rf.path, file_id: rf.file_id },
      checker,
      acc,
      root,
      maxBytes,
      ctx.cwd,
      ctx.preferredDirName,
    );
    if (acc.missingPaths.has(rf.path)) continue; // deletion: exclude entirely.
    // stale_changed / unchecked still appear (with the badge flagging them) so
    // the agent knows the file exists but may be out of date.
    void ok;
    confident.push(rf);
  }

  const cap = Math.min(limit ?? BRIEF_FILE_CAP, BRIEF_FILE_CAP);
  const capped = confident.slice(0, cap);

  // Related memory (spec §11): match by the candidate paths + symbol names.
  const candidatePaths = capped.map((f) => f.path);
  const symbolNames = [...new Set(defining.map((e) => e.name))];
  if (symbolNames.length === 0) symbolNames.push(target);
  const memoryItems = memoryReader(ctx);
  const related = attachRelatedMemory(memoryItems, candidatePaths, symbolNames);

  // Attach matching memory ids per file (those whose related_paths/text name it).
  const suggested: BriefReadEntry[] = capped.map((f) => {
    const ids = related
      .filter((m) => {
        const fileNorm = f.path.replace(/\\/g, '/');
        const base2 = path.basename(fileNorm);
        const inPaths = (m.related_paths ?? []).some(
          (rp) => rp.replace(/\\/g, '/') === fileNorm || path.basename(rp) === base2,
        );
        const inText = (m.text ?? '').includes(fileNorm) || (m.text ?? '').includes(base2);
        return inPaths || inText;
      })
      .map((m) => m.id);
    return { path: f.path, reason: f.reason, score: f.score, related_memory_ids: ids };
  });

  const badge = deriveBadge(base, acc, checker.exhausted, capped.length > 0, ranked.length === 0);
  return {
    target,
    suggested_files_to_read: suggested,
    related_memory: related,
    freshness_badge: badge,
  };
}
