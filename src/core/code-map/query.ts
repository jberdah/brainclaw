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
import { coarseFreshness } from './freshness.js';
import {
  readImportsIndex,
  readManifest,
  readResolutionIndex,
  readShard,
  readSymbolsIndex,
} from './store.js';
import type {
  FreshnessBadge,
  FreshnessStatus,
  ImportsIndex,
  ResolutionIndex,
  SymbolIndexEntry,
  SymbolsIndex,
} from './types.js';

// --- lazy read-path freshness budget (spec §6.1) ---

/** Default per-query lazy-check budget (spec §6.1). */
export const LAZY_BUDGET = {
  maxFilesChecked: 32,
  maxWallMs: 2500,
} as const;

export interface LazyChecker {
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
export function makeLazyChecker(
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
export interface FreshnessAccumulator {
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

export function newAccumulator(): FreshnessAccumulator {
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
  // pln#631 — memo key scoped by the store's cwd. Two collision hazards must both be
  // avoided when a shared checker spans a workspace: keying by PATH collides two
  // packages' same-named `src/index.ts`; keying by file_id ALONE collides when two
  // stores share a project_id (the `prj_${basename}` fallback, or a copied
  // `.brainclaw/config.yaml`) — file_id = sha256(project_id + rel_path), so a shared
  // id makes the file_id identical too (review F1). Scoping by the store's cwd (unique
  // per store) is collision-proof either way; single-store keeps cwd constant, so
  // behavior is identical to before.
  const memoKey = `${cwd ?? ''} ${entry.file_id}`;
  const cached = checker.memo.get(memoKey);
  if (cached !== undefined) return cached;

  const abs = path.join(projectRoot, entry.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    acc.missingPaths.add(entry.path); // §6.1.2 — deletion.
    checker.memo.set(memoKey, false);
    return false;
  }
  const shard = readShard(entry.file_id, cwd, preferredDirName);
  if (!shard) {
    // No backing shard to compare against — treat as unchecked, not confident.
    acc.uncheckedPaths.add(entry.path);
    checker.memo.set(memoKey, false);
    return false;
  }
  // §6.1.3 — cheap gate: mtime + size match => fresh for this read.
  if (stat.mtimeMs === shard.mtime_ms && stat.size === shard.size_bytes) {
    checker.memo.set(memoKey, true);
    return true;
  }
  // §6.1.4/§6.1.6 — gate tripped: hash only when within budget AND not oversized.
  // These are distinct reasons: an oversized file can never be hashed on the read
  // path (§6.1.4), whereas a budget-exhausted skip is what §6.1.6 maps to
  // `partial`. Keep them separable so the badge reason is accurate.
  if (stat.size > maxParseFileBytes) {
    acc.uncheckedPaths.add(entry.path); // structurally unverifiable, not budget.
    checker.memo.set(memoKey, false);
    return false;
  }
  if (budgetExhausted(checker)) {
    acc.uncheckedPaths.add(entry.path);
    acc.budgetSkippedPaths.add(entry.path);
    checker.memo.set(memoKey, false);
    return false;
  }
  checker.filesChecked++;
  let live: string;
  try {
    live = fs.readFileSync(abs, 'utf-8');
  } catch {
    acc.uncheckedPaths.add(entry.path);
    checker.memo.set(memoKey, false);
    return false;
  }
  if (hashContent(live) === shard.file_hash) {
    checker.memo.set(memoKey, true); // §6.1 — identical despite mtime touch.
    return true;
  }
  acc.staleChangedPaths.add(entry.path); // §6.1.5 — confirmed content change.
  checker.memo.set(memoKey, false);
  return false;
}

/**
 * pln#631 PR3 — validate a single file entry against a SPECIFIC store's live tree
 * (resolves that store's root + parse budget from its manifest). Lets the cross-package
 * scan lazy-validate importer rows from a sibling store and drop deleted/stale ones,
 * upholding the same "no silent stale graph hints" rule intra-package graph rows obey.
 * Shares the caller's checker (one budget) + records into the caller's acc.
 */
export function validateStoreEntry(
  entry: { path: string; file_id: string },
  checker: LazyChecker,
  acc: FreshnessAccumulator,
  cwd: string | undefined,
  preferredDirName: string | undefined,
): boolean {
  const manifest = readManifest(cwd, preferredDirName);
  const root = manifest?.project_root ?? cwd ?? process.cwd();
  const maxBytes = manifest?.extractor_config.max_parse_file_bytes ?? 1024 * 1024;
  return validateEntry(entry, checker, acc, root, maxBytes, cwd, preferredDirName);
}

/**
 * Derive the response freshness badge from the base manifest status + the
 * outcomes recorded during this query's lazy check (spec §6.1, §9).
 *
 * Precedence: an exhausted budget yields `partial`; otherwise any detected
 * change/deletion yields `stale_changed_files`; else the manifest base status.
 */
export function deriveBadge(
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
  // pln#593 #2 — distinguish INDEX freshness (manifest state) from THIS call's
  // read-path spot-check. When the call-level status diverges from the index
  // status (a budget-limited `partial`, or a per-file `stale_changed_files` over a
  // `fresh` index), surface the index status so an agent does not read
  // status()=fresh vs find()/brief()=partial as a contradiction: it's "index
  // <index_status>, this call's spot-check <status>".
  if (status !== base) details.index_status = base;
  void hadConfidentMatch;
  return { status, coarse: coarseFreshness(status), details };
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
 * pln#601 — normalize an identifier to a separator/case-INSENSITIVE canonical
 * form (strip `_`, `-`, `.`, camelCase boundaries collapse to nothing; lowercase).
 * `EntityRegistry`, `ENTITY_REGISTRY`, and `entity-registry` all → `entityregistry`.
 * Without this, `scoreEntry` compared raw-lowercased strings, so a Pascal-case
 * query `EntityRegistry` failed to exact/prefix/substring-match the snake_case
 * `ENTITY_REGISTRY` and dropped it to the sub-token floor (score 1) alongside 19
 * unrelated `*Registry` symbols — the Fable-audit "all results score 1 → the agent
 * re-greps" defect that undercuts the whole "stop grepping blind" value prop.
 */
function normIdent(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * pln#601 — a path that is a test/spec file (its symbols must not outrank the real
 * def, and it should not crowd source out of a brief). Recognizes conventions across
 * ALL supported languages (JS/TS + py/php/java/go/rust/c#/ruby/c/c++), so the
 * source-over-test bias actually works for the polyglot langs, not just JS/TS.
 * Exported for the classification regression tests.
 */
export function isTestPath(p: string): boolean {
  // Directory conventions (all langs): tests/, test/, __tests__/, spec(s)/ (Ruby
  // RSpec), __mocks__/. NOTE: a source dir literally named `spec/` (e.g. an OpenAPI
  // `spec/` folder) is an accepted false-positive — RSpec `spec/` is the commoner
  // meaning now that Ruby is supported, and path alone can't disambiguate.
  if (/(?:^|[\\/])(?:tests?|__tests__|specs?|__mocks__)[\\/]/i.test(p)) return true;
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return (
    // separator-suffixed: foo.test.ts, foo_test.go, foo-spec.js, foo_spec.rb, foo_test.py
    /[._-](?:test|spec)\.(?:[cm]?[jt]sx?|py|rb|go|php|java|cs|rs)$/i.test(base) ||
    // pytest / minitest prefix: test_foo.py, test_foo.rb
    /^test_.+\.(?:py|rb)$/i.test(base) ||
    // bare test/spec file: test.ts, spec.rb
    /^(?:test|spec)\.(?:[cm]?[jt]sx?|py|rb|go)$/i.test(base) ||
    // xUnit / JUnit PascalCase suffix: FooTest.cs, BarTests.cs, BazTest.java
    // (case-SENSITIVE capital T so `contest.cs` / `latest.cs` are not false hits)
    /Tests?\.(?:cs|java)$/.test(base)
  );
}

/**
 * Score a symbol index entry against the query. Matching is separator/case
 * INSENSITIVE (pln#601): an exact NORMALIZED match scores highest, then prefix,
 * then substring, then the sub-token floor. Exported symbols + components/hooks
 * get a small boost; test-file symbols are biased DOWN so a test helper never
 * outranks the real definition of the same name (the Fable-audit brief-noise
 * companion to the find defect). Exported for focused ranking tests.
 */
export function scoreEntry(entry: SymbolIndexEntry, query: string): number {
  const q = normIdent(query);
  const name = normIdent(entry.name);
  let score = 0;
  if (q.length === 0) score += 1;
  else if (name === q) score += 10;         // exact, style-insensitive
  else if (name.startsWith(q)) score += 6;  // prefix
  else if (name.includes(q)) score += 3;    // substring
  else score += 1;                          // matched only via a sub-token bucket
  score *= entry.score_hint; // exported (1.0) vs internal (0.8)
  if (entry.subtype === 'component' || entry.subtype === 'hook') score += 1;
  // pln#601 — source over test: a test/spec symbol of the same name must not
  // outrank the real definition (keeps find/brief pointing at source first).
  if (isTestPath(entry.path)) score *= 0.4;
  return score;
}

/**
 * Number of distinct indexed files that import a symbol (or its defining file).
 *
 * This is deliberately a tie-breaker, not a broad popularity boost: a precise
 * textual match must always beat a merely popular substring match. The symbol
 * and file reverse indexes can name the same importer, so count their UNION to
 * avoid giving named imports a double bonus over namespace/default imports.
 */
export function importCentrality(entry: SymbolIndexEntry, resolutionIndex: ResolutionIndex | null): number {
  if (!resolutionIndex) return 0;
  const importers = new Set<string>();
  for (const dep of resolutionIndex.dependents_by_symbol[entry.node_id] ?? []) importers.add(dep.path);
  for (const dep of resolutionIndex.dependents_by_file[entry.path] ?? []) importers.add(dep.path);
  return importers.size;
}

/** A test-only helper is a weak orientation point when a file has real exports too. */
function isTestHelperSymbol(name: string): boolean {
  const normalized = normIdent(name);
  return (
    name.startsWith('_') ||
    /(?:^|_)(?:test|tests|mock|stub|fixture|reset)(?:_|$)/i.test(name) ||
    normalized.includes('fortest') ||
    normalized.includes('fortests')
  );
}

/**
 * Pick one meaningful definition per file for the reading-list explanation.
 * A path brief resolves all symbols in that file; repeatedly adding +12 for
 * each one made the result's reason depend on index order, which could select
 * an internal `__reset…ForTests` helper ahead of the public entry point.
 */
function representativeDefinitions(defining: SymbolIndexEntry[]): SymbolIndexEntry[] {
  const byPath = new Map<string, SymbolIndexEntry>();
  const relevance = (entry: SymbolIndexEntry): number => {
    let score = entry.score_hint * 100; // public definitions before internals
    if (entry.subtype === 'component' || entry.subtype === 'hook') score += 2;
    if (isTestHelperSymbol(entry.name)) score -= 50;
    return score;
  };
  for (const entry of defining) {
    const previous = byPath.get(entry.path);
    if (
      !previous ||
      relevance(entry) > relevance(previous) ||
      (relevance(entry) === relevance(previous) && entry.name.localeCompare(previous.name) < 0)
    ) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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

/** Store-local find CORE result (pln#631) — pre-cap, pre-badge. */
export interface StoreFindResult {
  /** Confident matches, score-sorted (NOT capped). */
  matches: FindMatch[];
  /** This store's base manifest freshness status. */
  base: FreshnessStatus;
  /** False when the store has no symbols index (missing_index). */
  hasIndex: boolean;
  /** True when zero candidate symbols were gathered (drives the refresh hint). */
  emptyCandidates: boolean;
  /** The per-store lazy-check outcomes (for badge merging by the aggregator). */
  acc: FreshnessAccumulator;
}

/**
 * Store-local find CORE (pln#631): gather → lazy-validate → score → sort, with NO
 * cap and NO badge. Accepts an INJECTED checker + acc so a workspace aggregation can
 * share ONE lazy budget across stores (the checker's memo is file_id-keyed, unique
 * per store, so sharing never collides same-named files across packages). `find()`
 * wraps this with a fresh checker/acc + cap + badge for the unchanged single-store
 * path; `aggregate.ts` fans it out across stores with a shared checker.
 */
export function findInStore(
  query: string,
  ctx: QueryContext,
  checker: LazyChecker,
  acc: FreshnessAccumulator,
): StoreFindResult {
  const index = readSymbolsIndex(ctx.cwd, ctx.preferredDirName);
  if (!index) {
    return { matches: [], base: 'missing_index', hasIndex: false, emptyCandidates: true, acc };
  }
  const base = baseStatus(ctx);
  const root = resolveRoot(ctx);
  const maxBytes = maxParseBytes(ctx);

  const candidates = gatherSymbolEntries(index, query);
  const resolutionIndex = readResolutionIndex(ctx.cwd, ctx.preferredDirName);
  const ranked: Array<{ match: FindMatch; centrality: number }> = [];
  for (const entry of candidates) {
    // §6.1 — lazy validate before serving as confident.
    const confident = validateEntry(entry, checker, acc, root, maxBytes, ctx.cwd, ctx.preferredDirName);
    if (!confident) continue;
    ranked.push({
      match: {
        node_id: entry.node_id,
        name: entry.name,
        path: entry.path,
        file_id: entry.file_id,
        kind: entry.kind,
        subtype: entry.subtype ?? null,
        score: scoreEntry(entry, query),
      },
      centrality: importCentrality(entry, resolutionIndex),
    });
  }
  ranked.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      b.centrality - a.centrality ||
      a.match.path.localeCompare(b.match.path) ||
      a.match.name.localeCompare(b.match.name),
  );
  return { matches: ranked.map(({ match }) => match), base, hasIndex: true, emptyCandidates: candidates.length === 0, acc };
}

export function find(query: string, limit: number | undefined, ctx: QueryContext): FindOutput {
  const checker = makeLazyChecker();
  const acc = newAccumulator();
  const r = findInStore(query, ctx, checker, acc);
  if (!r.hasIndex) {
    return {
      query,
      matches: [],
      freshness_badge: { status: 'missing_index', coarse: 'missing', details: { hint: 'run refresh' } },
    };
  }
  const capped = r.matches.slice(0, limit ?? DEFAULT_FIND_LIMIT);
  const badge = deriveBadge(r.base, acc, checker.exhausted, capped.length > 0, r.emptyCandidates);
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
  /**
   * Renseigne quand `code_brief` a RACCOURCI le texte (pln#598 etape 3).
   *
   * Declare ici plutot que laisse implicite : un champ present a l'execution mais absent
   * du type est invisible a tout consommateur qui lit la definition — et c'est exactement
   * la classe de promesse silencieuse que ce meme plan cherche a supprimer ailleurs.
   */
  text_truncated?: boolean;
  /** Appel EXACT rendant le texte integral. Absent quand rien n'a ete tronque. */
  full_text_via?: { tool: string; args: Record<string, unknown> };
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

export interface RankedFile {
  path: string;
  file_id: string;
  reason: string;
  score: number;
  /** Strongest single signal delta seen (so the reason tracks the dominant signal). */
  bestDelta: number;
  /** True iff EVERY signal for this path is graph-derived (P1d): such a row is
   *  suppressed when it fails lazy validation (no silent stale graph hints). A path
   *  that is also a defining/heuristic/same-dir row is NOT graph-only → not suppressed. */
  graphDerived: boolean;
}

/** A graph-derived candidate (forward dependency or reverse dependent). */
export interface GraphRow {
  path: string;
  file_id: string;
  reason: string;
}

/**
 * Build the ranked suggested_files_to_read for a brief (spec §9; P1d graph signals).
 *
 * Relevance signals, highest first:
 *  - defining file of the matching symbol (+12)
 *  - reverse dependent — a file that imports the target (+5, blast radius; P1d)
 *  - forward dependency — a file the target imports, resolved (+4; P1d)
 *  - import-specifier heuristic (+3, weak fallback)
 *  - same directory as a defining file (+1)
 *
 * `bump` accumulates score but keeps the reason of the STRONGEST single signal
 * (Codex review) and tracks whether a path is graph-only. Each signal class bumps a
 * given path at most once (callers dedupe their rows), bounding score runaway.
 */
function rankFiles(
  defining: SymbolIndexEntry[],
  forwardRows: GraphRow[],
  reverseRows: GraphRow[],
  symbolsIndex: SymbolsIndex,
  importsIndex: ImportsIndex | null,
  query: string,
): RankedFile[] {
  const byPath = new Map<string, RankedFile>();
  const bump = (p: string, fileId: string, reason: string, delta: number, graph: boolean): void => {
    const cur = byPath.get(p);
    if (cur) {
      cur.score += delta;
      if (delta > cur.bestDelta) {
        cur.bestDelta = delta;
        cur.reason = reason;
      }
      cur.graphDerived = cur.graphDerived && graph; // graph-only iff every signal is graph
    } else {
      byPath.set(p, { path: p, file_id: fileId, reason, score: delta, bestDelta: delta, graphDerived: graph });
    }
  };

  // 1. defining files — strongest, non-graph.
  const definingDirs = new Set<string>();
  for (const entry of representativeDefinitions(defining)) {
    const subtypeNote = entry.subtype ? ` (${entry.subtype})` : '';
    bump(entry.path, entry.file_id, `defines matching symbol ${entry.name}${subtypeNote}`, 12, false);
    definingDirs.add(path.posix.dirname(entry.path.replace(/\\/g, '/')));
  }

  // 2. reverse dependents (P1d) — who imports the target = blast radius.
  for (const r of reverseRows) bump(r.path, r.file_id, r.reason, 5, true);

  // 3. forward dependencies (P1d) — files the target imports (resolved).
  for (const f of forwardRows) bump(f.path, f.file_id, f.reason, 4, true);

  // 4. import-specifier heuristic — weak fallback (kept; real graph rows outrank it).
  //    Dedup by path (a file is bumped ONCE even if it matches several specifiers /
  //    appears in several token buckets) so the weak signal can't accumulate.
  if (importsIndex) {
    const qLower = query.toLowerCase();
    const heuristicPaths = new Map<string, { fileId: string; reason: string }>();
    for (const [moduleSpec, entries] of Object.entries(importsIndex.entries)) {
      const specLower = moduleSpec.toLowerCase();
      const relevant =
        specLower.includes(qLower) ||
        [...definingDirs].some((d) => moduleSpec.includes(path.posix.basename(d)));
      if (!relevant) continue;
      for (const e of entries) {
        if (!heuristicPaths.has(e.path)) heuristicPaths.set(e.path, { fileId: e.file_id, reason: `imports ${moduleSpec}` });
      }
    }
    for (const [p, { fileId, reason }] of heuristicPaths) bump(p, fileId, reason, 3, false);
  }

  // 5. files that share a directory with a defining file — bumped ONCE per file
  //    (the symbols index repeats a file across every symbol AND every token bucket;
  //    without dedup a symbol-dense file would accumulate +1 dozens of times and bury
  //    the real graph signals).
  if (definingDirs.size > 0) {
    const sameDirPaths = new Map<string, string>(); // path -> file_id
    for (const bucket of Object.values(symbolsIndex.entries)) {
      for (const entry of bucket) {
        const dir = path.posix.dirname(entry.path.replace(/\\/g, '/'));
        if (definingDirs.has(dir) && !sameDirPaths.has(entry.path)) sameDirPaths.set(entry.path, entry.file_id);
      }
    }
    for (const [p, fid] of sameDirPaths) bump(p, fid, `shares directory with the matching symbol`, 1, false);
  }

  return [...byPath.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path),
  );
}

/**
 * pln#601 — reserve most of the §9 reading list for SOURCE files. On a symbol with
 * many test importers, the reverse-dependent test files (blast radius, +5 each) can
 * fill the entire {@link BRIEF_FILE_CAP} and crowd out the source files an agent needs
 * to understand the symbol — the Fable-audit brief-noise defect. At most `maxTest`
 * test files (~1/4 of the cap, min 2) are admitted UNLESS there aren't enough non-test
 * files to fill the cap, in which case the deferred tests backfill the empty slots so
 * the list is never artificially short. Defining files ARE the target and are never
 * counted as noise (a symbol legitimately defined in a test file still leads the list).
 * Input is pre-sorted by score; output preserves that order within each bucket.
 */
export function reserveSourceSlots(
  ranked: RankedFile[],
  cap: number,
  definingPaths: Set<string>,
): RankedFile[] {
  const maxTest = Math.max(2, Math.floor(cap / 4)); // e.g. 3 of 12
  const out: RankedFile[] = [];
  const overflowTests: RankedFile[] = [];
  let testsIncluded = 0;
  for (const rf of ranked) {
    if (out.length >= cap) break;
    const isNoise = isTestPath(rf.path) && !definingPaths.has(rf.path);
    if (isNoise && testsIncluded >= maxTest) {
      overflowTests.push(rf);
      continue;
    }
    out.push(rf);
    if (isNoise) testsIncluded++;
  }
  // Non-test ran out before the cap → backfill the empty slots with deferred tests.
  for (const rf of overflowTests) {
    if (out.length >= cap) break;
    out.push(rf);
  }
  return out;
}

/** Build a node-id → symbol index entry map (deduped; entries repeat across token buckets). */
function buildNodeIdIndex(symbolsIndex: SymbolsIndex): Map<string, SymbolIndexEntry> {
  const out = new Map<string, SymbolIndexEntry>();
  for (const bucket of Object.values(symbolsIndex.entries)) {
    for (const entry of bucket) if (!out.has(entry.node_id)) out.set(entry.node_id, entry);
  }
  return out;
}

/**
 * Forward dependencies of the target: files the defining symbols import. Read from
 * each (already-validated) defining shard's `imports_symbol` edges, mapped to the
 * target symbol's own index entry (path + file_id + name). Deduped by path. Reading
 * only confident defining shards is the graph-SOURCE freshness gate (Codex review):
 * a stale importer shard's edge list is not trusted.
 */
function forwardDeps(
  confidentDefiningFileIds: Map<string, string>, // path -> file_id of confident defining files
  nodeIndex: Map<string, SymbolIndexEntry>,
  cwd: string | undefined,
  preferredDirName: string | undefined,
): GraphRow[] {
  const byPath = new Map<string, GraphRow>();
  for (const fileId of new Set(confidentDefiningFileIds.values())) {
    const shard = readShard(fileId, cwd, preferredDirName);
    if (!shard) continue;
    for (const edge of shard.edges) {
      if (edge.kind !== 'imports_symbol') continue;
      const target = nodeIndex.get(edge.to);
      if (!target) continue;
      if (byPath.has(target.path)) continue;
      byPath.set(target.path, {
        path: target.path,
        file_id: target.file_id,
        reason: `imported by the matching symbol (resolved): ${target.name}`,
      });
    }
  }
  return [...byPath.values()];
}

/**
 * Reverse dependents of the target (blast radius), from the P1d resolution index:
 * files that import any defining file (`dependents_by_file`) or any defining symbol
 * (`dependents_by_symbol`). Deduped by importer path; the strongest-named reason wins.
 */
function reverseDeps(
  resolutionIndex: ResolutionIndex | null,
  definingPaths: Set<string>,
  definingByNodeId: Map<string, SymbolIndexEntry>,
): GraphRow[] {
  if (!resolutionIndex) return [];
  const byPath = new Map<string, GraphRow>();
  const add = (importerPath: string, fileId: string, reason: string): void => {
    if (!byPath.has(importerPath)) byPath.set(importerPath, { path: importerPath, file_id: fileId, reason });
  };
  // by symbol — more precise (names the symbol).
  for (const [nodeId, entry] of definingByNodeId) {
    for (const dep of resolutionIndex.dependents_by_symbol[nodeId] ?? []) {
      add(dep.path, dep.file_id, `imports the matching symbol ${entry.name}`);
    }
  }
  // by file — covers default/namespace imports + path-target briefs.
  for (const p of definingPaths) {
    const base = path.posix.basename(p.replace(/\\/g, '/'));
    for (const dep of resolutionIndex.dependents_by_file[p] ?? []) {
      add(dep.path, dep.file_id, `imports ${base}`);
    }
  }
  return [...byPath.values()];
}

/**
 * Heuristic: does the brief target denote a file PATH rather than a bare symbol
 * name? A path separator or a supported source extension marks a path target —
 * for which we resolve the exact file directly instead of fuzzy-tokenizing the
 * name. Fuzzy-tokenizing a path floods the brief with unrelated same-token symbols
 * (e.g. brief('src/commands/switch.ts') pulling in every `switch`-named symbol and
 * code-map test). pln#593 1b.
 */
function looksLikePathTarget(target: string): boolean {
  return /[\\/]/.test(target) || /\.(?:ts|tsx|js|jsx|mjs|cjs|py|php|java)$/i.test(target);
}

/** Find files whose path matches the target directly (path-target briefs). */
function filesMatchingPath(symbolsIndex: SymbolsIndex, target: string): SymbolIndexEntry[] {
  const norm = target.replace(/\\/g, '/');
  // Keep every symbol in the matching file. `rankFiles()` selects the one
  // meaningful representative for the reason; deduping by path here used to
  // retain whichever token bucket happened to be visited first (often an
  // internal `__reset…ForTests` helper) and discarded the public entry point.
  const seenNodeIds = new Set<string>();
  const out: SymbolIndexEntry[] = [];
  for (const bucket of Object.values(symbolsIndex.entries)) {
    for (const entry of bucket) {
      const p = entry.path.replace(/\\/g, '/');
      if ((p === norm || p.endsWith(`/${norm}`) || p.includes(norm)) && !seenNodeIds.has(entry.node_id)) {
        seenNodeIds.add(entry.node_id);
        out.push(entry);
      }
    }
  }
  return out;
}

/** How a brief resolved its target within a store (drives cross-store selection). */
export type BriefMatchKind = 'exact' | 'path' | 'fuzzy' | 'none';

/** Store-local brief CORE result (pln#631 PR2) — pre-cap, pre-badge, pre-memory. */
export interface StoreBriefResult {
  /** Defining symbol entries for the target in this store. */
  defining: SymbolIndexEntry[];
  definingPaths: Set<string>;
  /** How the target resolved here — an aggregation prefers exact/path over fuzzy. */
  matchKind: BriefMatchKind;
  /** Confident ranked reading list (NOT capped). */
  confident: RankedFile[];
  base: FreshnessStatus;
  hasIndex: boolean;
  /** True when rankFiles produced nothing (drives the deriveBadge empty hint). */
  emptyRanked: boolean;
  acc: FreshnessAccumulator;
}

/**
 * Store-local brief CORE (pln#631 PR2): resolve the target → graph signals →
 * rankFiles → confident list, with NO cap, NO badge, NO related-memory attach.
 * Accepts an INJECTED checker + acc so a workspace aggregation can share ONE lazy
 * budget across stores (memo is cwd-scoped, so sharing is collision-safe). `brief()`
 * wraps this with a fresh checker/acc + reserve + memory + badge for the unchanged
 * single-store path; `aggregate.ts` fans it out and merges target-defining stores.
 */
export function briefInStore(
  target: string,
  ctx: QueryContext,
  checker: LazyChecker,
  acc: FreshnessAccumulator,
): StoreBriefResult {
  const symbolsIndex = readSymbolsIndex(ctx.cwd, ctx.preferredDirName);
  if (!symbolsIndex) {
    return {
      defining: [],
      definingPaths: new Set(),
      matchKind: 'none',
      confident: [],
      base: 'missing_index',
      hasIndex: false,
      emptyRanked: true,
      acc,
    };
  }
  const base = baseStatus(ctx);
  const importsIndex = readImportsIndex(ctx.cwd, ctx.preferredDirName);
  const resolutionIndex = readResolutionIndex(ctx.cwd, ctx.preferredDirName);

  // Resolve target -> defining symbol entries. A brief orients on a SPECIFIC target,
  // so prefer EXACT name matches when present — otherwise the token index floods the
  // result with unrelated same-token symbols. Fall back to the fuzzy token set, then
  // a path match. `matchKind` records which path won so an aggregation can prefer the
  // stores that actually DEFINE the target over stores that only fuzzy-match a token.
  let defining: SymbolIndexEntry[];
  let matchKind: BriefMatchKind;
  if (looksLikePathTarget(target)) {
    defining = filesMatchingPath(symbolsIndex, target);
    if (defining.length > 0) matchKind = 'path';
    else {
      defining = gatherSymbolEntries(symbolsIndex, target);
      matchKind = defining.length > 0 ? 'fuzzy' : 'none';
    }
  } else {
    defining = gatherSymbolEntries(symbolsIndex, target);
    const exact = defining.filter((e) => e.name.toLowerCase() === target.toLowerCase());
    if (exact.length > 0) {
      defining = exact;
      matchKind = 'exact';
    } else if (defining.length > 0) {
      matchKind = 'fuzzy';
    } else {
      defining = filesMatchingPath(symbolsIndex, target);
      matchKind = defining.length > 0 ? 'path' : 'none';
    }
  }

  const root = resolveRoot(ctx);
  const maxBytes = maxParseBytes(ctx);

  const definingPaths = new Set(defining.map((e) => e.path));
  const definingByNodeId = new Map(defining.map((e) => [e.node_id, e] as const));
  const confidentDefiningFileIds = new Map<string, string>();
  for (const e of defining) {
    if (confidentDefiningFileIds.has(e.path)) continue;
    const ok = validateEntry(
      { path: e.path, file_id: e.file_id }, checker, acc, root, maxBytes, ctx.cwd, ctx.preferredDirName,
    );
    if (ok) confidentDefiningFileIds.set(e.path, e.file_id);
  }
  const nodeIndex = buildNodeIdIndex(symbolsIndex);
  const fwd = forwardDeps(confidentDefiningFileIds, nodeIndex, ctx.cwd, ctx.preferredDirName);
  const rev = reverseDeps(resolutionIndex, definingPaths, definingByNodeId);

  const ranked = rankFiles(defining, fwd, rev, symbolsIndex, importsIndex, target);

  // §6.1 — lazy validate each suggested file; exclude deletions; suppress a graph-only
  // row that fails validation (no silent stale graph hints).
  const confident: RankedFile[] = [];
  for (const rf of ranked) {
    const ok = validateEntry(
      { path: rf.path, file_id: rf.file_id }, checker, acc, root, maxBytes, ctx.cwd, ctx.preferredDirName,
    );
    if (acc.missingPaths.has(rf.path)) continue;
    if (rf.graphDerived && !ok) continue;
    confident.push(rf);
  }

  return { defining, definingPaths, matchKind, confident, base, hasIndex: true, emptyRanked: ranked.length === 0, acc };
}

/**
 * Attach related-memory ids per reading-list entry (spec §11). Shared by the
 * single-store brief() and the workspace aggregation so both surface memory identically.
 */
export function attachMemoryIds(
  capped: Array<{ path: string; reason: string; score: number }>,
  related: RelatedMemoryItem[],
): BriefReadEntry[] {
  return capped.map((f) => {
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
}

export function brief(
  target: string,
  limit: number | undefined,
  ctx: QueryContext,
  memoryReader: MemoryReader,
): BriefOutput {
  const checker = makeLazyChecker();
  const acc = newAccumulator();
  const r = briefInStore(target, ctx, checker, acc);
  if (!r.hasIndex) {
    return {
      target,
      suggested_files_to_read: [],
      related_memory: [],
      freshness_badge: { status: 'missing_index', coarse: 'missing', details: { hint: 'run refresh' } },
    };
  }

  const cap = Math.min(limit ?? BRIEF_FILE_CAP, BRIEF_FILE_CAP);
  // pln#601 — reserve source slots so test importers can't crowd out source files.
  const capped = reserveSourceSlots(r.confident, cap, r.definingPaths);

  // Related memory (spec §11): match by the candidate paths + symbol names.
  const candidatePaths = capped.map((f) => f.path);
  const symbolNames = [...new Set(r.defining.map((e) => e.name))];
  if (symbolNames.length === 0) symbolNames.push(target);
  const related = attachRelatedMemory(memoryReader(ctx), candidatePaths, symbolNames);
  const suggested = attachMemoryIds(capped, related);

  const badge = deriveBadge(r.base, acc, checker.exhausted, capped.length > 0, r.emptyRanked);
  return { target, suggested_files_to_read: suggested, related_memory: related, freshness_badge: badge };
}
