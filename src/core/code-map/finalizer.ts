/**
 * Code Map P1a — CORE finalizer (spec §3, §6; dec#108 #1, dec#109 P0 #4 / P1 #5/#6/#7).
 *
 * The finalizer is the ONE AND ONLY identity authority. Providers hand it typed,
 * id-free {@link ExtractionDraft}s; this module reproduces TODAY'S exact legacy
 * `extractor.ts` output: byte-identical node/edge IDs (via `ids.ts`), spans,
 * confidence, the `exported` flag, and — critically — the LEGACY SOURCE-APPEND
 * ORDER. Nothing here sorts node/edge content: draft items carry an `ordinal`
 * (their traversal position) and the finalizer replays them in that order.
 *
 * Emission contract (mirrors the legacy `addSymbol` / `addModule` / `markOrAddExport`):
 *  - File node FIRST.
 *  - Per definition (ascending ordinal): symbol node, `contains` edge, `defines` edge.
 *  - Per import / re-export source: `module` node, `imports` edge.
 *  - Per export clause / default-id (`markOrAddExport`): if the name matches an
 *    already-emitted symbol, set that node `exported=true` + emit ONE `exports`
 *    edge to it (no new node); otherwise fabricate an `export`-subtype symbol
 *    (node + `contains` + `defines`) then emit the `exports` edge to it.
 *
 * The `exported` FLAG is NOT an `exports` EDGE: in-place exported declarations set
 * only `node.exported=true`; only export clauses / default-identifier exports emit
 * an `exports` edge (and they ALSO flip the referenced node's flag, matching legacy).
 *
 * Output nodes/edges are validated against the `types.ts` zod schemas before return.
 */
import { edgeId, fileNodeId, nodeId } from './ids.js';
import type { ExtractionDraft } from './drafts.js';
import type { CodeEdge, CodeLang, CodeNode, NodeSubtype, ReferenceCandidate, Span } from './types.js';
import { EdgeSchema, NodeSchema } from './types.js';
import type { ExtractInput, ExtractResult } from './extractor.js';

/** Compute the legacy `sym:<hash>` node id (mirrors `extractor.ts:symId`). */
function symNodeId(
  projectId: string,
  path: string,
  lang: CodeLang,
  subtype: NodeSubtype,
  name: string,
  span: Span,
): string {
  return `sym:${nodeId({
    projectId,
    path,
    lang,
    kind: 'symbol',
    subtype,
    name,
    startLine: span.start_line,
    startCol: span.start_col,
  })}`;
}

/** Compute the legacy `module:<hash>` node id (mirrors `extractor.ts:addModule`). */
function moduleNodeId(
  projectId: string,
  path: string,
  lang: CodeLang,
  source: string,
  span: Span,
): string {
  return `module:${nodeId({
    projectId,
    path,
    lang,
    kind: 'module',
    subtype: null,
    name: source,
    startLine: span.start_line,
    startCol: span.start_col,
  })}`;
}

/** A draft item tagged by kind, for ordinal-ordered replay. */
type Item =
  | { kind: 'def'; ordinal: number; ref: ExtractionDraft['definitions'][number] }
  | { kind: 'import'; ordinal: number; ref: ExtractionDraft['imports'][number] }
  | { kind: 'export'; ordinal: number; ref: ExtractionDraft['exports'][number] };

/**
 * Turn a provider draft into the final {@link ExtractResult}. The ONLY identity
 * authority — reproduces the legacy extractor output exactly (see file header).
 *
 * `input` supplies `projectId`/`path`/`lang` (the id inputs). `parseStatus`
 * defaults to `'parsed'`; provider diagnostics ride on `draft.facts`.
 */
