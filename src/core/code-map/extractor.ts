/**
 * Code Map extractor (spec §5.4, §5.5, §6.2, §7 step 6).
 *
 * Parses a single JS/TS/TSX source into P0 nodes (file | module | symbol) and
 * edges (contains | imports | exports | defines) with Tree-sitter WASM.
 *
 * Robustness contract (spec §5.3):
 *  - Oversized supported files (> max_parse_file_bytes) get a `skipped_too_large`
 *    shard: a single file node, a diagnostic, NO symbol extraction.
 *  - A syntactically broken file yields `parse_error` + diagnostics — never
 *    throws out of extraction (so refresh cannot crash on one bad file).
 *
 * React heuristics (spec §5.4 component/hook subtypes):
 *  - component: a function/arrow/const whose name is PascalCase AND whose body
 *    returns JSX (jsx_element / jsx_self_closing_element / jsx_fragment).
 *  - hook: a function/arrow/const whose name matches /^use[A-Z0-9]/.
 */
import crypto from 'node:crypto';
// type-only import — fully erased at compile, so web-tree-sitter is NOT in the
// runtime import graph here. The Parser *value* is obtained lazily via
// getParser() (dynamic import inside the parse path) — see wasm-loader.ts FIX 1.
import type { Node as TsNode, Tree } from 'web-tree-sitter';
import { edgeId, fileId, nodeId } from './ids.js';
import { getParser, loadGrammar } from './wasm-loader.js';
import type { CodeEdge, CodeLang, CodeNode, NodeSubtype, Span } from './types.js';

export interface ExtractInput {
  projectId: string;
  /** Normalized POSIX relative path (store identity). */
  path: string;
  lang: CodeLang;
  source: string;
  sizeBytes: number;
  maxParseFileBytes: number;
}

export interface ExtractResult {
  parseStatus: 'parsed' | 'skipped_too_large' | 'parse_error' | 'skipped_unsupported';
  nodes: CodeNode[];
  edges: CodeEdge[];
  diagnostics: Array<Record<string, unknown>>;
}

const HOOK_RE = /^use[A-Z0-9]/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;

function spanOf(node: TsNode): Span {
  return {
    start_line: node.startPosition.row + 1,
    start_col: node.startPosition.column + 1,
    end_line: node.endPosition.row + 1,
    end_col: node.endPosition.column + 1,
  };
}

function fileNodeId(projectId: string, path: string, lang: CodeLang): string {
  return `file:${nodeId({ projectId, path, lang, kind: 'file', subtype: null, name: path, startLine: 0, startCol: 0 })}`;
}

