/**
 * Code Map langs batch 2 — RustProvider (provider #6).
 *
 * Owns `.rs` (runtime lang `rust`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive extraction.
 * Definition subtypes are fixed by the query (struct→class, enum/function/constant/
 * type/macro/namespace universal, `trait`→namespaced `rust.trait`). Rust methods are
 * `function_item` nodes nested in an impl/trait body — the SAME node type as a free
 * `fn` — so v1 maps ALL `function_item`→function (no `method` subtype; tree-sitter
 * can't express "not inside an impl").
 *
 * NO `refine()` — Rust `use` paths are bare `a::b::c` (no quotes to strip), and the
 * common use-tree shapes (group `{a,b}`, `as` alias, `*` wildcard) expand
 * STRUCTURALLY in imports.scm via the runtime's per-`@import.source`-node grouping.
 *
 * NO exports edges — `pub use` re-export modelling is deferred (capabilities: T2 =
 * imports). Identity is owned by the CORE finalizer — this provider mints NO ids.
 * The grammar loads through the SHARED engine glue (`loadGrammarWasm`), never a
 * fresh `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodeLang } from '../../types.js';
import type { ExtractionDraft } from '../../drafts.js';
import { loadGrammarWasm, grammarHashForWasm } from '../../wasm-loader.js';
import { extractWithQueries } from '../query-runtime.js';
import type {
  CodeLanguageProvider,
  ExtractionServices,
  ParserDeclaration,
  ProviderCapabilityDeclaration,
  ProviderExtractInput,
  QueryDeclarations,
} from '../provider.js';
import type { ProviderVocabularyDeclaration } from '../../vocabulary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUST_WASM_BASENAME = 'tree-sitter-rust.wasm';
const RUST_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-rust.wasm';
const RUST_GRAMMAR_NAME = 'tree-sitter-rust';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'rust', basename);
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
  grammarForLang: () => loadGrammarWasm(RUST_WASM_BASENAME, RUST_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => RUST_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(RUST_WASM_BASENAME, RUST_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  enclosingStatementNodeTypes: ['use_declaration'],
  captureMap: [
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.rust.trait.node', field: 'node', subtype: 'rust.trait' },
    { capture: 'definition.rust.trait.name', field: 'name' },
    { capture: 'definition.namespace.node', field: 'node', subtype: 'namespace' },
    { capture: 'definition.namespace.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'definition.type.node', field: 'node', subtype: 'type' },
    { capture: 'definition.type.name', field: 'name' },
    { capture: 'definition.macro.node', field: 'node', subtype: 'macro' },
    { capture: 'definition.macro.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
    { capture: 'import.named.name', field: 'name' },
    { capture: 'import.namespace.name', field: 'name' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['function', 'class', 'enum', 'rust.trait', 'namespace', 'constant', 'type', 'macro'],
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

export class RustProvider implements CodeLanguageProvider {
  readonly id = 'rust';
  readonly displayName = 'Rust';
  readonly languages: readonly CodeLang[] = ['rust'];
  readonly extensions: readonly string[] = ['.rs'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  langForPath(_p: string): CodeLang {
    return 'rust';
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
}

export const rustProvider = new RustProvider();