export function finalize(draft: ExtractionDraft, input: ExtractInput): ExtractResult {
  const { projectId, path, lang } = input;
  const fileNode = fileNodeId(projectId, path, lang);

  const nodes: CodeNode[] = [
    {
      id: fileNode,
      kind: 'file',
      subtype: null,
      lang,
      name: path,
      path,
      span: null,
      exported: false,
      confidence: 1.0,
      related_memory_ids: [],
      imported_names: [],
    },
  ];
  const edges: CodeEdge[] = [];

  // symbol name -> node id, mirroring the legacy `ctx.byName` (used by export
  // clauses to mark-or-add). Last writer per name wins, exactly like legacy.
  const byName = new Map<string, string>();
  // node id -> index in `nodes`, so an export clause can flip `exported` in place.
  const nodeIndexById = new Map<string, number>();
  // P4 resolves provider draft ordinals to final symbol ids only here, after the
  // identity authority has minted them. This keeps providers id-free.
  const definitionIdsByOrdinal = new Map<number, string>();

  const pushSymbol = (
    subtype: NodeSubtype,
    name: string,
    span: Span,
    exported: boolean,
    confidence: number,
  ): string => {
    const id = symNodeId(projectId, path, lang, subtype, name, span);
    nodeIndexById.set(id, nodes.length);
    nodes.push({
      id,
      kind: 'symbol',
      subtype,
      lang,
      name,
      path,
      span,
      exported,
      confidence,
      related_memory_ids: [],
      imported_names: [],
    });
    byName.set(name, id);
    edges.push({
      id: edgeId({ projectId, from: fileNode, to: id, kind: 'contains' }),
      from: fileNode,
      to: id,
      kind: 'contains',
      confidence: 1.0,
      source: { path, line: span.start_line },
    });
    edges.push({
      id: edgeId({ projectId, from: fileNode, to: id, kind: 'defines' }),
      from: fileNode,
      to: id,
      kind: 'defines',
      confidence: 1.0,
      source: { path, line: span.start_line },
    });
    return id;
  };

  // Build a single ordinal-ordered stream across all draft kinds so the finalizer
  // replays the legacy source-append order without ever sorting node/edge content.
  const items: Item[] = [
    ...draft.definitions.map((ref) => ({ kind: 'def' as const, ordinal: ref.ordinal, ref })),
    ...draft.imports.map((ref) => ({ kind: 'import' as const, ordinal: ref.ordinal, ref })),
    ...draft.exports.map((ref) => ({ kind: 'export' as const, ordinal: ref.ordinal, ref })),
  ].sort((a, b) => a.ordinal - b.ordinal);

  for (const item of items) {
    if (item.kind === 'def') {
      const d = item.ref;
      const id = pushSymbol(d.subtype, d.name, d.span, d.exported === true, d.confidence ?? 1.0);
      definitionIdsByOrdinal.set(d.ordinal, id);
    } else if (item.kind === 'import') {
      const im = item.ref;
      const id = moduleNodeId(projectId, path, lang, im.source, im.span);
      nodeIndexById.set(id, nodes.length);
      nodes.push({
        id,
        kind: 'module',
        subtype: null,
        lang,
        name: im.source,
        path,
        span: im.span,
        exported: false,
        confidence: im.confidence ?? 1.0,
        related_memory_ids: [],
        imported_names: [...im.importedNames],
      });
      edges.push({
        id: edgeId({ projectId, from: fileNode, to: id, kind: 'imports' }),
        from: fileNode,
        to: id,
        kind: 'imports',
        confidence: 1.0,
        source: { path, line: im.span.start_line },
      });
    } else {
      // export clause / default-identifier — legacy `markOrAddExport`.
      const ex = item.ref;
      const existing = byName.get(ex.name);
      let target: string;
      if (existing) {
        const idx = nodeIndexById.get(existing);
        if (idx !== undefined) nodes[idx] = { ...nodes[idx], exported: true };
        target = existing;
      } else {
        target = pushSymbol('export', ex.name, ex.span, true, ex.confidence ?? 1.0);
      }
      edges.push({
        id: edgeId({ projectId, from: fileNode, to: target, kind: 'exports' }),
        from: fileNode,
        to: target,
        kind: 'exports',
        confidence: 1.0,
        source: { path, line: ex.span.start_line },
      });
    }
  }

  // P4 lexical usages. Local targets are already proven by the provider's tree
  // walk; imported bindings become candidates and are materialized only by the
  // whole-project resolver when the target symbol is unique and importable.
  const referenceCandidates: ReferenceCandidate[] = [];
  for (const usage of draft.usages ?? []) {
    const from = usage.fromDefinitionOrdinal === undefined
      ? fileNode
      : definitionIdsByOrdinal.get(usage.fromDefinitionOrdinal);
    if (!from) continue;
    const confidence = usage.confidence ?? 1.0;
    const source = { path, line: usage.span.start_line };
    if (usage.target.kind === 'import') {
      // Textual hints are deliberately local-only. An imported binding gets no
      // graph edge until `resolveProjectImports` proves its target symbol.
      if (usage.kind === 'calls' || usage.kind === 'references') {
        referenceCandidates.push({
          from,
          kind: usage.kind,
          module: usage.target.module,
          imported_name: usage.target.importedName,
          confidence,
          source,
        });
      }
      continue;
    }
    const to = definitionIdsByOrdinal.get(usage.target.definitionOrdinal);
    if (!to) continue;
    edges.push({
      id: edgeId({ projectId, from, to, kind: usage.kind }),
      from,
      to,
      kind: usage.kind,
      confidence,
      source,
      origin: usage.kind === 'possible_textual_match' ? 'usage_textual' : 'usage_local',
    });
  }
  const parseStatus =
    (draft.attributes?.parseStatus as ExtractResult['parseStatus'] | undefined) ?? 'parsed';
  const diagnostics: Array<Record<string, unknown>> = draft.facts.map((f) => ({ ...f }));

  // Validate the finalized output against the durable schemas (spec §6).
  for (const n of nodes) NodeSchema.parse(n);
  for (const e of edges) EdgeSchema.parse(e);

  const result: ExtractResult = { parseStatus, nodes, edges, diagnostics };
  // P1's oracle intentionally compares the enumerable JSON result. Keep the
  // resolver hand-off available to refresh without changing that stable shape.
  if (referenceCandidates.length > 0) {
    Object.defineProperty(result, 'referenceCandidates', {
      value: referenceCandidates,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
}
