/**
 * Code Map langs batch 2 — RubyProvider (provider #6).
 *
 * Owns `.rb` (runtime lang `ruby`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive extraction.
 *
 * Definitions (verified via dogfood against tree-sitter-ruby):
 *  - `class`  -> class      (name: a `constant`)
 *  - `module` -> namespace  (name: a `constant`; Ruby modules are namespaces/mixins)
 *  - `method` (def)              -> method (uniform capture)
 *  - `singleton_method` (def self.x) -> method (always a member method)
 *  - constant assignment (`FOO = ...`, left is a bare `constant`) -> constant
 *
 * refine() carries what the structural query CANNOT express (mirrors Python's
 * dynamic-language refine):
 *  - a `method` whose enclosing scope is NOT a class/module (a TOP-LEVEL `def`, or a
 *    def nested inside another def/block) -> reclassified `function` (Ruby's
 *    module-level-function analog). A `method` directly in a class/module body stays
 *    `method`. `singleton_method` stays `method` regardless of location.
 *  - import sources: strip the surrounding quotes from the required string
 *    (`'sinatra'` -> `sinatra`). Defensive/idempotent — the query-runtime already
 *    strips quotes; kept to match the Go provider's documented pattern.
 *
 * Imports: Ruby has NO static import statement — `require`/`require_relative` are
 * method CALLS. imports.scm captures those calls (a `#any-of?` predicate limits the
 * match to the require family) and the module node `name` is the required string.
 * Best-effort T2 only: no path resolution (T3 = none). NO exports edges — Ruby has
 * no export statement (capabilities: T1.definitions + T2.imports).
 *
 * Identity is owned by the CORE finalizer — this provider mints NO ids. The grammar
 * loads through the SHARED engine glue (`loadGrammarWasm`), never a fresh
 * `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode } from 'web-tree-sitter';
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

const RUBY_WASM_BASENAME = 'tree-sitter-ruby.wasm';
const RUBY_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-ruby.wasm';
const RUBY_GRAMMAR_NAME = 'tree-sitter-ruby';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'ruby', basename);
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
  grammarForLang: () => loadGrammarWasm(RUBY_WASM_BASENAME, RUBY_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => RUBY_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(RUBY_WASM_BASENAME, RUBY_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  // Ruby has no import statement — the require CALL is the span/ordinal anchor.
  enclosingStatementNodeTypes: ['call'],
  captureMap: [
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.namespace.node', field: 'node', subtype: 'namespace' },
    { capture: 'definition.namespace.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['class', 'namespace', 'method', 'function', 'constant'],
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

/** Strip the surrounding quotes from a required-string import path. */
function stripQuotes(s: string): string {
  return s.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

/** A sourceNode handle the runtime attaches to definition drafts. */
interface DefSourceNode {
  node: TsNode;
  nameNode: TsNode;
}

function isDefSourceNode(v: unknown): v is DefSourceNode {
  return (
    typeof v === 'object' &&
    v !== null &&
    'node' in v &&
    typeof (v as { node?: unknown }).node === 'object'
  );
}

/**
 * True iff `defNode` (a `method`) is a member of a class/module — i.e. directly owned
 * by a class/module body. tree-sitter-ruby nests a def's statements under a
 * `body_statement` whose parent is the enclosing `class`/`module`/`singleton_class`;
 * a TOP-LEVEL def's parent is `program` (no body_statement wrapper), and a def nested
 * in another def/block has a `body_statement` whose parent is that def/block (not a
 * class/module). So a member method is exactly: parent `body_statement` whose parent
 * is `class` | `module` | `singleton_class`.
 */
function isClassOrModuleMember(defNode: TsNode): boolean {
  const owner = defNode.parent;
  if (!owner || owner.type !== 'body_statement') return false;
  const container = owner.parent;
  if (!container) return false;
  return (
    container.type === 'class' ||
    container.type === 'module' ||
    container.type === 'singleton_class'
  );
}

export class RubyProvider implements CodeLanguageProvider {
  readonly id = 'ruby';
  readonly displayName = 'Ruby';
  readonly languages: readonly CodeLang[] = ['ruby'];
  readonly extensions: readonly string[] = ['.rb'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  langForPath(_p: string): CodeLang {
    return 'ruby';
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
   * Drafts-only refinement:
   *  - a `method` def whose enclosing scope is NOT a class/module body -> `function`
   *    (top-level defs + defs nested in another def/block); `singleton_method` and
   *    class/module-body `method`s stay `method`.
   *  - strip the surrounding quotes from each import source (defensive/idempotent).
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const definitions: DefinitionDraft[] = draft.definitions.map((d) => {
      if (d.subtype !== 'method') return d;
      const src = isDefSourceNode(d.sourceNode) ? d.sourceNode : null;
      if (!src) return d;
      // singleton_method (def self.x) is always a member method.
      if (src.node.type === 'singleton_method') return d;
      // A plain `method` (def) is a `function` unless it is a class/module member.
      return isClassOrModuleMember(src.node) ? d : setSubtype(d, 'function');
    });
    const imports: ImportDraft[] =
      draft.imports.length === 0
        ? draft.imports
        : draft.imports.map((im) => ({ ...im, source: stripQuotes(im.source) }));
    return { ...draft, definitions, imports };
  }
}

function setSubtype(d: DefinitionDraft, subtype: NodeSubtype): DefinitionDraft {
  return d.subtype === subtype ? d : { ...d, subtype };
}

export const rubyProvider = new RubyProvider();
