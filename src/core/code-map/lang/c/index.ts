/**
 * Code Map langs batch 2 — CProvider (provider #6).
 *
 * Owns `.c` / `.h` (runtime lang `c`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive extraction.
 * Definition subtypes are fixed by the query: a named C struct maps to `class`
 * (the named aggregate devs search for like a class), a union → `c.union`
 * (provider-namespaced — no universal peer), enum/typedef(→type)/`#define`(→macro)
 * are universal, and `function_definition` → function. The function NAME is nested
 * inside `function_declarator declarator: (identifier)`, wrapped in a
 * `pointer_declarator` per `*` on the return type — the tags query enumerates the
 * 0..3 pointer-depth alternatives (see tags.scm).
 *
 * `refine()` carries only what the import query cannot express structurally: a C
 * `#include` path is either a `<...>` system-lib token or a `"..."` string literal,
 * so the captured @import.source keeps its angle brackets / quotes — strip them to
 * the bare header path. NO exports edges — C has no export statement (capabilities:
 * T2 = imports). Identity is owned by the CORE finalizer — this provider mints NO
 * ids. The grammar loads through the SHARED engine glue (`loadGrammarWasm`), never
 * a fresh `web-tree-sitter` import (trp_8df65ab7).
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

const C_WASM_BASENAME = 'tree-sitter-c.wasm';
const C_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-c.wasm';
const C_GRAMMAR_NAME = 'tree-sitter-c';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'c', basename);
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
  grammarForLang: () => loadGrammarWasm(C_WASM_BASENAME, C_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => C_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(C_WASM_BASENAME, C_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  enclosingStatementNodeTypes: ['preproc_include'],
  captureMap: [
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.c.union.node', field: 'node', subtype: 'c.union' },
    { capture: 'definition.c.union.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.type.node', field: 'node', subtype: 'type' },
    { capture: 'definition.type.name', field: 'name' },
    { capture: 'definition.macro.node', field: 'node', subtype: 'macro' },
    { capture: 'definition.macro.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['function', 'class', 'c.union', 'enum', 'type', 'macro'],
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

/**
 * Strip the wrapping from a C `#include` path token: `<stdio.h>` → `stdio.h`
 * (angle brackets) or `"config.h"` → `config.h` (double quotes). Leaves an
 * already-bare path untouched.
 */
function stripIncludeWrapping(s: string): string {
  if (s.length >= 2 && s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export class CProvider implements CodeLanguageProvider {
  readonly id = 'c';
  readonly displayName = 'C';
  readonly languages: readonly CodeLang[] = ['c'];
  readonly extensions: readonly string[] = ['.c', '.h'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  langForPath(_p: string): CodeLang {
    return 'c';
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

  /** Drafts-only: strip the `<...>`/`"..."` wrapping from each include path. */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    if (draft.imports.length === 0) return draft;
    const imports: ImportDraft[] = draft.imports.map((im) => ({ ...im, source: stripIncludeWrapping(im.source) }));
    return { ...draft, imports };
  }
}

export const cProvider = new CProvider();
