/**
 * Code Map langs batch 2 — GoProvider (provider #5).
 *
 * Owns `.go` (runtime lang `go`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive extraction.
 * Definition subtypes are fixed by the query (struct→class, interface→interface,
 * function/method/constant/variable/package universal). `refine()` carries only
 * what the import query cannot express structurally: Go import paths are quoted
 * string literals, so the captured @import.source is `"pkg/path"` — strip the
 * surrounding quotes to the bare module path.
 *
 * NO exports edges — Go has no export statement (visibility is capitalization;
 * capabilities: T2 = imports). Identity is owned by the CORE finalizer — this
 * provider mints NO ids. The grammar loads through the SHARED engine glue
 * (`loadGrammarWasm`), never a fresh `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const GO_WASM_BASENAME = 'tree-sitter-go.wasm';
const GO_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-go.wasm';
const GO_GRAMMAR_NAME = 'tree-sitter-go';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'go', basename);
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
  grammarForLang: () => loadGrammarWasm(GO_WASM_BASENAME, GO_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => GO_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(GO_WASM_BASENAME, GO_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  enclosingStatementNodeTypes: ['import_declaration'],
  captureMap: [
    { capture: 'definition.package.node', field: 'node', subtype: 'package' },
    { capture: 'definition.package.name', field: 'name' },
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.interface.node', field: 'node', subtype: 'interface' },
    { capture: 'definition.interface.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'definition.variable.node', field: 'node', subtype: 'variable' },
    { capture: 'definition.variable.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['package', 'function', 'method', 'class', 'interface', 'constant', 'variable'],
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

/** Strip the surrounding quotes/backticks from a Go string-literal import path. */
function stripQuotes(s: string): string {
  return s.replace(/^[`"]/, '').replace(/[`"]$/, '');
}

export class GoProvider implements CodeLanguageProvider {
  readonly id = 'go';
  readonly displayName = 'Go';
  readonly languages: readonly CodeLang[] = ['go'];
  readonly extensions: readonly string[] = ['.go'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  langForPath(_p: string): CodeLang {
    return 'go';
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

  /** Drafts-only: strip the quotes from each import path (`"fmt"` → `fmt`). */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    if (draft.imports.length === 0) return draft;
    const imports: ImportDraft[] = draft.imports.map((im) => ({ ...im, source: stripQuotes(im.source) }));
    return { ...draft, imports };
  }
}

export const goProvider = new GoProvider();
