/**
 * Bounded Code Map subgraph export. Mermaid is rendered from this module's JSON
 * model; it never takes a second, potentially different graph traversal.
 */
import path from 'node:path';
import { withCoarse } from './freshness.js';
import { listShards, readManifest } from './store.js';
import type { QueryContext } from './query.js';
import type { CodeEdge, CodeNode, FreshnessBadge, Span } from './types.js';

/** Absolute traversal and response ceilings: a whole-graph export is impossible. */
export const CODE_EXPORT_MAX_DEPTH = 4;
export const CODE_EXPORT_NODE_CAP = 100;
export const CODE_EXPORT_EDGE_CAP = 200;
/** Low-confidence extracted data is never included by default or opt-out. */
export const CODE_EXPORT_MIN_CONFIDENCE = 0.5;

export type CodeGraphDirection = 'outgoing' | 'incoming' | 'both';
export type CodeGraphFormat = 'json' | 'mermaid';
export type CodeGraphTargetKind = 'symbol' | 'file';

export interface CodeGraphExportOptions {
  targetKind?: CodeGraphTargetKind;
  direction?: CodeGraphDirection;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Stored confidence required for nodes AND relationships. Clamped to 0.5..1. */
  minConfidence?: number;
  format?: CodeGraphFormat;
}

/** Compact node projection; unrelated-memory and parser payloads stay private. */
export interface CodeGraphNode {
  id: string;
  kind: CodeNode['kind'];
  subtype: CodeNode['subtype'] | null;
  lang: CodeNode['lang'];
  name: string;
  path: string;
  span: Span | null;
  exported: boolean;
  confidence: number;
}

/** Never erase relation type, source location, or confidence in an export. */
export interface CodeGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: CodeEdge['kind'];
  confidence: number;
  source: NonNullable<CodeEdge['source']> | null;
}

export interface CodeGraphLimits {
  direction: CodeGraphDirection;
  max_depth: number;
  max_nodes: number;
  max_edges: number;
  min_confidence: number;
}

export interface CodeGraphTruncation {
  roots: boolean;
  nodes: boolean;
  edges: boolean;
  depth: boolean;
}

/** Canonical bounded graph model, shared by JSON and Mermaid representations. */
export interface CodeSubgraph {
  target: string;
  target_kind: CodeGraphTargetKind;
  root_node_ids: string[];
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  limits: CodeGraphLimits;
  truncated: CodeGraphTruncation;
  freshness_badge: FreshnessBadge;
}

