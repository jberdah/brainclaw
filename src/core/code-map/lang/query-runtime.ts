/**
 * Code Map P1a — generic query-driven extraction runtime (spec §7).
 *
 * Loads the grammar via the provider-supplied `grammarForLang` loader (keeping
 * the generic runtime independent of any one provider's WASM loader), COMPILES
 * each query asset ONCE per
 * `(providerId, lang, query-hash)` and caches the compiled `Query` process-wide
 * (Tree-sitter `Query` objects are compile-once — never recompile per file), runs
 * the tags + imports queries over a parsed file, and maps captures to an
 * {@link ExtractionDraft} with source-traversal `ordinal`s.
 *
 * CAPTURE-NAME CONVENTION = THE CONTRACT (P1b §3.4 decision).
 * The runtime drives capture → draft mapping from the hard-coded capture-name
 * convention below (`parseDefinitionCapture` for definitions; the fixed
 * `switch` over `import.*`/`export.*` for imports/exports). A provider's
 * `queries.captureMap` is therefore a DECLARED MIRROR of this convention — it
 * documents (and is validated against — see {@link assertCaptureMapConforms})
 * the convention, but it does NOT let a provider invent arbitrary capture roles.
 * To add a capture role, the convention here (and the validator) must change. A
 * provider MUST name its captures per this convention and keep its captureMap
 * consistent with it; the guide states this is the honest, current contract.
 *
 * Capture conventions (THE contract; `captureMap` mirrors + is validated against it):
 *   @definition.<subtype>.node       anchors a DefinitionDraft; span = this node
 *   @definition.<subtype>.name       the symbol name (also the ORDINAL anchor)
 *   @definition.<subtype>.exported   presence ⇒ DefinitionDraft.exported = true
 *   @import.source                   anchors an ImportDraft; span = enclosing
 *                                    import/export STATEMENT; groups PER captured
 *                                    @import.source node (multi-source aware — a
 *                                    statement with N sources yields N module
 *                                    nodes, e.g. Python `import a, b`). JS/TS is
 *                                    single-source-per-statement so this is
 *                                    byte-identical to per-statement grouping.
 *   @import.default.name             contributes imported name "default"
 *   @import.namespace.name           contributes imported name "*"
 *   @import.named.name               contributes the source-side specifier name
 *   @export.name                     a local export-clause / default-id target
 *
 * Per-file best-effort errors (mirrors legacy `extractor.ts`): parse failure →
 * `parse_error` attribute (the core emits a file node only); a query exception →
 * the partial draft + an `extraction_error` fact; never throws out of the runtime.
 * `max_query_wait_ms` bounds parse + query execution.
 *
 * The parse TREE is retained on the draft (`attributes.__tree`) until refine +
 * finalize finish; the core deletes it afterwards.
 */
import type { Node as TsNode, Tree, Parser as ParserType } from 'web-tree-sitter';
import { getParser, getQueryClass } from '../wasm-loader.js';
import type { CodeLang, NodeSubtype, Span } from '../types.js';
import type { CaptureMapping } from '../vocabulary.js';
import type {
  DefinitionDraft,
  ExportDraft,
  ExtractionDraft,
  ExtractionFact,
  ImportDraft,
} from '../drafts.js';

/** A compiled web-tree-sitter Query (structural shape we depend on). */
interface CompiledQuery {
  matches(node: TsNode): Array<{ patternIndex: number; captures: Array<{ name: string; node: TsNode }> }>;
  readonly captureNames: string[];
}

/** Process-wide compiled-query cache, keyed `${providerId}|${lang}|${queryHash}`. */
const queryCache = new Map<string, CompiledQuery>();

/**
 * Compile a query asset ONCE per `(providerId, lang, queryHash)` and cache it.
 * Compile failure is fatal + loud (spec §7 — a broken bundled asset fails here,
 * never a silent per-file skip).
 */