function symId(
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

/** Walk to find the first descendant JSX node (cheap bounded check for components). */
function returnsJsx(node: TsNode): boolean {
  const stack: TsNode[] = [node];
  let budget = 4000;
  while (stack.length > 0 && budget-- > 0) {
    const n = stack.pop()!;
    const t = n.type;
    if (t === 'jsx_element' || t === 'jsx_self_closing_element' || t === 'jsx_fragment') return true;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return false;
}

function classifySubtype(name: string, valueNode: TsNode | null, isFunctionLike: boolean): NodeSubtype {
  if (HOOK_RE.test(name)) return 'hook';
  if (isFunctionLike && PASCAL_RE.test(name) && valueNode && returnsJsx(valueNode)) return 'component';
  return isFunctionLike ? 'function' : 'variable';
}

interface Ctx {
  input: ExtractInput;
  fileId: string;
  fileNode: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  /** symbol name -> node id, for marking exports. */
  byName: Map<string, string>;
}

function addSymbol(
  ctx: Ctx,
  subtype: NodeSubtype,
  name: string,
  span: Span,
  exported: boolean,
): string {
  const { input } = ctx;
  const id = symId(input.projectId, input.path, input.lang, subtype, name, span);
  ctx.nodes.push({
    id,
    kind: 'symbol',
    subtype,
    lang: input.lang,
    name,
    path: input.path,
    span,
    exported,
    confidence: 1.0,
    related_memory_ids: [],
    imported_names: [],
  });
  ctx.byName.set(name, id);
  // contains: file -> symbol ; defines: file -> symbol
  ctx.edges.push({
    id: edgeId({ projectId: input.projectId, from: ctx.fileNode, to: id, kind: 'contains' }),
    from: ctx.fileNode,
    to: id,
    kind: 'contains',
    confidence: 1.0,
    source: { path: input.path, line: span.start_line },
  });
  ctx.edges.push({
    id: edgeId({ projectId: input.projectId, from: ctx.fileNode, to: id, kind: 'defines' }),
    from: ctx.fileNode,
    to: id,
    kind: 'defines',
    confidence: 1.0,
    source: { path: input.path, line: span.start_line },
  });
  return id;
}

/** Find a named child by tree-sitter field name, tolerating absence. */
function childForField(node: TsNode, field: string): TsNode | null {
  try {
    return node.childForFieldName(field);
  } catch {
    return null;
  }
}

function handleFunctionDeclaration(ctx: Ctx, node: TsNode, exported: boolean): void {
  const nameNode = childForField(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const span = spanOf(node);
  const subtype = classifySubtype(name, node, true);
  addSymbol(ctx, subtype, name, span, exported);
}

function handleClassDeclaration(ctx: Ctx, node: TsNode, exported: boolean): void {
  const nameNode = childForField(node, 'name');
  if (!nameNode) return;
  addSymbol(ctx, 'class', nameNode.text, spanOf(node), exported);
}

function handleTypeAlias(ctx: Ctx, node: TsNode, exported: boolean): void {
  const nameNode = childForField(node, 'name');
  if (!nameNode) return;
  addSymbol(ctx, 'type', nameNode.text, spanOf(node), exported);
}

function handleInterface(ctx: Ctx, node: TsNode, exported: boolean): void {
  const nameNode = childForField(node, 'name');
  if (!nameNode) return;
  addSymbol(ctx, 'interface', nameNode.text, spanOf(node), exported);
}

/** const/let/var declarations: each declarator may be a function/component/hook/variable. */
function handleLexicalDeclaration(ctx: Ctx, node: TsNode, exported: boolean): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const decl = node.namedChild(i);
    if (!decl || decl.type !== 'variable_declarator') continue;
    const nameNode = childForField(decl, 'name');
    if (!nameNode || nameNode.type !== 'identifier') continue;
    const name = nameNode.text;
    const value = childForField(decl, 'value');
    const isFnLike =
      !!value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function');
    const subtype = classifySubtype(name, value, isFnLike);
    addSymbol(ctx, subtype, name, spanOf(node), exported);
  }
}

/** Pull the imported binding names out of an `import_clause` (spec §5.7 imported[]). */
function importedNamesFromClause(clause: TsNode | null): string[] {
  if (!clause) return [];
  const names: string[] = [];
  for (let i = 0; i < clause.namedChildCount; i++) {
    const c = clause.namedChild(i);
    if (!c) continue;
    if (c.type === 'identifier') {
      // `import def from 'm'` — default binding.
      names.push('default');
    } else if (c.type === 'namespace_import') {
      // `import * as ns from 'm'`
      names.push('*');
    } else if (c.type === 'named_imports') {
      // `import { a, b as c } from 'm'` — record the source-side name (field `name`).
      for (let j = 0; j < c.namedChildCount; j++) {
        const spec = c.namedChild(j);
        if (!spec || spec.type !== 'import_specifier') continue;
        const nameNode = childForField(spec, 'name') ?? spec.namedChild(0);
        if (nameNode) names.push(nameNode.text);
      }
    }
  }
  return names;
}

/**
 * Add a `module` node + `imports` edge for a module specifier. `importedNames`
 * carries the named bindings (spec §5.7 imported[]). Shared by both real imports
 * and re-export sources (`export ... from 'm'`).
 */
function addModule(ctx: Ctx, module: string, span: Span, importedNames: string[]): void {
  const { input } = ctx;
  const moduleNodeId = `module:${nodeId({
    projectId: input.projectId,
    path: input.path,
    lang: input.lang,
    kind: 'module',
    subtype: null,
    name: module,
    startLine: span.start_line,
    startCol: span.start_col,
  })}`;
  ctx.nodes.push({
    id: moduleNodeId,
    kind: 'module',
    subtype: null,
    lang: input.lang,
    name: module,
    path: input.path,
    span,
    exported: false,
    confidence: 1.0,
    related_memory_ids: [],
    imported_names: importedNames,
  });
  ctx.edges.push({
    id: edgeId({ projectId: input.projectId, from: ctx.fileNode, to: moduleNodeId, kind: 'imports' }),
    from: ctx.fileNode,
    to: moduleNodeId,
    kind: 'imports',
    confidence: 1.0,
    source: { path: input.path, line: span.start_line },
  });
}

function moduleSpecifier(sourceNode: TsNode | null): string | null {
  if (!sourceNode) return null;
  const module = sourceNode.text.replace(/^['"`]|['"`]$/g, '');
  return module || null;
}

function handleImport(ctx: Ctx, node: TsNode): void {
  const module = moduleSpecifier(childForField(node, 'source'));
  if (!module) return;
  const clause = node.namedChild(0)?.type === 'import_clause' ? node.namedChild(0) : null;
  addModule(ctx, module, spanOf(node), importedNamesFromClause(clause));
}

/** Mark a named symbol as exported, or add an `export` symbol + exports edge. */
function markOrAddExport(ctx: Ctx, name: string, span: Span): void {
  const existing = ctx.byName.get(name);
  if (existing) {
    const n = ctx.nodes.find((x) => x.id === existing);
    if (n) n.exported = true;
    ctx.edges.push({
      id: edgeId({ projectId: ctx.input.projectId, from: ctx.fileNode, to: existing, kind: 'exports' }),
      from: ctx.fileNode,
      to: existing,
      kind: 'exports',
      confidence: 1.0,
      source: { path: ctx.input.path, line: span.start_line },
    });
    return;
  }
  // Re-export / export of an external/unknown binding: add a dedicated `export` symbol.
  const id = addSymbol(ctx, 'export', name, span, true);
  ctx.edges.push({
    id: edgeId({ projectId: ctx.input.projectId, from: ctx.fileNode, to: id, kind: 'exports' }),
    from: ctx.fileNode,
    to: id,
    kind: 'exports',
    confidence: 1.0,
    source: { path: ctx.input.path, line: span.start_line },
  });
}

function handleExportStatement(ctx: Ctx, node: TsNode): void {
  const span = spanOf(node);

  // Re-export with a source module: `export { a } from 'm'` / `export * from 'm'`.
  // Record the source as an imported module so the imports index sees it (spec
  // §5.7). The named bindings (export_clause) are the re-exported names.
  const reExportSource = moduleSpecifier(childForField(node, 'source'));
  if (reExportSource) {
    const names: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child || child.type !== 'export_clause') continue;
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (!spec || spec.type !== 'export_specifier') continue;
        const nameNode = childForField(spec, 'name') ?? spec.namedChild(0);
        if (nameNode) names.push(nameNode.text);
      }
    }
    if (names.length === 0) names.push('*'); // `export * from 'm'`
    addModule(ctx, reExportSource, span, names);
    return; // a re-export defines no local symbol — do not also emit an `export` node.
  }

  // `export { a, b }` clause
  let hasDeclaration = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const t = child.type;
    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      handleFunctionDeclaration(ctx, child, true);
      hasDeclaration = true;
    } else if (t === 'class_declaration') {
      handleClassDeclaration(ctx, child, true);
      hasDeclaration = true;
    } else if (t === 'type_alias_declaration') {
      handleTypeAlias(ctx, child, true);
      hasDeclaration = true;
    } else if (t === 'interface_declaration') {
      handleInterface(ctx, child, true);
      hasDeclaration = true;
    } else if (t === 'lexical_declaration' || t === 'variable_declaration') {
      handleLexicalDeclaration(ctx, child, true);
      hasDeclaration = true;
    } else if (t === 'export_clause') {
      // export { a, b as c }
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (!spec || spec.type !== 'export_specifier') continue;
        const nameNode = childForField(spec, 'name') ?? spec.namedChild(0);
        if (nameNode) markOrAddExport(ctx, nameNode.text, span);
      }
      hasDeclaration = true;
    }
  }
  // `export default <identifier>` — best-effort link if it names a known symbol.
  if (!hasDeclaration) {
    const last = node.namedChild(node.namedChildCount - 1);
    if (last && last.type === 'identifier') {
      markOrAddExport(ctx, last.text, span);
    }
  }
}