export interface CodeGraphExportOutput extends CodeSubgraph {
  format: CodeGraphFormat;
  /** Mermaid is optional; nodes and edges above remain the source of truth. */
  mermaid?: string;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CODE_EXPORT_MIN_CONFIDENCE;
  return Math.min(Math.max(value, CODE_EXPORT_MIN_CONFIDENCE), 1);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeDirection(value: unknown): CodeGraphDirection {
  return value === 'outgoing' || value === 'incoming' || value === 'both' ? value : 'both';
}

function normalizeFormat(value: unknown): CodeGraphFormat {
  return value === 'mermaid' || value === 'json' ? value : 'json';
}

function normalizeTargetKind(value: unknown, target: string): CodeGraphTargetKind {
  return value === 'symbol' || value === 'file' ? value : inferTargetKind(target);
}

function inferTargetKind(target: string): CodeGraphTargetKind {
  return /[\\/]/.test(target)
    || /\.(?:[cm]?[jt]sx?|py|php|java|go|rs|cs|rb|c|cc|cpp|cxx|h|hpp)$/i.test(target)
    ? 'file'
    : 'symbol';
}

/** No selector may address the project root itself or escape it. */
function normalizeFileTarget(target: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return normalizePath(relative);
}

function compareNodes(a: CodeNode, b: CodeNode): number {
  const as = a.span;
  const bs = b.span;
  return a.path.localeCompare(b.path)
    || (as?.start_line ?? -1) - (bs?.start_line ?? -1)
    || (as?.start_col ?? -1) - (bs?.start_col ?? -1)
    || a.kind.localeCompare(b.kind)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

function compareEdges(a: CodeEdge, b: CodeEdge): number {
  return a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || a.kind.localeCompare(b.kind)
    || (a.source?.path ?? '').localeCompare(b.source?.path ?? '')
    || (a.source?.line ?? -1) - (b.source?.line ?? -1)
    || a.id.localeCompare(b.id);
}

function graphNode(node: CodeNode): CodeGraphNode {
  return { id: node.id, kind: node.kind, subtype: node.subtype ?? null, lang: node.lang, name: node.name, path: node.path,
    span: node.span ?? null, exported: node.exported, confidence: node.confidence };
}

function graphEdge(edge: CodeEdge): CodeGraphEdge {
  return { id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, confidence: edge.confidence, source: edge.source ?? null };
}

function matchesRoot(node: CodeNode, target: string, targetKind: CodeGraphTargetKind, normalizedPath: string | null): boolean {
  return targetKind === 'file'
    ? node.kind === 'file' && normalizedPath !== null && normalizePath(node.path) === normalizedPath
    : node.kind === 'symbol' && node.name === target;
}

function usableEdge(edge: CodeEdge, nodes: Map<string, CodeNode>, minConfidence: number): boolean {
  return edge.confidence >= minConfidence
    && (nodes.get(edge.from)?.confidence ?? -Infinity) >= minConfidence
    && (nodes.get(edge.to)?.confidence ?? -Infinity) >= minConfidence;
}

function touches(edge: CodeEdge, nodeId: string, direction: CodeGraphDirection): boolean {
  return ((direction === 'outgoing' || direction === 'both') && edge.from === nodeId)
    || ((direction === 'incoming' || direction === 'both') && edge.to === nodeId);
}

function neighbor(edge: CodeEdge, nodeId: string): string {
  return edge.from === nodeId ? edge.to : edge.from;
}

function emptyOutput(target: string, targetKind: CodeGraphTargetKind, limits: CodeGraphLimits, freshness: FreshnessBadge, format: CodeGraphFormat): CodeGraphExportOutput {
  const graph: CodeSubgraph = {
    target, target_kind: targetKind, root_node_ids: [], nodes: [], edges: [], limits,
    truncated: { roots: false, nodes: false, edges: false, depth: false }, freshness_badge: freshness,
  };
  return format === 'mermaid' ? { ...graph, format, mermaid: toMermaid(graph) } : { ...graph, format };
}

/**
 * Select a deterministic, confidence-filtered neighborhood from persisted shards.
 * No refresh, parse, inference, service call, or unbounded response occurs here.
 */
export function exportSubgraph(targetInput: string, options: CodeGraphExportOptions | undefined, ctx: QueryContext): CodeGraphExportOutput {
  const target = targetInput.trim();
  const targetKind = normalizeTargetKind(options?.targetKind, target);
  const format = normalizeFormat(options?.format);
  const limits: CodeGraphLimits = {
    direction: normalizeDirection(options?.direction),
    max_depth: clampInteger(options?.depth, 1, 0, CODE_EXPORT_MAX_DEPTH),
    max_nodes: clampInteger(options?.maxNodes, CODE_EXPORT_NODE_CAP, 1, CODE_EXPORT_NODE_CAP),
    max_edges: clampInteger(options?.maxEdges, CODE_EXPORT_EDGE_CAP, 0, CODE_EXPORT_EDGE_CAP),
    min_confidence: clampConfidence(options?.minConfidence),
  };
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  const missing = withCoarse({ status: 'missing_index', details: { hint: 'run refresh' } });
  if (!manifest || manifest.freshness.status === 'missing_index' || !target) return emptyOutput(target, targetKind, limits, missing, format);

  const targetPath = targetKind === 'file' ? normalizeFileTarget(target, manifest.project_root) : null;
  if (targetKind === 'file' && !targetPath) {
    return emptyOutput(target, targetKind, limits, withCoarse({
      status: manifest.freshness.status, details: { invalid_target: 'file path must be inside the indexed project' },
    }), format);
  }

  const allNodes = new Map<string, CodeNode>();
  const allEdges = new Map<string, CodeEdge>();
  for (const shard of listShards(ctx.cwd, ctx.preferredDirName).sort((a, b) => a.path.localeCompare(b.path) || a.file_id.localeCompare(b.file_id))) {
    for (const node of shard.nodes) if (!allNodes.has(node.id)) allNodes.set(node.id, node);
    for (const edge of shard.edges) if (!allEdges.has(edge.id)) allEdges.set(edge.id, edge);
  }
  const nodes = new Map([...allNodes.entries()].filter(([, node]) => node.confidence >= limits.min_confidence));
  const edges = [...allEdges.values()].filter((edge) => usableEdge(edge, nodes, limits.min_confidence)).sort(compareEdges);
  const roots = [...nodes.values()].filter((node) => matchesRoot(node, target, targetKind, targetPath)).sort(compareNodes);

  const selected = new Set<string>();
  const rootNodeIds: string[] = [];
  let rootsTruncated = false;
  for (const root of roots) {
    if (selected.size >= limits.max_nodes) { rootsTruncated = true; break; }
    selected.add(root.id);
    rootNodeIds.push(root.id);
  }

  const selectedEdges = new Map<string, CodeEdge>();
  const visited = new Set(rootNodeIds);
  let nodesTruncated = false;
  let edgesTruncated = false;
  let depthTruncated = false;
  let frontier = [...rootNodeIds];
  for (let currentDepth = 0; frontier.length > 0; currentDepth++) {
    const next = new Set<string>();
    frontier.sort((a, b) => compareNodes(nodes.get(a)!, nodes.get(b)!));
    for (const nodeId of frontier) {
      const incident = edges.filter((edge) => touches(edge, nodeId, limits.direction));
      if (currentDepth >= limits.max_depth) {
        if (incident.some((edge) => !selectedEdges.has(edge.id))) depthTruncated = true;
        continue;
      }
      for (const edge of incident) {
        const adjacent = neighbor(edge, nodeId);
        if (!selected.has(adjacent) && selected.size >= limits.max_nodes) { nodesTruncated = true; continue; }
        if (selectedEdges.size >= limits.max_edges && !selectedEdges.has(edge.id)) { edgesTruncated = true; continue; }
        selected.add(adjacent);
        selectedEdges.set(edge.id, edge);
        if (!visited.has(adjacent)) { visited.add(adjacent); next.add(adjacent); }
      }
    }
    frontier = [...next];
  }

  const graph: CodeSubgraph = {
    target, target_kind: targetKind, root_node_ids: rootNodeIds,
    nodes: [...selected].map((id) => nodes.get(id)).filter((node): node is CodeNode => node !== undefined).sort(compareNodes).map(graphNode),
    edges: [...selectedEdges.values()].sort(compareEdges).map(graphEdge),
    limits, truncated: { roots: rootsTruncated, nodes: nodesTruncated, edges: edgesTruncated, depth: depthTruncated },
    freshness_badge: withCoarse({ status: manifest.freshness.status,
      details: { stale_file_count: manifest.freshness.stale_file_count, partial_reason: manifest.freshness.partial_reason } }),
  };
  return format === 'mermaid' ? { ...graph, format, mermaid: toMermaid(graph) } : { ...graph, format };
}

function mermaidLabel(node: CodeGraphNode): string {
  return JSON.stringify(`${node.name} (${node.kind})`.replace(/[\r\n]/g, ' '));
}

/** Deterministic textual projection of a graph already selected by exportSubgraph. */
export function toMermaid(graph: CodeSubgraph): string {
  const ids = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart TD'];
  for (const node of graph.nodes) lines.push(`  ${ids.get(node.id)}[${mermaidLabel(node)}]`);
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) lines.push(`  ${from} -->|${edge.kind} · ${edge.confidence}| ${to}`);
  }
  return lines.join('\n');
}