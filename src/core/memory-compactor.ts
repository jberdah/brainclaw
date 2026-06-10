/**
 * Memory compactor — semantic consolidation of near-duplicate and stale memory items.
 *
 * Scans constraints, decisions, and traps for similarity clusters using the Dice
 * coefficient, scores freshness, and proposes merges or archival.
 *
 * Three consumption modes:
 *   1. `analyzeMemory()` → dry-run report (clusters + stale items)
 *   2. `applyCompaction()` → execute merges, archive originals
 *   3. `suggestCompaction()` → lightweight hint for session_end
 *
 * Non-destructive: merged items are archived to JSONL, never deleted outright.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import type { State, Constraint, Decision, Trap } from './schema.js';
import { normalise, similarity } from './duplicates.js';
import { resolveEntityDir } from './io.js';
import { loadState, persistState } from './state.js';
import { mutate } from './mutation-pipeline.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryItemType = 'constraint' | 'decision' | 'trap';

export interface MemoryItem {
  id: string;
  text: string;
  created_at: string;
  tags: string[];
  type: MemoryItemType;
  related_paths?: string[];
}

export interface ClusterItem extends MemoryItem {
  /** Dice similarity to the cluster representative. */
  similarity: number;
}

export interface SimilarityCluster {
  type: MemoryItemType;
  items: ClusterItem[];
  /** Average pairwise similarity within the cluster. */
  avgSimilarity: number;
  /** ID of the item selected as merge target (most recent + longest text). */
  keepId: string;
}

export interface StaleItem extends MemoryItem {
  /** Confidence score: lower = more stale. */
  score: number;
  reason: string;
}

export interface CompactionReport {
  clusters: SimilarityCluster[];
  staleItems: StaleItem[];
  totalItems: number;
  /** Number of items that would be archived (cluster extras + stale). */
  archivableCount: number;
  /** Estimated reduction percentage. */
  estimatedReductionPct: number;
}

export interface CompactionResult {
  archivedCount: number;
  mergedClusters: number;
  staleArchived: number;
}

