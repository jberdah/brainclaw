/**
 * Code Map langs#3-4 — PhpProvider (provider #3; cadrage v2 §5, dec#113).
 *
 * Owns `.php` (runtime lang `php`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive structural
 * extraction. `refine()` carries what the tree-sitter queries CANNOT express
 * (all provider-local, drafts-only):
 *  - `__construct` (grammar node `method_declaration`) → subtype `constructor`
 *    (Codex R1: PHP has a language-level constructor; collapse into `method` would
 *    lose that distinction). Other methods/magic methods stay `method`.
 *  - property names: the grammar's `variable_name` node text includes the leading
 *    `$` (`$id`); the symbol name is `id` (how the property is referenced) → strip.
 *  - GROUP use (`use A\{B, C as Bee}`): the query captures each clause's leaf name
 *    (`B`, `C`) because NO single tree node carries the full `A\B` (Codex R1). We
 *    walk the retained tree, find each group-use statement's prefix (`A`), and
 *    prepend it to the leaf-name import drafts at that statement's span → full
 *    source paths `A\B`, `A\C` (aliases already dropped by the query).
 *
 * NO exports edges — PHP `use` is modeled as module imports; there is no export
 * statement (capabilities: T2 = imports).
 *
 * Identity is owned by the CORE finalizer — this provider mints NO ids. The grammar
 * is loaded through the SHARED engine glue (`loadGrammarWasm`), NEVER a fresh
 * `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode, Tree } from 'web-tree-sitter';
import type { CodeLang, NodeSubtype } from '../../types.js';
import type { ExtractionDraft, DefinitionDraft, ImportDraft } from '../../drafts.js';
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

/** The php grammar .wasm: dist basename + node_modules devDep fallback spec. */
const PHP_WASM_BASENAME = 'tree-sitter-php.wasm';
const PHP_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-php.wasm';
const PHP_GRAMMAR_NAME = 'tree-sitter-php';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  // Published / dist runtime: this module is dist/core/code-map/lang/php/index.js
  // and the build copies the .scm assets alongside it (copy-code-map-wasm.mjs).
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  // From-source / dist-test fallback: tsc emits to dist[-test]/... but does NOT copy
  // .scm, so walk up to the repo root (the dir holding package.json) and read the
  // curated asset from src/core/code-map/lang/php/.
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'php', basename);
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

// Load the curated query assets once at module init.
const TAGS = readScm('tags.scm');
const IMPORTS = readScm('imports.scm');

const TAGS_HASH = sha256(TAGS);
const IMPORTS_HASH = sha256(IMPORTS);

const parser: ParserDeclaration = {
  grammarForLang: () => loadGrammarWasm(PHP_WASM_BASENAME, PHP_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => PHP_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(PHP_WASM_BASENAME, PHP_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: {
    name: 'tags',
    sourceForLang: () => TAGS,
    hashForLang: () => TAGS_HASH,
  },
  imports: {
    name: 'imports',
    sourceForLang: () => IMPORTS,
    hashForLang: () => IMPORTS_HASH,
  },
  // PHP `use` declarations are the import statement; PHP has no export statement.
  enclosingStatementNodeTypes: ['namespace_use_declaration'],
  // P1b §3.4 / cadrage: every capture mirrors the hard-coded runtime convention and
  // is validated by `assertCaptureMapConforms`. PHP invents none beyond the
  // namespaced `php.trait` subtype (still a definition.<subtype>.* capture).
  captureMap: [
    { capture: 'definition.namespace.node', field: 'node', subtype: 'namespace' },
    { capture: 'definition.namespace.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.interface.node', field: 'node', subtype: 'interface' },
    { capture: 'definition.interface.name', field: 'name' },
    { capture: 'definition.php.trait.node', field: 'node', subtype: 'php.trait' },
    { capture: 'definition.php.trait.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'definition.property.node', field: 'node', subtype: 'property' },
    { capture: 'definition.property.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: [
    'namespace',
    'class',
    'interface',
    'php.trait',
    'enum',
    'function',
    'method',
    'constructor',
    'constant',
    'property',
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

/** Build a span key matching the runtime's `spanOf` (1-based start/end line+col). */
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

const USE_DECL = new Set(['namespace_use_declaration']);

/**
 * For each GROUP use statement (a `namespace_use_declaration` that contains a
 * `namespace_use_group`), map its statement span → the group PREFIX (the direct
 * `namespace_name` child, e.g. `App\Util`). The runtime emitted one import draft
 * per group leaf (sources are the bare leaf names) at that statement's span;
 * refine prepends `prefix\` to each.
 */
function groupPrefixBySpan(tree: Tree): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of collectByType(tree.rootNode, USE_DECL)) {
    let group: TsNode | null = null;
    let prefix: TsNode | null = null;
    for (let i = 0; i < decl.namedChildCount; i++) {
      const c = decl.namedChild(i);
      if (!c) continue;
      if (c.type === 'namespace_use_group') group = c;
      else if (c.type === 'namespace_name' && !prefix) prefix = c;
    }
    if (group && prefix) out.set(spanKeyOfNode(decl), prefix.text);
  }
  return out;
}

export class PhpProvider implements CodeLanguageProvider {
  readonly id = 'php';
  readonly displayName = 'PHP';
  readonly languages: readonly CodeLang[] = ['php'];
  readonly extensions: readonly string[] = ['.php'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  /** `.php` → `php`. */
  langForPath(_p: string): CodeLang {
    return 'php';
  }

  async extractDraft(
    input: ProviderExtractInput,
    _services: ExtractionServices,
  ): Promise<ExtractionDraft> {
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
   * Drafts-only refinement (cadrage v2 §5):
   *  - definitions: `__construct` method → constructor; property name `$x` → `x`.
   *  - imports: synthesize full group-use source paths by prepending the prefix.
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const definitions: DefinitionDraft[] = draft.definitions.map((d) => {
      if (d.subtype === 'method' && d.name === '__construct') {
        return { ...d, subtype: 'constructor' as NodeSubtype };
      }
      if (d.subtype === 'property' && d.name.startsWith('$')) {
        return { ...d, name: d.name.slice(1) };
      }
      return d;
    });

    let imports: ImportDraft[] = draft.imports;
    const tree = draft.attributes?.__tree as Tree | undefined | null;
    if (tree) {
      const prefixBySpan = groupPrefixBySpan(tree);
      if (prefixBySpan.size > 0) {
        imports = draft.imports.map((im) => {
          const key = `${im.span.start_line}:${im.span.start_col}:${im.span.end_line}:${im.span.end_col}`;
          const prefix = prefixBySpan.get(key);
          // A group statement only ever produced group-leaf imports at its span;
          // a comma/simple `use` is a different statement (different span).
          return prefix ? { ...im, source: `${prefix}\\${im.source}` } : im;
        });
      }
    }

    return { ...draft, definitions, imports };
  }
}

/** Singleton instance for registry wiring. */
export const phpProvider = new PhpProvider();