async function compileCached(
  providerId: string,
  lang: CodeLang,
  queryHash: string,
  grammar: unknown,
  source: string,
): Promise<CompiledQuery> {
  const key = `${providerId}|${lang}|${queryHash}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const Query = await getQueryClass();
  // The loader's `Query` comes from the SAME engine-glue instance the grammar was
  // loaded against (and after initEngine), so the Emscripten Module is live here.
  // Cast to the structural shape we consume.
  const compiled = new Query(grammar as never, source) as unknown as CompiledQuery; // throws loudly on a broken asset
  queryCache.set(key, compiled);
  return compiled;
}

/** Test/maintenance seam: drop the compiled-query cache. */
export function __resetQueryCache(): void {
  queryCache.clear();
}

/** Test seam: number of distinct compiled queries currently cached. */
export function __queryCacheSize(): number {
  return queryCache.size;
}

function spanOf(node: TsNode): Span {
  return {
    start_line: node.startPosition.row + 1,
    start_col: node.startPosition.column + 1,
    end_line: node.endPosition.row + 1,
    end_col: node.endPosition.column + 1,
  };
}

/** Strip surrounding quotes from a module specifier text. */
function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Walk up from a capture node to the enclosing import/export STATEMENT for
 * span/ordinal anchoring, using the PROVIDER-LOCAL set of grammar node types that
 * count as an import/export statement (cadrage §3 / Codex R1 langs#3-4).
 *
 * Each provider declares its OWN statement node types via
 * {@link QueryRuntimeInput.enclosingStatementNodeTypes} (JS/TS
 * `import_statement`/`export_statement`; Python `import_statement`/
 * `import_from_statement`; PHP `namespace_use_declaration`; Java
 * `import_declaration`). The runtime uses ONLY the set passed for the CURRENT file
 * and NEVER imports/consults a central registry — adding a language is a provider
 * declaration, not an edit here. This is the rule-of-N generalization the P1b
 * review predicted: the runtime previously hard-coded the JS/Python statement
 * names, which would have silently mis-spanned PHP/Java import statements.
 */
function enclosingStatement(node: TsNode, statementTypes: ReadonlySet<string>): TsNode {
  let n: TsNode | null = node;
  while (n) {
    if (statementTypes.has(n.type)) return n;
    n = n.parent;
  }
  return node;
}

/** Parse a `@definition.<subtype>.<role>` capture name into its parts. */
function parseDefinitionCapture(
  name: string,
): { subtype: string; role: 'node' | 'name' | 'exported' } | null {
  const m = /^definition\.(.+)\.(node|name|exported)$/.exec(name);
  if (!m) return null;
  return { subtype: m[1], role: m[2] as 'node' | 'name' | 'exported' };
}

/**
 * The fixed import/export capture roles the runtime `switch` honors. Together with
 * the `definition.<subtype>.(node|name|exported)` pattern, this is the COMPLETE
 * hard-coded capture convention — THE contract (P1b §3.4). A provider's captureMap
 * may only use these capture names.
 */
const FIXED_IMPORT_EXPORT_CAPTURES: ReadonlySet<string> = new Set([
  'import.source',
  'import.default.name',
  'import.namespace.name',
  'import.named.name',
  'export.name',
]);

/** True iff `name` is a capture role the hard-coded runtime convention recognizes. */
export function isConventionCapture(name: string): boolean {
  return parseDefinitionCapture(name) !== null || FIXED_IMPORT_EXPORT_CAPTURES.has(name);
}

/**
 * Validate that a provider's declared `captureMap` mirrors the hard-coded capture
 * convention the runtime actually drives off (P1b §3.4). Throws (loud — a provider
 * authoring bug, not a per-file error) listing any capture the runtime would
 * silently ignore. The runtime does NOT call this on the hot path; providers/tests
 * call it once to assert their captureMap is honest. Returns the offending captures
 * for assertion ergonomics.
 */
export function assertCaptureMapConforms(captureMap: readonly CaptureMapping[]): string[] {
  const unknown = captureMap.map((m) => m.capture).filter((c) => !isConventionCapture(c));
  if (unknown.length > 0) {
    throw new Error(
      `captureMap declares captures the runtime convention does not recognize: ${unknown.join(', ')}. ` +
        `The hard-coded convention is THE contract (definition.<subtype>.(node|name|exported) + ` +
        `import.source/import.default.name/import.namespace.name/import.named.name/export.name).`,
    );
  }
  return unknown;
}

/** Inputs the runtime needs to parse + query one file. */
export interface QueryRuntimeInput {
  readonly providerId: string;
  readonly lang: CodeLang;
  readonly source: string;
  readonly sizeBytes: number;
  readonly maxParseFileBytes: number;
  readonly maxQueryWaitMs?: number;
  readonly path: string;
  /** Provider grammar loader — keeps the runtime independent of the JS/TS loader. */
  readonly grammarForLang: (lang: CodeLang) => Promise<unknown>;
  /** Query assets + their per-lang hashes. */
  readonly tagsSource: string;
  readonly tagsHash: string;
  readonly importsSource: string;
  readonly importsHash: string;
  /**
   * PROVIDER-LOCAL grammar node types that count as the enclosing import/export
   * STATEMENT for import span/ordinal anchoring (the provider's
   * `queries.enclosingStatementNodeTypes`). The runtime uses ONLY this set for the
   * current file — it never derives it from a central registry (cadrage §3 / Codex
   * R1). Include BOTH import and export statement node types where the language has
   * them (JS/TS local exports/re-exports also resolve through {@link
   * enclosingStatement}).
   */
  readonly enclosingStatementNodeTypes: readonly string[];
}

/** Per-definition scratch built while grouping definition matches. */
interface DefScratch {
  subtype: string;
  name: string;
  node: TsNode; // the @definition.*.node (span source)
  nameNode: TsNode; // the @definition.*.name (ordinal anchor + refine handle)
  exported: boolean;
  ordinalIndex: number; // startIndex of nameNode
}

/**
 * Per-`@import.source` scratch built while grouping import/re-export matches.
 *
 * Grouping is keyed by the captured SOURCE node (not the enclosing statement), so
 * one statement carrying N module sources (Python `import a, b`) produces N module
 * nodes. JS/TS statements carry exactly one source, so source-keyed grouping is
 * byte-identical to the legacy per-statement grouping (same `span`, same ordinal).
 */
interface ImportScratch {
  source: string;
  statement: TsNode;
  span: Span;
  names: string[];
  ordinalIndex: number;
  isReExport: boolean;
}

/**
 * Run the provider's tags + imports queries over one file and produce a draft.
 * Never throws: parse/timeout failures set `attributes.parseStatus='parse_error'`
 * and return a file-only draft; query exceptions return the partial draft + an
 * `extraction_error` fact.
 */
export async function extractWithQueries(input: QueryRuntimeInput): Promise<ExtractionDraft> {
  const facts: ExtractionFact[] = [];
  // PROVIDER-LOCAL enclosing-statement node types — the only source of truth for
  // import/export span anchoring (cadrage §3 / Codex R1). No registry lookup.
  const statementTypes = new Set(input.enclosingStatementNodeTypes);
  const emptyDraft = (parseStatus: string, tree: Tree | null): ExtractionDraft => ({
    file: { path: input.path },
    definitions: [],
    imports: [],
    exports: [],
    tests: [],
    usages: [],
    facts,
    attributes: { parseStatus, __tree: tree },
  });

  // Oversized — never parse (mirrors legacy skipped_too_large; core emits file node).
  if (input.sizeBytes > input.maxParseFileBytes) {
    facts.push({
      code: 'skipped_too_large',
      message: `file ${input.sizeBytes} bytes exceeds max_parse_file_bytes ${input.maxParseFileBytes}`,
    });
    return emptyDraft('skipped_too_large', null);
  }

  // --- Parse (bounded by max_query_wait_ms) ---
  let tree: Tree;
  let parser: ParserType | null = null;
  try {
    const grammar = await input.grammarForLang(input.lang);
    const Parser = await getParser();
    parser = new Parser();
    // `grammarForLang` returns the engine-opaque grammar handle (typed `unknown` so
    // the runtime stays provider-agnostic); it IS a web-tree-sitter Language here.
    parser.setLanguage(grammar as Parameters<ParserType['setLanguage']>[0]);
    const deadline = input.maxQueryWaitMs;
    if (typeof deadline === 'number' && deadline > 0) {
      // web-tree-sitter parse is synchronous; the bound is advisory. We honor it by
      // measuring wall-clock and flagging overruns (the legacy path had no timeout,
      // so overrun → parse_error keeps us strictly no-worse than legacy).
      const t0 = Date.now();
      const parsed = parser.parse(input.source);
      if (Date.now() - t0 > deadline) {
        try {
          parsed?.delete();
        } catch {
          /* best effort */
        }
        facts.push({ code: 'parse_error', message: `parse exceeded max_query_wait_ms ${deadline}` });
        return emptyDraft('parse_error', null);
      }
      if (!parsed) {
        facts.push({ code: 'parse_error', message: 'parser returned null' });
        return emptyDraft('parse_error', null);
      }
      tree = parsed;
    } else {
      const parsed = parser.parse(input.source);
      if (!parsed) {
        facts.push({ code: 'parse_error', message: 'parser returned null' });
        return emptyDraft('parse_error', null);
      }
      tree = parsed;
    }
  } catch (err) {
    facts.push({ code: 'parse_error', message: err instanceof Error ? err.message : String(err) });
    return emptyDraft('parse_error', null);
  } finally {
    // The per-file parser is no longer needed once parse() returns; the TREE stays
    // alive for refine/finalize. Delete the parser (best effort) so each file does
    // not leak a web-tree-sitter Parser instance.
    if (parser) {
      try {
        parser.delete();
      } catch {
        /* best effort */
      }
    }
  }

  const definitions: DefinitionDraft[] = [];
  const imports: ImportDraft[] = [];
  const exports: ExportDraft[] = [];

  try {
    const grammar = await input.grammarForLang(input.lang);
    const tagsQuery = await compileCached(
      input.providerId,
      input.lang,
      input.tagsHash,
      grammar,
      input.tagsSource,
    );
    const importsQuery = await compileCached(
      input.providerId,
      input.lang,
      input.importsHash,
      grammar,
      input.importsSource,
    );

    // --- DEFINITIONS: one DefScratch per match (each match has a .node + .name). ---
    const defScratch: DefScratch[] = [];
    for (const match of tagsQuery.matches(tree.rootNode)) {
      let subtype = '';
      let nodeNode: TsNode | null = null;
      let nameNode: TsNode | null = null;
      let exported = false;
      for (const cap of match.captures) {
        const parsed = parseDefinitionCapture(cap.name);
        if (!parsed) continue;
        if (parsed.role === 'node') {
          subtype = parsed.subtype;
          nodeNode = cap.node;
        } else if (parsed.role === 'name') {
          nameNode = cap.node;
        } else {
          exported = true;
        }
      }
      if (!nodeNode || !nameNode || !subtype) continue;
      defScratch.push({
        subtype,
        name: nameNode.text,
        node: nodeNode,
        nameNode,
        exported,
        ordinalIndex: nameNode.startIndex,
      });
    }

    // --- IMPORTS / RE-EXPORTS / LOCAL EXPORTS ---
    // Keyed by the captured @import.source node id so one statement with N
    // sources yields N module nodes (multi-source aware). JS/TS = one source per
    // statement → identical to the legacy per-statement grouping.
    const importBySource = new Map<number, ImportScratch>();
    const exportScratch: Array<{ name: string; node: TsNode; ordinalIndex: number }> = [];

    for (const match of importsQuery.matches(tree.rootNode)) {
      let sourceNode: TsNode | null = null;
      let defaultName: TsNode | null = null;
      let namespaceName: TsNode | null = null;
      let namedName: TsNode | null = null;
      let exportName: TsNode | null = null;
      for (const cap of match.captures) {
        switch (cap.name) {
          case 'import.source':
            sourceNode = cap.node;
            break;
          case 'import.default.name':
            defaultName = cap.node;
            break;
          case 'import.namespace.name':
            namespaceName = cap.node;
            break;
          case 'import.named.name':
            namedName = cap.node;
            break;
          case 'export.name':
            exportName = cap.node;
            break;
          default:
            break;
        }
      }

      if (sourceNode) {
        // import statement OR re-export (export … from). Group PER captured source
        // node so a statement with N sources emits N module nodes (Python
        // `import a, b`). span/ordinal stay anchored on the enclosing statement,
        // which for single-source JS/TS is byte-identical to per-statement grouping.
        const stmt = enclosingStatement(sourceNode, statementTypes);
        const isReExport = stmt.type === 'export_statement';
        let scratch = importBySource.get(sourceNode.id);
        if (!scratch) {
          scratch = {
            source: stripQuotes(sourceNode.text),
            statement: stmt,
            span: spanOf(stmt),
            names: [],
            ordinalIndex: stmt.startIndex,
            isReExport,
          };
          importBySource.set(sourceNode.id, scratch);
        }
        if (defaultName) scratch.names.push('default');
        if (namespaceName) scratch.names.push('*');
        if (namedName) scratch.names.push(namedName.text);
      } else if (exportName) {
        // Local export clause / default-identifier — mark-or-add at finalize.
        exportScratch.push({
          name: exportName.text,
          node: exportName,
          ordinalIndex: exportName.startIndex,
        });
      }
    }

    // `export * from 'm'` matches a pattern with no name capture → names empty.
    // Legacy supplies "*" for a sourced re-export that carried no specifier.
    for (const scratch of importBySource.values()) {
      if (scratch.isReExport && scratch.names.length === 0) scratch.names.push('*');
    }

    // --- Assign ordinals in source-traversal order across ALL kinds. ---
    type Anchored = { ordinalIndex: number; emit: (ordinal: number) => void };
    const anchored: Anchored[] = [];

    for (const d of defScratch) {
      anchored.push({
        ordinalIndex: d.ordinalIndex,
        emit: (ordinal) => {
          definitions.push({
            ordinal,
            captureName: `definition.${d.subtype}.node`,
            name: d.name,
            subtype: d.subtype as NodeSubtype,
            span: spanOf(d.node),
            nameSpan: spanOf(d.nameNode),
            exported: d.exported || undefined,
            sourceNode: { node: d.node, nameNode: d.nameNode },
          });
        },
      });
    }
    for (const im of importBySource.values()) {
      anchored.push({
        ordinalIndex: im.ordinalIndex,
        emit: (ordinal) => {
          imports.push({
            ordinal,
            source: im.source,
            span: im.span,
            importedNames: im.names,
            isReExport: im.isReExport || undefined,
          });
        },
      });
    }
    for (const ex of exportScratch) {
      anchored.push({
        ordinalIndex: ex.ordinalIndex,
        emit: (ordinal) => {
          exports.push({ ordinal, name: ex.name, span: spanOf(enclosingStatement(ex.node, statementTypes)) });
        },
      });
    }

    // Stable sort by source byte offset; ties keep insertion (def→import→export) order.
    anchored
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.ordinalIndex - y.a.ordinalIndex) || (x.i - y.i))
      .forEach((wrapped, ordinal) => wrapped.a.emit(ordinal));
  } catch (err) {
    facts.push({
      code: 'extraction_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const parseStatus = tree.rootNode.hasError ? 'parse_error' : 'parsed';
  if (parseStatus === 'parse_error') {
    facts.push({ code: 'parse_error', message: 'tree contains syntax errors' });
  }

  return {
    file: { path: input.path },
    definitions,
    imports,
    exports,
    tests: [],
    usages: [],
    facts,
    attributes: { parseStatus, __tree: tree },
  };
}
