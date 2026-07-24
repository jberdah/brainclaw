/**
 * Code Map langs batch 2 — CSharpProvider (provider #6).
 *
 * Owns `.cs` (runtime lang `csharp`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive extraction.
 * All definition subtypes are fixed by the query (no def reclassification). C# is
 * very Java-like, so this mirrors JavaProvider — but the import shaping is simpler:
 * C# module specifiers are dotted names (qualified_name), NOT string literals, so
 * there is nothing to quote-strip, and there is no wildcard using and no
 * member-split static import. `refine()` carries ONLY what the structural query
 * cannot express: the ALIAS binding of `using X = A.B;` (the module `A.B` is already
 * captured; the alias `X` lives in a sibling `name_equals` node → lift it onto the
 * module's imported names). `using static A.B.C;` needs no refine — the base query
 * already captures the qualified type `A.B.C` as the module source.
 *
 * NO exports edges — C# has no export statement (visibility is modifiers;
 * capabilities: T2 = imports). Identity is owned by the CORE finalizer — this
 * provider mints NO ids. The grammar loads through the SHARED engine glue
 * (`loadGrammarWasm`), never a fresh `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode, Tree } from 'web-tree-sitter';
import type { CodeLang } from '../../types.js';
import type { ExtractionDraft, ImportDraft } from '../../drafts.js';
import { loadGrammarWasm, grammarHashForWasm } from '../../wasm-loader.js';
import { extractWithQueries } from '../query-runtime.js';
import type {
  CodeLanguageProvider,
  ExtractionServices,
  ParserDeclaration,
  ProviderCapabilityDeclaration,
  ProviderExtractInput,
  QueryDeclarations,
  RefineContext,
} from '../provider.js';
import type { ProviderVocabularyDeclaration } from '../../vocabulary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The C# grammar .wasm: dist basename + node_modules devDep fallback spec. */
const CSHARP_WASM_BASENAME = 'tree-sitter-c_sharp.wasm';
const CSHARP_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-c_sharp.wasm';
const CSHARP_GRAMMAR_NAME = 'tree-sitter-c_sharp';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'csharp', basename);
      if (fs.existsSync(fromSrc)) return fs.readFileSync(fromSrc, 'utf-8');
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`code-map: could not locate query asset ${basename} (from ${HERE})`);
}

function sha256(s: string): string {
  return `sha256:${crypto.createHash('sha256').update(s, 'utf-8').digest('hex')}`;
}

const TAGS = readScm('tags.scm');
const IMPORTS = readScm('imports.scm');
const TAGS_HASH = sha256(TAGS);
const IMPORTS_HASH = sha256(IMPORTS);