export interface CompactorOptions {
  cwd?: string;
  /** Dice similarity threshold to form clusters. Default: 0.55 */
  similarityThreshold?: number;
  /** Items older than this many days with no references score 0 freshness. Default: 180 */
  stalenessMaxDays?: number;
  /** Items below this confidence score are considered stale. Default: 0.20 */
  stalenessScoreThreshold?: number;
  /** Minimum cluster size to report. Default: 2 */
  minClusterSize?: number;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
const DEFAULT_STALENESS_MAX_DAYS = 180;
const DEFAULT_STALENESS_SCORE_THRESHOLD = 0.20;
const DEFAULT_MIN_CLUSTER_SIZE = 2;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze the full memory state and produce a compaction report.
 * Pure function — reads state, does not mutate.
 */
export function analyzeMemory(state: State, options: CompactorOptions = {}): CompactionReport {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const stalenessMaxDays = options.stalenessMaxDays ?? DEFAULT_STALENESS_MAX_DAYS;
  const stalenessScoreThreshold = options.stalenessScoreThreshold ?? DEFAULT_STALENESS_SCORE_THRESHOLD;
  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;

  // Flatten all memory items with their type tag
  const items = flattenMemoryItems(state);
  const totalItems = items.length;

  // Build a reference count index (how many times each ID is mentioned across all items)
  const refCounts = buildReferenceIndex(state);

  // Cluster by type
  const clusters: SimilarityCluster[] = [];
  for (const type of ['constraint', 'decision', 'trap'] as MemoryItemType[]) {
    const typed = items.filter(i => i.type === type);
    const typeClusters = findClusters(typed, threshold, minClusterSize);
    clusters.push(...typeClusters);
  }

  // Find stale items (not already in a cluster)
  const clusteredIds = new Set(clusters.flatMap(c => c.items.map(i => i.id)));
  const staleItems: StaleItem[] = [];

  for (const item of items) {
    if (clusteredIds.has(item.id)) continue;
    const score = computeStalenessScore(item, refCounts, stalenessMaxDays);
    if (score < stalenessScoreThreshold) {
      staleItems.push({
        ...item,
        score: Math.round(score * 100) / 100,
        reason: score === 0
          ? `older than ${stalenessMaxDays} days with no references`
          : `low confidence (freshness × reference density)`,
      });
    }
  }

  // Sort stale by score ascending (most stale first)
  staleItems.sort((a, b) => a.score - b.score);

  const archivableCount = clusters.reduce((n, c) => n + c.items.length - 1, 0) + staleItems.length;

  return {
    clusters,
    staleItems,
    totalItems,
    archivableCount,
    estimatedReductionPct: totalItems > 0 ? Math.round((archivableCount / totalItems) * 100) : 0,
  };
}

/**
 * Lightweight analysis returning only a short summary string,
 * suitable for embedding in session_end output.
 * Returns undefined if nothing actionable.
 */
export function suggestCompaction(state: State, options: CompactorOptions = {}): string | undefined {
  const report = analyzeMemory(state, options);
  if (report.clusters.length === 0 && report.staleItems.length === 0) return undefined;

  const parts: string[] = [];
  if (report.clusters.length > 0) {
    const totalDups = report.clusters.reduce((n, c) => n + c.items.length - 1, 0);
    parts.push(`${report.clusters.length} similar cluster(s) (${totalDups} mergeable items)`);
  }
  if (report.staleItems.length > 0) {
    parts.push(`${report.staleItems.length} stale item(s)`);
  }
  return `Memory compaction opportunity: ${parts.join(', ')}. Run \`brainclaw prune --semantic --dry-run\` for details.`;
}

// ---------------------------------------------------------------------------
// Apply compaction
// ---------------------------------------------------------------------------

/**
 * Analyze and apply compaction atomically under a single mutation lock.
 * This prevents race conditions where another agent modifies state between
 * analysis and application.
 */
export function analyzeAndApply(options: CompactorOptions = {}): { report: CompactionReport; result: CompactionResult } {
  const cwd = options.cwd ?? process.cwd();
  let report!: CompactionReport;
  let archivedCount = 0;
  let mergedClusters = 0;
  let staleArchived = 0;

  mutate({ cwd }, () => {
    const state = loadState(cwd);
    report = analyzeMemory(state, options);

    if (report.archivableCount === 0) return;

    const applied = applyReportToState(report, state, cwd);
    archivedCount = applied.archivedCount;
    mergedClusters = applied.mergedClusters;
    staleArchived = applied.staleArchived;

    // deleteMissing: archived items must have their live files unlinked; the RMW
    // is atomic (loadState above runs under this mutate() lock).
    persistState(state, cwd, { writeProjectMarkdown: false, deleteMissing: true });
  });

  return { report, result: { archivedCount, mergedClusters, staleArchived } };
}

/**
 * Apply a pre-computed compaction report. Re-validates that items still exist
 * in the current state before archiving, to handle concurrent modifications.
 * Runs inside the mutation lock.
 */
export function applyCompaction(
  report: CompactionReport,
  options: CompactorOptions = {},
): CompactionResult {
  const cwd = options.cwd ?? process.cwd();
  let archivedCount = 0;
  let mergedClusters = 0;
  let staleArchived = 0;

  mutate({ cwd }, () => {
    const state = loadState(cwd);
    const applied = applyReportToState(report, state, cwd);
    archivedCount = applied.archivedCount;
    mergedClusters = applied.mergedClusters;
    staleArchived = applied.staleArchived;
    persistState(state, cwd, { writeProjectMarkdown: false, deleteMissing: true });
  });

  return { archivedCount, mergedClusters, staleArchived };
}

/** Shared logic: apply report mutations to a loaded state. Validates items still exist. */
function applyReportToState(
  report: CompactionReport,
  state: State,
  cwd: string,
): CompactionResult {
  let archivedCount = 0;
  let mergedClusters = 0;
  let staleArchived = 0;

  for (const cluster of report.clusters) {
    // Validate keeper still exists in state — skip cluster if not
    const keeper = findInState(state, cluster.keepId, cluster.type);
    if (!keeper) continue;

    // Only archive items that still exist in current state
    const archiveIds = new Set(
      cluster.items
        .filter(i => i.id !== cluster.keepId && findInState(state, i.id, cluster.type))
        .map(i => i.id),
    );
    if (archiveIds.size === 0) continue;

    // Merge tags into keeper
    const allTags = new Set(keeper.tags);
    for (const item of cluster.items) {
      for (const tag of item.tags) allTags.add(tag);
    }
    keeper.tags = [...allTags];

    const entityName = entityNameForType(cluster.type);
    const archived = archiveItems(archiveIds, entityName, cwd);
    removeFromState(state, archiveIds, cluster.type);
    archivedCount += archived;
    mergedClusters++;
  }

  for (const stale of report.staleItems) {
    // Validate item still exists in current state
    if (!findInState(state, stale.id, stale.type)) continue;

    const entityName = entityNameForType(stale.type);
    const archived = archiveItems(new Set([stale.id]), entityName, cwd);
    removeFromState(state, new Set([stale.id]), stale.type);
    staleArchived += archived;
    archivedCount += archived;
  }

  return { archivedCount, mergedClusters, staleArchived };
}

// ---------------------------------------------------------------------------
// Clustering (union-find with Dice coefficient)
// ---------------------------------------------------------------------------

function findClusters(
  items: MemoryItem[],
  threshold: number,
  minSize: number,
): SimilarityCluster[] {
  if (items.length < 2) return [];

  // Normalise texts once
  const normalised = items.map(item => normalise(item.text));

  // Union-find structure
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  // Pairwise similarity — union items above threshold
  const pairSim: Map<string, number> = new Map();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = similarity(normalised[i]!, normalised[j]!);
      if (sim >= threshold) {
        union(i, j);
        pairSim.set(`${i}:${j}`, sim);
      }
    }
  }

  // Group by root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  // Build clusters from groups >= minSize
  const clusters: SimilarityCluster[] = [];
  for (const indices of groups.values()) {
    if (indices.length < minSize) continue;

    const type = items[indices[0]!]!.type;

    // Compute average pairwise similarity
    let simSum = 0;
    let simCount = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const key1 = `${Math.min(indices[a]!, indices[b]!)}:${Math.max(indices[a]!, indices[b]!)}`;
        simSum += pairSim.get(key1) ?? similarity(normalised[indices[a]!]!, normalised[indices[b]!]!);
        simCount++;
      }
    }
    const avgSimilarity = simCount > 0 ? Math.round((simSum / simCount) * 100) / 100 : 0;

    // Pick keeper: most recent, then longest text
    const sorted = [...indices].sort((a, b) => {
      const dateComp = items[b]!.created_at.localeCompare(items[a]!.created_at);
      if (dateComp !== 0) return dateComp;
      return items[b]!.text.length - items[a]!.text.length;
    });
    const keepIdx = sorted[0]!;
    const keepId = items[keepIdx]!.id;

    const clusterItems: ClusterItem[] = indices.map(idx => ({
      ...items[idx]!,
      similarity: idx === keepIdx ? 1.0 : (
        pairSim.get(`${Math.min(idx, keepIdx)}:${Math.max(idx, keepIdx)}`)
        ?? similarity(normalised[idx]!, normalised[keepIdx]!)
      ),
    }));

    // Sort: keeper first, then by similarity desc
    clusterItems.sort((a, b) => {
      if (a.id === keepId) return -1;
      if (b.id === keepId) return 1;
      return b.similarity - a.similarity;
    });

    clusters.push({ type, items: clusterItems, avgSimilarity, keepId });
  }

  // Sort clusters by size descending
  clusters.sort((a, b) => b.items.length - a.items.length);
  return clusters;
}

