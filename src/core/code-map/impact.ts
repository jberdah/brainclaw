/**
 * Bounded, explainable Code Map impact analysis.
 *
 * This module deliberately traverses only the persisted P1c resolution graph
 * through P1d's reverse ResolutionIndex. It neither reparses files nor infers
 * import edges from a naming convention. Naming is limited to a clearly marked,
 * low-confidence test suggestion after resolved test imports have been reported.
 */
import path from 'node:path';
import { fileId } from './ids.js';
import {
  readManifest,
  readResolutionIndex,
  readShard,
  readSymbolsIndex,
} from './store.js';
import {
  deriveBadge,
  isTestPath,
  makeLazyChecker,
  newAccumulator,
  validateStoreEntry,
  type QueryContext,
} from './query.js';
import type {
  DependencyIndexEntry,
  DependencyReason,
  FreshnessBadge,
  Span,
  SymbolIndexEntry,
  SymbolsIndex,
} from './types.js';

/** Direct results and each optional transitive layer are independently bounded. */
export const IMPACT_DEPENDENT_CAP = 100;
/** A depth of one is direct only; transitives require an explicit depth of two or more. */
export const IMPACT_MAX_DEPTH = 4;
export const IMPACT_NAMING_SUGGESTION_CONFIDENCE = 0.25;

export interface CodeImpactDefinition {
  node_id: string;
  name: string;
  kind: 'symbol' | 'file';
  subtype: string | null;
  path: string;
  file_id: string;
  span: Span | null;
  confidence: number;
}

export interface CodeImpactCause {
  /** Existing P1c edge kind; never a guessed edge. */
  kind: 'resolves_to' | 'imports_symbol';
  module?: string;
  imported: string[];
  confidence?: number;
  source_line?: number | null;
  /** The immediate target that this importer resolves to. */
  target: {
    kind: 'file' | 'symbol';
    path: string;
    node_id?: string;
    name?: string;
  };
}

export interface CodeImpactDependent {
  path: string;
  file_id: string;
  /** Graph distance from the requested definition: direct=1, transitive>=2. */
  depth: number;
  /** Every resolved edge that establishes this relationship. */
  causes: CodeImpactCause[];
}

export interface CodeImpactTest {
  path: string;
  file_id: string;
  /** Confirmed results come from a resolved edge; suggestions only use filename convention. */
  relation: 'resolved_import' | 'naming_convention_suggestion';
  confidence: number;
  depth?: number;
  causes?: CodeImpactCause[];
  reason: string;
}

export interface CodeImpactRisk {
  /** Count-based score, not a heuristic: direct dependents + returned transitives. */
  score: number;
  formula: 'direct_dependents + transitive_dependents';
  counters: {
    definitions: number;
    direct_dependents: number;
    transitive_dependents: number;
    resolved_test_files: number;
    suggested_test_files: number;
    max_depth_returned: number;
  };
}

export interface CodeImpactOutput {
  target: string;
  definition: {
    match_kind: 'exact' | 'path' | 'fuzzy' | 'none';
    entries: CodeImpactDefinition[];
  };
  direct_dependents: CodeImpactDependent[];
  transitive_dependents: CodeImpactDependent[];
  tests_for: CodeImpactTest[];
  risk: CodeImpactRisk;
  limits: {
    max_depth: number;
    max_dependents_per_section: number;
    direct_truncated: boolean;
    transitive_truncated: boolean;
  };
  freshness_badge: FreshnessBadge;
}

