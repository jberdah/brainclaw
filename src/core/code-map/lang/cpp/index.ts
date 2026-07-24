/**
 * Code Map langs batch 2 — CppProvider (C++).
 *
 * Owns `.cpp`/`.cc`/`.cxx`/`.hpp`/`.hh`/`.h` (runtime lang `cpp`). tree-sitter-cpp
 * is a superset of tree-sitter-c, so the C `#include`/function shapes apply and the
 * curated `tags.scm`/`imports.scm` (this dir) add the C++-only constructs. Definition
 * subtypes are fixed by the query (class_specifier/struct_specifier→class,
 * enum_specifier→enum, namespace_definition→namespace, function_declarator→
 * function/method, preproc_def(_function)→macro, typedef/using→type — all universal).
 * `refine()` carries only what the import query cannot express structurally: a C++
 * include path is a delimited literal (`<vector>` / `"config.h"`), so strip the
 * surrounding `<>`/`"` to the bare path.
 *
 * `.h` is AMBIGUOUS C/C++: this provider claims `.h` at priority 0, and the C
 * provider may claim it too — the registry's deterministic collision order decides
 * the winner; core is NOT special-cased here.
 *
 * NO exports edges — C++ has no export statement (visibility is
 * access-specifiers/headers; capabilities: T2 = imports). Identity is owned by the
 * CORE finalizer — this provider mints NO ids. The grammar loads through the SHARED
 * engine glue (`loadGrammarWasm`), never a fresh `web-tree-sitter` import (trp_8df65ab7).
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

const CPP_WASM_BASENAME = 'tree-sitter-cpp.wasm';
const CPP_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-cpp.wasm';
const CPP_GRAMMAR_NAME = 'tree-sitter-cpp';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'cpp', basename);
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
  grammarForLang: () => loadGrammarWasm(CPP_WASM_BASENAME, CPP_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => CPP_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(CPP_WASM_BASENAME, CPP_WASM_NODE_MODULES_SPEC),
};

const queries: QueryDeclarations = {
  tags: { name: 'tags', sourceForLang: () => TAGS, hashForLang: () => TAGS_HASH },
  imports: { name: 'imports', sourceForLang: () => IMPORTS, hashForLang: () => IMPORTS_HASH },
  enclosingStatementNodeTypes: ['preproc_include'],
  captureMap: [
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.namespace.node', field: 'node', subtype: 'namespace' },
    { capture: 'definition.namespace.name', field: 'name' },
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.macro.node', field: 'node', subtype: 'macro' },
    { capture: 'definition.macro.name', field: 'name' },
    { capture: 'definition.type.node', field: 'node', subtype: 'type' },
    { capture: 'definition.type.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['class', 'enum', 'namespace', 'function', 'method', 'macro', 'type'],
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

/** Strip the surrounding delimiters from a C++ include path (`<vector>`/`"a.h"`). */
function stripIncludeDelimiters(s: string): string {
  return s.replace(/^[<"]/, '').replace(/[>"]$/, '');
}

export class CppProvider implements CodeLanguageProvider {
  readonly id = 'cpp';
  readonly displayName = 'C++';
  readonly languages: readonly CodeLang[] = ['cpp'];
  // `.h` is ambiguous C/C++; claimed at priority 0 and resolved by the registry's
  // deterministic collision order if the C provider also claims it (no core special-case).
  readonly extensions: readonly string[] = ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  langForPath(_p: string): CodeLang {
    return 'cpp';
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

  /** Drafts-only: strip the delimiters from each include path (`<vector>` → `vector`). */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    if (draft.imports.length === 0) return draft;
    const imports: ImportDraft[] = draft.imports.map((im) => ({ ...im, source: stripIncludeDelimiters(im.source) }));
    return { ...draft, imports };
  }
}

export const cppProvider = new CppProvider();
