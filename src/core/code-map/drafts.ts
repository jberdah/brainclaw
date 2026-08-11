/**
 * Code Map P1a — provider DRAFT model (spec §4, §6; dec#108 #1, dec#109 P0 #4 / P1 #5/#6/#7).
 *
 * Providers produce typed DRAFTS and NEVER construct final `CodeNode`/`CodeEdge`
 * objects: identity (ids, default edges, legacy append order, validation) is owned
 * exclusively by the CORE finalizer (`finalizer.ts`). A draft carries the raw,
 * id-free facts the finalizer needs to reproduce today's exact extractor output.
 *
 * Every draft item carries an `ordinal` (its 0-based position in the provider's
 * traversal) so the finalizer can replay the legacy SOURCE-APPEND order WITHOUT
 * sorting node/edge content. Ordinals are compared across all draft kinds: a
 * definition at ordinal 3 and an import at ordinal 4 emit in that relative order.
 *
 * The `tests` lane is empty in P1a (tests_for is P2).
 */
import type { NodeSubtype, Span, UsageKind } from './types.js';

/**
 * File-level draft facts. The finalizer derives the file node id and the file
 * node itself from these — providers never mint the id.
 */
export interface FileDraft {
  /** Normalized POSIX relative path (store identity). Feeds the file node id. */
  readonly path: string;
}

/**
 * A definition (symbol) draft. The finalizer emits, per definition and in
 * ascending ordinal: the symbol node, then a `contains` edge, then a `defines`
 * edge — exactly the legacy `addSymbol` append order.
 */
export interface DefinitionDraft {
  /** 0-based traversal order across ALL draft kinds (definitions/imports/exports). */
  readonly ordinal: number;
  /** Originating query capture name (informational in P1a; e.g. `@definition.function.node`). */
  readonly captureName: string;
  /** Symbol name (feeds the node id + node.name). */
  readonly name: string;
  /** Resolved universal/namespaced subtype (feeds the node id + node.subtype). */
  readonly subtype: NodeSubtype;
  /**
   * The LEGACY IDENTITY span used by `ids.ts` (kind+subtype+name+startLine+startCol).
   * For TS lexical/variable declarations this is the ENCLOSING declaration-statement
   * span shared by every declarator in `const a=1,b=2` — NOT the declarator span.
   */
  readonly span: Span;
  /** Informational name-identifier span (P1a does NOT use it for identity). */
  readonly nameSpan?: Span;
  /**
   * Whether this declaration is exported in place (`export function ...`, exported
   * lexical). Sets `node.exported=true` and emits NO `exports` edge — the exported
   * FLAG is not an exports EDGE.
   */
  readonly exported?: boolean;
  /**
   * When true, this draft is itself an `export {a}` / `export default <id>` clause
   * entry that emits an `exports` edge (see {@link ExportDraft}). Definitions never
   * set this; it exists only so the shared field set stays uniform.
   */
  readonly emitsExportEdge?: boolean;
  /** Extraction confidence (defaults to 1.0 at finalize). */
  readonly confidence?: number;
  /** Non-persisted in-memory Tree-sitter node handle (provider-only; ignored at finalize). */
  readonly sourceNode?: unknown;
}

/**
 * An import (or re-export source) draft. The finalizer emits, per import and in
 * ascending ordinal: a `module` node, then an `imports` edge — the legacy
 * `addModule` append order. Shared by real imports and `export … from`/`export *`
 * re-export sources (which carry NO phantom symbol).
 */
export interface ImportDraft {
  /** 0-based traversal order across ALL draft kinds. */
  readonly ordinal: number;
  /** Module specifier (e.g. `react`, `./shared`). Feeds the module node id + name. */
  readonly source: string;
  /** The legacy identity span (the whole import/export statement). */
  readonly span: Span;
  /**
   * SOURCE-SIDE imported names (spec §6 P1 #7): default→`"default"`,
   * namespace→`"*"`, named→the specifier `name` (NOT its alias). Re-export `* from`
   * yields `["*"]`. Feeds `module.imported_names`.
   */
  readonly importedNames: readonly string[];
  /** Local binding names — draft-only, IGNORED by the finalizer in P1a. */
  readonly localNames?: readonly string[];
  /** Whether this draft originates from a re-export (`export … from`); informational. */
  readonly isReExport?: boolean;
  /** Confidence (defaults to 1.0 at finalize). */
  readonly confidence?: number;
}

/**
 * An export-clause / default-identifier draft (legacy `markOrAddExport`). The
 * finalizer, at this ordinal:
 *  - if {@link name} matches an already-emitted symbol → sets that node's
 *    `exported=true` and emits ONE `exports` edge to it (no new node);
 *  - otherwise → fabricates an `export`-subtype symbol (node + `contains` +
 *    `defines`) at {@link span}, then emits the `exports` edge to it.
 *
 * This is the ONLY draft kind that yields an `exports` edge. `export … from` /
 * `export *` are modeled as {@link ImportDraft}s, not exports.
 */
export interface ExportDraft {
  /** 0-based traversal order across ALL draft kinds. */
  readonly ordinal: number;
  /** Exported binding name (source-side identifier). */
  readonly name: string;
  /** The legacy identity span (the enclosing `export` statement). */
  readonly span: Span;
  /** Confidence for a fabricated `export` symbol (defaults to 1.0 at finalize). */
  readonly confidence?: number;
}

/** A test draft — EMPTY in P1a (tests_for is P2). Declared for shape completeness. */
export interface TestDraft {
  readonly ordinal: number;
  readonly name: string;
  readonly span: Span;
}

/**
 * A provider-proven lexical usage. Local targets are finalized immediately;
 * imported bindings remain candidates until the project resolver proves one
 * importable target symbol. `possible_textual_match` is intentionally local-only
 * and remains a low-confidence hint rather than a call edge.
 */
export interface UsageDraft {
  readonly kind: UsageKind;
  /** Omit for a top-level usage: the finalizer uses the file node as caller. */
  readonly fromDefinitionOrdinal?: number;
  readonly target:
    | { readonly kind: 'local'; readonly definitionOrdinal: number }
    | { readonly kind: 'import'; readonly module: string; readonly importedName: string };
  readonly span: Span;
  readonly confidence?: number;
}

/** A provider-emitted fact (diagnostics, heuristic notes). Opaque to the finalizer in P1a. */
export interface ExtractionFact {
  readonly code: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

/**
 * The complete typed output of a provider's `extractDraft` (+ `refine`). Carries
 * NO ids and NO final nodes/edges — only the raw facts the CORE finalizer turns
 * into an `ExtractResult`.
 */
export interface ExtractionDraft {
  readonly file: FileDraft;
  readonly definitions: DefinitionDraft[];
  readonly imports: ImportDraft[];
  readonly exports: ExportDraft[];
  /** Empty in P1a. */
  readonly tests: TestDraft[];
  /** P4 lexical usages. Optional so historical hand-written drafts remain valid. */
  readonly usages?: UsageDraft[];
  readonly facts: ExtractionFact[];
  /** Provider-specific scratch (e.g. parse status hint). Optional. */
  readonly attributes?: Record<string, unknown>;
}