interface InternalDependent extends CodeImpactDependent {
  causeKeys: Set<string>;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function looksLikePathTarget(target: string): boolean {
  return /[\\/]/.test(target) || /\.(?:[cm]?[jt]sx?|py|php|java|go|rs|cs|rb|c|cc|cpp|cxx|h|hpp)$/i.test(target);
}

function normalizePathTarget(target: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.replace(/\\/g, '/');
}

function entriesForToken(index: SymbolsIndex, target: string): SymbolIndexEntry[] {
  const normalizedTarget = normalizeIdentifier(target);
  if (!normalizedTarget) return [];
  const seen = new Set<string>();
  const candidates: SymbolIndexEntry[] = [];
  for (const entries of Object.values(index.entries)) {
    for (const entry of entries) {
      if (seen.has(entry.node_id)) continue;
      const normalizedName = normalizeIdentifier(entry.name);
      if (normalizedName === normalizedTarget || normalizedName.includes(normalizedTarget)) {
        seen.add(entry.node_id);
        candidates.push(entry);
      }
    }
  }
  const exact = candidates.filter((entry) => normalizeIdentifier(entry.name) === normalizedTarget);
  return (exact.length > 0 ? exact : candidates).sort((a, b) =>
    a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.node_id.localeCompare(b.node_id),
  );
}

function entriesForPath(index: SymbolsIndex, target: string): SymbolIndexEntry[] {
  const normalizedTarget = target.replace(/\\/g, '/');
  const seen = new Set<string>();
  const entries: SymbolIndexEntry[] = [];
  for (const bucket of Object.values(index.entries)) {
    for (const entry of bucket) {
      const candidatePath = entry.path.replace(/\\/g, '/');
      if ((candidatePath === normalizedTarget || candidatePath.endsWith(`/${normalizedTarget}`)) && !seen.has(entry.node_id)) {
        seen.add(entry.node_id);
        entries.push(entry);
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

function asDefinition(entry: SymbolIndexEntry): CodeImpactDefinition {
  return {
    node_id: entry.node_id,
    name: entry.name,
    kind: 'symbol',
    subtype: entry.subtype ?? null,
    path: entry.path,
    file_id: entry.file_id,
    span: null,
    confidence: entry.score_hint,
  };
}

function fallbackReasons(entry: DependencyIndexEntry, kind: CodeImpactCause['kind']): DependencyReason[] {
  const indexed = entry.reasons.filter((reason) => reason.kind === kind);
  if (indexed.length > 0) return indexed;
  // Existing P1d indexes (written before P3) still have a compact aggregate.
  // Preserve their factual resolution evidence rather than manufacturing a guess.
  return [{
    kind,
    ...(entry.module ? { module: entry.module } : {}),
    imported: entry.imported,
    ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
  }];
}

function causeKey(cause: CodeImpactCause): string {
  return [
    cause.kind,
    cause.module ?? '',
    cause.imported.join('\u0000'),
    String(cause.confidence ?? ''),
    String(cause.source_line ?? ''),
    cause.target.kind,
    cause.target.path,
    cause.target.node_id ?? '',
  ].join('\u0001');
}

function compareCause(a: CodeImpactCause, b: CodeImpactCause): number {
  return a.kind.localeCompare(b.kind)
    || a.target.path.localeCompare(b.target.path)
    || (a.target.node_id ?? '').localeCompare(b.target.node_id ?? '')
    || (a.module ?? '').localeCompare(b.module ?? '')
    || (a.source_line ?? -1) - (b.source_line ?? -1)
    || a.imported.join('\u0000').localeCompare(b.imported.join('\u0000'))
    || (a.confidence ?? -1) - (b.confidence ?? -1);
}

function addRelation(
  rows: Map<string, InternalDependent>,
  entry: DependencyIndexEntry,
  depth: number,
  target: CodeImpactCause['target'],
  kind: CodeImpactCause['kind'],
): void {
  const current = rows.get(entry.path) ?? {
    path: entry.path,
    file_id: entry.file_id,
    depth,
    causes: [],
    causeKeys: new Set<string>(),
  };
  current.depth = Math.min(current.depth, depth);
  for (const reason of fallbackReasons(entry, kind)) {
    const cause: CodeImpactCause = {
      kind: reason.kind,
      ...(reason.module ? { module: reason.module } : {}),
      imported: [...reason.imported],
      ...(typeof reason.confidence === 'number' ? { confidence: reason.confidence } : {}),
      ...(reason.source_line !== undefined ? { source_line: reason.source_line } : {}),
      target,
    };
    const key = causeKey(cause);
    if (!current.causeKeys.has(key)) {
      current.causeKeys.add(key);
      current.causes.push(cause);
    }
  }
  current.causes.sort(compareCause);
  rows.set(entry.path, current);
}

function publicRelation(row: InternalDependent): CodeImpactDependent {
  return {
    path: row.path,
    file_id: row.file_id,
    depth: row.depth,
    causes: row.causes,
  };
}

function relationConfidence(row: CodeImpactDependent): number {
  return row.causes.reduce((best, cause) => Math.max(best, cause.confidence ?? 0), 0);
}

function testStem(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  return normalizeIdentifier(base
    .replace(/\.[^.]+$/, '')
    .replace(/(?:[._-](?:test|spec)|(?:test|spec)s?)$/i, '')
    .replace(/^(?:test|spec)[_-]/i, ''));
}

function clampDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) return 1;
  return Math.min(Math.max(Math.floor(depth), 1), IMPACT_MAX_DEPTH);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return IMPACT_DEPENDENT_CAP;
  return Math.min(Math.max(Math.floor(limit), 0), IMPACT_DEPENDENT_CAP);
}

/**
 * Read a bounded blast radius from existing resolved imports. A direct relation
 * is distance 1. Supplying depth=2 (or more) opts into transitively importing
 * files; depth is clamped to {@link IMPACT_MAX_DEPTH}.
 */
export function impact(
  target: string,
  options: { depth?: number; limit?: number } | undefined,
  ctx: QueryContext,
): CodeImpactOutput {
  const symbolsIndex = readSymbolsIndex(ctx.cwd, ctx.preferredDirName);
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  const maxDepth = clampDepth(options?.depth);
  const limit = clampLimit(options?.limit);
  const checker = makeLazyChecker();
  const acc = newAccumulator();
  const empty = (freshness: FreshnessBadge): CodeImpactOutput => ({
    target,
    definition: { match_kind: 'none', entries: [] },
    direct_dependents: [],
    transitive_dependents: [],
    tests_for: [],
    risk: {
      score: 0,
      formula: 'direct_dependents + transitive_dependents',
      counters: {
        definitions: 0,
        direct_dependents: 0,
        transitive_dependents: 0,
        resolved_test_files: 0,
        suggested_test_files: 0,
        max_depth_returned: 0,
      },
    },
    limits: {
      max_depth: maxDepth,
      max_dependents_per_section: limit,
      direct_truncated: false,
      transitive_truncated: false,
    },
    freshness_badge: freshness,
  });
  if (!symbolsIndex || !manifest) {
    return empty({ status: 'missing_index', coarse: 'missing', details: { hint: 'run refresh' } });
  }

  let matchKind: CodeImpactOutput['definition']['match_kind'] = 'none';
  let rawDefinitions: CodeImpactDefinition[] = [];
  if (looksLikePathTarget(target)) {
    const safePath = normalizePathTarget(target, manifest.project_root);
    if (safePath) {
      const symbols = entriesForPath(symbolsIndex, safePath);
      rawDefinitions = symbols.map(asDefinition);
      if (rawDefinitions.length > 0) {
        matchKind = 'path';
      } else {
        const shard = readShard(fileId(manifest.project_id, safePath), ctx.cwd, ctx.preferredDirName);
        const fileNode = shard?.nodes.find((node) => node.kind === 'file');
        if (shard && fileNode) {
          rawDefinitions = [{
            node_id: fileNode.id,
            name: fileNode.name,
            kind: 'file',
            subtype: null,
            path: shard.path,
            file_id: shard.file_id,
            span: null,
            confidence: fileNode.confidence,
          }];
          matchKind = 'path';
        }
      }
    }
  } else {
    const symbols = entriesForToken(symbolsIndex, target);
    rawDefinitions = symbols.map(asDefinition);
    if (rawDefinitions.length > 0) {
      matchKind = rawDefinitions.every((entry) => normalizeIdentifier(entry.name) === normalizeIdentifier(target)) ? 'exact' : 'fuzzy';
    }
  }

  const definitions = rawDefinitions
    .filter((entry) => validateStoreEntry(
      { path: entry.path, file_id: entry.file_id }, checker, acc, ctx.cwd, ctx.preferredDirName,
    ))
    .map((entry) => {
      // SymbolIndexEntry intentionally stores only a ranking hint. The shard is
      // the authoritative persisted source for the definition span/confidence.
      const node = readShard(entry.file_id, ctx.cwd, ctx.preferredDirName)?.nodes.find((candidate) => candidate.id === entry.node_id);
      return node ? { ...entry, span: node.span ?? null, confidence: node.confidence } : entry;
    });
  const definitionByNodeId = new Map(definitions.filter((entry) => entry.kind === 'symbol').map((entry) => [entry.node_id, entry]));
  const definitionPaths = new Set(definitions.map((entry) => entry.path));
  const resolution = readResolutionIndex(ctx.cwd, ctx.preferredDirName);
  const directRows = new Map<string, InternalDependent>();
  if (resolution) {
    for (const definition of definitionByNodeId.values()) {
      for (const dependent of resolution.dependents_by_symbol[definition.node_id] ?? []) {
        addRelation(directRows, dependent, 1, {
          kind: 'symbol', path: definition.path, node_id: definition.node_id, name: definition.name,
        }, 'imports_symbol');
      }
    }
    for (const definitionPath of definitionPaths) {
      for (const dependent of resolution.dependents_by_file[definitionPath] ?? []) {
        addRelation(directRows, dependent, 1, { kind: 'file', path: definitionPath }, 'resolves_to');
      }
    }
  }

  const sortedDirect = [...directRows.values()].sort((a, b) => a.path.localeCompare(b.path));
  const directCandidates = sortedDirect.slice(0, limit);
  const direct = directCandidates
    .filter((row) => validateStoreEntry(row, checker, acc, ctx.cwd, ctx.preferredDirName))
    .map(publicRelation);

  const transitive: CodeImpactDependent[] = [];
  let transitiveTruncated = false;
  if (resolution && maxDepth > 1 && limit > 0) {
    const visited = new Set<string>([...definitionPaths, ...direct.map((row) => row.path)]);
    const queue = direct.map((row) => ({ path: row.path, depth: 1 }));
    for (let offset = 0; offset < queue.length; offset++) {
      const current = queue[offset]!;
      if (current.depth >= maxDepth) continue;
      for (const dependent of resolution.dependents_by_file[current.path] ?? []) {
        if (visited.has(dependent.path)) continue;
        visited.add(dependent.path);
        if (transitive.length >= limit) {
          transitiveTruncated = true;
          continue;
        }
        const rowMap = new Map<string, InternalDependent>();
        addRelation(rowMap, dependent, current.depth + 1, { kind: 'file', path: current.path }, 'resolves_to');
        const row = rowMap.get(dependent.path)!;
        if (!validateStoreEntry(row, checker, acc, ctx.cwd, ctx.preferredDirName)) continue;
        const output = publicRelation(row);
        transitive.push(output);
        queue.push({ path: output.path, depth: output.depth });
      }
    }
  }
  transitive.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  const confirmedTests = [...direct, ...transitive]
    .filter((row) => isTestPath(row.path))
    .map((row) => ({
      path: row.path,
      file_id: row.file_id,
      relation: 'resolved_import' as const,
      confidence: relationConfidence(row),
      depth: row.depth,
      causes: row.causes,
      reason: `resolved import at graph depth ${row.depth}`,
    }));
  const confirmedPaths = new Set(confirmedTests.map((test) => test.path));
  const targetNames = new Set([
    ...definitions.map((definition) => normalizeIdentifier(definition.name)),
    ...definitions.map((definition) => testStem(definition.path)),
  ].filter(Boolean));
  const suggestions = new Map<string, CodeImpactTest>();
  if (targetNames.size > 0) {
    const seenFiles = new Map<string, string>();
    for (const entries of Object.values(symbolsIndex.entries)) {
      for (const entry of entries) if (!seenFiles.has(entry.path)) seenFiles.set(entry.path, entry.file_id);
    }
    for (const [testPath, testFileId] of seenFiles) {
      if (suggestions.size >= limit || confirmedPaths.has(testPath) || !isTestPath(testPath)) continue;
      if (!targetNames.has(testStem(testPath))) continue;
      if (!validateStoreEntry({ path: testPath, file_id: testFileId }, checker, acc, ctx.cwd, ctx.preferredDirName)) continue;
      suggestions.set(testPath, {
        path: testPath,
        file_id: testFileId,
        relation: 'naming_convention_suggestion',
        confidence: IMPACT_NAMING_SUGGESTION_CONFIDENCE,
        reason: 'filename convention matches the target; no resolved import proves this relationship',
      });
    }
  }
  const testsFor = [...confirmedTests, ...suggestions.values()].sort((a, b) =>
    a.relation.localeCompare(b.relation) || a.path.localeCompare(b.path),
  );
  const maxDepthReturned = Math.max(0, ...direct.map((row) => row.depth), ...transitive.map((row) => row.depth));
  const risk: CodeImpactRisk = {
    score: direct.length + transitive.length,
    formula: 'direct_dependents + transitive_dependents',
    counters: {
      definitions: definitions.length,
      direct_dependents: direct.length,
      transitive_dependents: transitive.length,
      resolved_test_files: confirmedTests.length,
      suggested_test_files: suggestions.size,
      max_depth_returned: maxDepthReturned,
    },
  };
  const freshnessBadge = deriveBadge(
    manifest.freshness.status,
    acc,
    checker.exhausted,
    definitions.length > 0 || direct.length > 0 || transitive.length > 0,
    definitions.length === 0,
  );
  return {
    target,
    definition: { match_kind: definitions.length > 0 ? matchKind : 'none', entries: definitions },
    direct_dependents: direct,
    transitive_dependents: transitive,
    tests_for: testsFor,
    risk,
    limits: {
      max_depth: maxDepth,
      max_dependents_per_section: limit,
      direct_truncated: sortedDirect.length > limit,
      transitive_truncated: transitiveTruncated,
    },
    freshness_badge: freshnessBadge,
  };
}