// ---------------------------------------------------------------------------
// Staleness scoring
// ---------------------------------------------------------------------------

function computeStalenessScore(
  item: MemoryItem,
  refCounts: Map<string, number>,
  maxDays: number,
): number {
  const ageMs = Date.now() - Date.parse(item.created_at);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const freshness = Math.max(0, 1 - ageDays / maxDays);
  const refs = refCounts.get(item.id) ?? 0;
  // Referenced items get a floor so they're never fully stale —
  // an actively referenced item is useful regardless of age.
  const effective = Math.max(freshness, refs > 0 ? 0.25 : 0);
  return effective * (1 + Math.log1p(refs));
}

/**
 * Build an index of how many times each item ID is referenced across
 * all plan_items (text + plan_id) and handoffs (text + plan_id + contract).
 */
function buildReferenceIndex(state: State): Map<string, number> {
  const counts = new Map<string, number>();
  const increment = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);

  // Collect all IDs we care about
  const allIds = new Set<string>();
  for (const c of state.active_constraints) allIds.add(c.id);
  for (const d of state.recent_decisions) allIds.add(d.id);
  for (const t of state.known_traps) allIds.add(t.id);

  // Scan plans for references (plans reference memory items by ID in their text)
  for (const plan of state.plan_items) {
    for (const id of allIds) {
      if (plan.text.includes(id)) increment(id);
    }
  }

  // Scan handoffs for references
  for (const handoff of state.open_handoffs) {
    for (const id of allIds) {
      if (handoff.text.includes(id)) increment(id);
      if (handoff.plan_id === id) increment(id);
    }
  }

  // Cross-references within memory items themselves
  const allItems = [
    ...state.active_constraints,
    ...state.recent_decisions,
    ...state.known_traps,
  ];
  for (const item of allItems) {
    for (const id of allIds) {
      if (id !== item.id && item.text.includes(id)) increment(id);
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenMemoryItems(state: State): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (const c of state.active_constraints) {
    items.push({ id: c.id, text: c.text, created_at: c.created_at, tags: c.tags, type: 'constraint', related_paths: c.related_paths });
  }
  for (const d of state.recent_decisions) {
    items.push({ id: d.id, text: d.text, created_at: d.created_at, tags: d.tags, type: 'decision', related_paths: d.related_paths });
  }
  for (const t of state.known_traps) {
    items.push({ id: t.id, text: t.text, created_at: t.created_at, tags: t.tags, type: 'trap', related_paths: t.related_paths });
  }
  return items;
}

function entityNameForType(type: MemoryItemType): string {
  switch (type) {
    case 'constraint': return 'constraints';
    case 'decision': return 'decisions';
    case 'trap': return 'traps';
  }
}

function findInState(state: State, id: string, type: MemoryItemType): (Constraint | Decision | Trap) | undefined {
  switch (type) {
    case 'constraint': return state.active_constraints.find(c => c.id === id);
    case 'decision': return state.recent_decisions.find(d => d.id === id);
    case 'trap': return state.known_traps.find(t => t.id === id);
  }
}

function removeFromState(state: State, ids: Set<string>, type: MemoryItemType): void {
  switch (type) {
    case 'constraint':
      state.active_constraints = state.active_constraints.filter(c => !ids.has(c.id));
      break;
    case 'decision':
      state.recent_decisions = state.recent_decisions.filter(d => !ids.has(d.id));
      break;
    case 'trap':
      state.known_traps = state.known_traps.filter(t => !ids.has(t.id));
      break;
  }
}

/**
 * Archive items by ID: read their JSON files, append to compacted.jsonl, delete originals.
 * Returns number of items archived.
 */
function archiveItems(ids: Set<string>, entityName: string, cwd: string): number {
  const dir = resolveEntityDir(entityName, cwd, 'read');
  const archivePath = path.join(resolveEntityDir(entityName, cwd, 'write'), 'compacted.jsonl');
  let archived = 0;

  for (const id of ids) {
    const filePath = path.join(dir, `${id}.json`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const item = JSON.parse(content) as Record<string, unknown>;
      item._compacted_at = new Date().toISOString();
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.appendFileSync(archivePath, JSON.stringify(item) + '\n', 'utf-8');
      fs.unlinkSync(filePath);
      archived++;
    } catch (err) {
      logger.debug(`Failed to archive ${entityName}/${id}:`, err);
    }
  }

  return archived;
}

// ---------------------------------------------------------------------------
// Report formatting (CLI output)
// ---------------------------------------------------------------------------

export function formatReport(report: CompactionReport): string {
  const lines: string[] = [];

  lines.push(`Memory compaction analysis — ${report.totalItems} items scanned\n`);

  if (report.clusters.length > 0) {
    lines.push(`Similar clusters (${report.clusters.length}):`);
    for (const cluster of report.clusters) {
      lines.push(`  Cluster (${cluster.items.length} ${cluster.type}s, avg similarity: ${cluster.avgSimilarity}):`);
      for (const item of cluster.items) {
        const marker = item.id === cluster.keepId ? 'KEEP' : 'archive';
        const preview = item.text.length > 80 ? item.text.slice(0, 77) + '...' : item.text;
        lines.push(`    [${marker}] ${item.id} (${item.created_at.slice(0, 10)}) ${preview}`);
      }
    }
    lines.push('');
  }

  if (report.staleItems.length > 0) {
    lines.push(`Stale items (${report.staleItems.length}):`);
    for (const item of report.staleItems) {
      const preview = item.text.length > 80 ? item.text.slice(0, 77) + '...' : item.text;
      lines.push(`  [${item.type}] ${item.id} (score: ${item.score}) ${preview}`);
      lines.push(`    → ${item.reason}`);
    }
    lines.push('');
  }

  if (report.archivableCount > 0) {
    lines.push(`Estimated reduction: ${report.archivableCount}/${report.totalItems} items (${report.estimatedReductionPct}%)`);
    lines.push(`Run \`brainclaw prune --semantic\` to apply.`);
  } else {
    lines.push('No compaction opportunities found.');
  }

  return lines.join('\n');
}