const parser: ParserDeclaration = {
  grammarForLang: () => loadGrammarWasm(CSHARP_WASM_BASENAME, CSHARP_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => CSHARP_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(CSHARP_WASM_BASENAME, CSHARP_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  // C# using directives are the import statement; C# has no export statement.
  enclosingStatementNodeTypes: ['using_directive'],
  // Every capture mirrors the hard-coded runtime convention and is validated by
  // `assertCaptureMapConforms`. The namespaced csharp.struct/record/delegate are
  // still definition.<subtype>.* captures (subtype = the namespaced value).
  captureMap: [
    { capture: 'definition.namespace.node', field: 'node', subtype: 'namespace' },
    { capture: 'definition.namespace.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.interface.node', field: 'node', subtype: 'interface' },
    { capture: 'definition.interface.name', field: 'name' },
    { capture: 'definition.csharp.struct.node', field: 'node', subtype: 'csharp.struct' },
    { capture: 'definition.csharp.struct.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.csharp.record.node', field: 'node', subtype: 'csharp.record' },
    { capture: 'definition.csharp.record.name', field: 'name' },
    { capture: 'definition.csharp.delegate.node', field: 'node', subtype: 'csharp.delegate' },
    { capture: 'definition.csharp.delegate.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.constructor.node', field: 'node', subtype: 'constructor' },
    { capture: 'definition.constructor.name', field: 'name' },
    { capture: 'definition.property.node', field: 'node', subtype: 'property' },
    { capture: 'definition.property.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'definition.field.node', field: 'node', subtype: 'field' },
    { capture: 'definition.field.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: [
    'namespace',
    'class',
    'interface',
    'csharp.struct',
    'enum',
    'csharp.record',
    'csharp.delegate',
    'method',
    'constructor',
    'property',
    'constant',
    'field',
  ],
  edgeKinds: ['contains', 'defines', 'imports'],
  captureMap: queries.captureMap,
};

const capabilities: ProviderCapabilityDeclaration = {
  tiers: ['T1.definitions', 'T2.imports'],
  proven: {
    'T1.definitions': true,
    'T2.imports': true,
    'T3.import_resolution': false,
    'T4.tests_for': false,
  },
};

/** A span key matching the runtime's `spanOf` (1-based start/end line+col). */
function spanKey(span: { start_line: number; start_col: number; end_line: number; end_col: number }): string {
  return `${span.start_line}:${span.start_col}:${span.end_line}:${span.end_col}`;
}

function spanKeyOfNode(node: TsNode): string {
  return `${node.startPosition.row + 1}:${node.startPosition.column + 1}:${node.endPosition.row + 1}:${node.endPosition.column + 1}`;
}

/** Iterative named-node DFS collecting nodes whose type is in `types`. */
function collectByType(root: TsNode, types: ReadonlySet<string>): TsNode[] {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.has(n.type)) found.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return found;
}

const USING_DIRECTIVE = new Set(['using_directive']);

/**
 * Map each `using X = A.B;` directive's statement span → its alias binding name.
 * The alias lives in a `name_equals` child (`(name_equals (identifier))`); plain
 * and `using static` directives have none and are absent from the map.
 */
function aliasBySpan(tree: Tree): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of collectByType(tree.rootNode, USING_DIRECTIVE)) {
    for (let i = 0; i < dir.namedChildCount; i++) {
      const c = dir.namedChild(i);
      if (c && c.type === 'name_equals') {
        const alias = c.namedChild(0);
        if (alias) out.set(spanKeyOfNode(dir), alias.text);
        break;
      }
    }
  }
  return out;
}

export class CSharpProvider implements CodeLanguageProvider {
  readonly id = 'csharp';
  readonly displayName = 'C#';
  readonly languages: readonly CodeLang[] = ['csharp'];
  readonly extensions: readonly string[] = ['.cs'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  /** `.cs` → `csharp`. */
  langForPath(_p: string): CodeLang {
    return 'csharp';
  }

  async extractDraft(input: ProviderExtractInput, _services: ExtractionServices): Promise<ExtractionDraft> {
    return extractWithQueries({
      providerId: this.id,
      lang: input.lang,
      source: input.source,
      sizeBytes: input.sizeBytes,
      maxParseFileBytes: input.maxParseFileBytes,
      maxQueryWaitMs: input.maxQueryWaitMs,
      path: input.path,
      grammarForLang: this.parser.grammarForLang,
      tagsSource: TAGS,
      tagsHash: TAGS_HASH,
      importsSource: IMPORTS,
      importsHash: IMPORTS_HASH,
      enclosingStatementNodeTypes: queries.enclosingStatementNodeTypes,
    });
  }

  /**
   * Drafts-only refinement: lift each `using X = A.B;` alias binding (`X`) onto the
   * corresponding module node's imported names. The module source `A.B` is already
   * captured structurally; plain and `using static` directives are unchanged.
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const tree = draft.attributes?.__tree as Tree | undefined | null;
    if (!tree || draft.imports.length === 0) return draft;
    const aliases = aliasBySpan(tree);
    if (aliases.size === 0) return draft;

    const imports: ImportDraft[] = draft.imports.map((im) => {
      const alias = aliases.get(spanKey(im.span));
      return alias ? { ...im, importedNames: [alias] } : im;
    });
    return { ...draft, imports };
  }
}

/** Singleton instance for registry wiring. */
export const csharpProvider = new CSharpProvider();