function topLevelStatements(tree: Tree): TsNode[] {
  const root = tree.rootNode;
  const out: TsNode[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Parse + extract a single file. Never throws on parse failure — returns a
 * `parse_error` result with diagnostics instead (spec §5.3).
 */
export async function extractFile(input: ExtractInput): Promise<ExtractResult> {
  const fid = fileId(input.projectId, input.path);
  void fid; // file_id is computed by the caller; kept for symmetry/debugging.
  const fileNode = fileNodeId(input.projectId, input.path, input.lang);

  // Oversized: file node only, no parse (spec §5.3).
  if (input.sizeBytes > input.maxParseFileBytes) {
    return {
      parseStatus: 'skipped_too_large',
      nodes: [makeFileNode(input, fileNode)],
      edges: [],
      diagnostics: [
        {
          code: 'skipped_too_large',
          message: `file ${input.sizeBytes} bytes exceeds max_parse_file_bytes ${input.maxParseFileBytes}`,
        },
      ],
    };
  }

  let tree: Tree;
  try {
    const grammar = await loadGrammar(input.lang);
    const Parser = await getParser();
    const parser = new Parser();
    parser.setLanguage(grammar);
    const parsed = parser.parse(input.source);
    if (!parsed) {
      return parseErrorResult(input, fileNode, 'parser returned null');
    }
    tree = parsed;
  } catch (err) {
    return parseErrorResult(input, fileNode, err instanceof Error ? err.message : String(err));
  }

  const ctx: Ctx = {
    input,
    fileId: fid,
    fileNode,
    nodes: [makeFileNode(input, fileNode)],
    edges: [],
    byName: new Map(),
  };

  const diagnostics: Array<Record<string, unknown>> = [];

  try {
    for (const stmt of topLevelStatements(tree)) {
      const t = stmt.type;
      switch (t) {
        case 'function_declaration':
        case 'generator_function_declaration':
          handleFunctionDeclaration(ctx, stmt, false);
          break;
        case 'class_declaration':
          handleClassDeclaration(ctx, stmt, false);
          break;
        case 'type_alias_declaration':
          handleTypeAlias(ctx, stmt, false);
          break;
        case 'interface_declaration':
          handleInterface(ctx, stmt, false);
          break;
        case 'lexical_declaration':
        case 'variable_declaration':
          handleLexicalDeclaration(ctx, stmt, false);
          break;
        case 'import_statement':
          handleImport(ctx, stmt);
          break;
        case 'export_statement':
          handleExportStatement(ctx, stmt);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    diagnostics.push({
      code: 'extraction_error',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // A tree with syntax errors still extracts what it can, but we flag it.
  const parseStatus: ExtractResult['parseStatus'] = tree.rootNode.hasError
    ? 'parse_error'
    : 'parsed';
  if (parseStatus === 'parse_error') {
    diagnostics.push({ code: 'parse_error', message: 'tree contains syntax errors' });
  }

  // Free the native tree handle promptly.
  try {
    tree.delete();
  } catch {
    /* best effort */
  }

  return { parseStatus, nodes: ctx.nodes, edges: ctx.edges, diagnostics };
}

function makeFileNode(input: ExtractInput, fileNode: string): CodeNode {
  return {
    id: fileNode,
    kind: 'file',
    subtype: null,
    lang: input.lang,
    name: input.path,
    path: input.path,
    span: null,
    exported: false,
    confidence: 1.0,
    related_memory_ids: [],
    imported_names: [],
  };
}

function parseErrorResult(input: ExtractInput, fileNode: string, message: string): ExtractResult {
  return {
    parseStatus: 'parse_error',
    nodes: [makeFileNode(input, fileNode)],
    edges: [],
    diagnostics: [{ code: 'parse_error', message }],
  };
}

/** sha256 of file contents (file_hash on the shard). */
export function hashContent(source: string): string {
  return `sha256:${crypto.createHash('sha256').update(source, 'utf-8').digest('hex')}`;
}

/** Map a file extension to a Code Map language, or null if unsupported. */
export function langForExtension(ext: string): CodeLang | null {
  switch (ext.toLowerCase()) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.jsx':
      return 'tsx'; // tsx grammar handles jsx
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    default:
      return null;
  }
}
