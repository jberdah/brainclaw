/**
 * Code Map P1a — generic query-driven extraction runtime (spec §7).
 *
 * Loads the grammar via `wasm-loader`, COMPILES each query asset ONCE per
 * `(providerId, lang, query-hash)` and caches the compiled `Query` process-wide
 * (Tree-sitter `Query` objects are compile-once — never recompile per file), runs
 * the tags + imports queries over a parsed file, and maps captures to an
 * {@link ExtractionDraft} with source-traversal `ordinal`s.
 *
 * Capture conventions (matched by the TS provider's `captureMap`):
 *   @definition.<subtype>.node       anchors a DefinitionDraft; span = this node
 *   @definition.<subtype>.name       the symbol name (also the ORDINAL anchor)
 *   @definition.<subtype>.exported   presence ⇒ DefinitionDraft.exported = true
 *   @import.source                   anchors an ImportDraft; span = enclosing
 *                                    import/export STATEMENT; groups by statement
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
import type { Node as TsNode, Tree } from 'web-tree-sitter';
import { getParser, loadGrammar } from '../wasm-loader.js';
import type { CodeLang, NodeSubtype, Span } from '../types.js';
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

interface QueryCtor {
  new (grammar: unknown, source: string): CompiledQuery;
}

/** Process-wide compiled-query cache, keyed `${providerId}|${lang}|${queryHash}`. */
const queryCache = new Map<string, CompiledQuery>();

let QueryClass: QueryCtor | null = null;

/** Resolve the `Query` constructor from the engine glue once (compile-once path). */
async function getQueryClass(): Promise<QueryCtor> {
  if (QueryClass) return QueryClass;
  // The vendored/devDep engine glue exposes `Query` as a named export. We reach it
  // via the same dynamic-import seam the wasm-loader uses (web-tree-sitter is never
  // in the eager module graph). getParser() guarantees the glue is loaded.
  await getParser();
  const mod = (await import('web-tree-sitter')) as unknown as { Query: QueryCtor };
  QueryClass = mod.Query;
  return QueryClass;
}

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
  const compiled = new Query(grammar, source); // throws loudly on a broken asset
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

/** Walk up from a capture node to the enclosing import/export statement. */
function enclosingStatement(node: TsNode): TsNode {
  let n: TsNode | null = node;
  while (n) {
    if (n.type === 'import_statement' || n.type === 'export_statement') return n;
    n = n.parent;
  }
  return node;
}

/** Parse a `@definition.<subtype>.<role>` capture name into its parts. */
function parseDefinitionCapture(
  name: string,
): { subtype: string; role: 'node' | 'name' | 'exported' } | null {
  const m = /^definition\.([a-z_]+)\.(node|name|exported)$/.exec(name);
  if (!m) return null;
  return { subtype: m[1], role: m[2] as 'node' | 'name' | 'exported' };
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
  /** Query assets + their per-lang hashes. */
  readonly tagsSource: string;
  readonly tagsHash: string;
  readonly importsSource: string;
  readonly importsHash: string;
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

/** Per-import-statement scratch built while grouping import/re-export matches. */
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
  const emptyDraft = (parseStatus: string, tree: Tree | null): ExtractionDraft => ({
    file: { path: input.path },
    definitions: [],
    imports: [],
    exports: [],
    tests: [],
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
  try {
    const grammar = await loadGrammar(input.lang);
    const Parser = await getParser();
    const parser = new Parser();
    parser.setLanguage(grammar);
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
  }

  const definitions: DefinitionDraft[] = [];
  const imports: ImportDraft[] = [];
  const exports: ExportDraft[] = [];

  try {
    const grammar = await loadGrammar(input.lang);
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
    const importByStmt = new Map<number, ImportScratch>();
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
        // import statement OR re-export (export … from). Group by the enclosing
        // statement so we emit ONE module node per statement (legacy parity).
        const stmt = enclosingStatement(sourceNode);
        const isReExport = stmt.type === 'export_statement';
        let scratch = importByStmt.get(stmt.id);
        if (!scratch) {
          scratch = {
            source: stripQuotes(sourceNode.text),
            statement: stmt,
            span: spanOf(stmt),
            names: [],
            ordinalIndex: stmt.startIndex,
            isReExport,
          };
          importByStmt.set(stmt.id, scratch);
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
    for (const scratch of importByStmt.values()) {
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
    for (const im of importByStmt.values()) {
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
          exports.push({ ordinal, name: ex.name, span: spanOf(enclosingStatement(ex.node)) });
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
    facts,
    attributes: { parseStatus, __tree: tree },
  };
}
