/**
 * Code Map P1a — CodeLanguageProvider / CodeLanguageRegistry interfaces (spec §4).
 *
 * A provider declares WHICH languages it owns (by extension + runtime CodeLang),
 * the parser/query/vocabulary/capability assets it carries, and HOW to turn a
 * source file into an id-free {@link ExtractionDraft}. Providers NEVER mint final
 * ids or `CodeNode`/`CodeEdge` objects — that is the CORE finalizer's job
 * (dec#108 #1). `extractFile` itself lives on the CORE (`core.ts`), not here
 * (Grok v2 HIGH #1 / Codex P0 #1).
 *
 * `resolveImport` is DECLARED but never called in P1a (import resolution EXECUTION
 * is P1c) — it pins the shape so P1c is additive.
 */
import type { CodeLang, CodeNode, Span } from '../types.js';
import type { CaptureMapping, ProviderVocabularyDeclaration } from '../vocabulary.js';
import type { ExtractionDraft } from '../drafts.js';

/** Capability tiers a provider can prove against its fixtures (spec §4). */
export type CapabilityTier =
  | 'T1.definitions'
  | 'T2.imports'
  | 'T3.import_resolution'
  | 'T4.tests_for';

/**
 * Input handed to a provider's `extractDraft`. Mirrors the CORE `ExtractInput`
 * minus the bits the provider does not need (it never mints ids), plus the
 * resolved runtime `lang` for the path.
 */
export interface ProviderExtractInput {
  readonly projectId: string;
  /** Normalized POSIX relative path (store identity). */
  readonly path: string;
  /** Runtime language resolved via {@link CodeLanguageProvider.langForPath}. */
  readonly lang: CodeLang;
  readonly source: string;
  readonly sizeBytes: number;
  readonly maxParseFileBytes: number;
  /** Bounds parse + query execution (NOT refine/finalize). */
  readonly maxQueryWaitMs?: number;
}

/**
 * Per-language parser declaration. `grammarForLang` returns an opaque handle the
 * runtime feeds to the engine; `grammarVersion`/`grammarHash` feed freshness.
 */
export interface ParserDeclaration {
  /** Resolve the grammar handle for a runtime lang (async — grammar load is lazy). */
  grammarForLang(lang: CodeLang): Promise<unknown>;
  /** Stable grammar name per lang (e.g. `tree-sitter-typescript`). */
  grammarNameForLang(lang: CodeLang): string;
  /** sha256 of the grammar .wasm per lang (freshness input). */
  grammarHashForLang(lang: CodeLang): string;
}

/** A single query asset (tags / imports) + its content hash (freshness input). */
export interface QueryAssetDeclaration {
  /** Logical asset name (`tags` | `imports`). */
  readonly name: 'tags' | 'imports';
  /** The query source. For grammar subsets a provider may carry per-lang variants. */
  sourceForLang(lang: CodeLang): string;
  /** sha256 of the (per-lang) query source — feeds `configHashInputs`. */
  hashForLang(lang: CodeLang): string;
}

/**
 * The provider's query assets + the capture→draft map the generic runtime uses.
 */
export interface QueryDeclarations {
  readonly tags: QueryAssetDeclaration;
  readonly imports: QueryAssetDeclaration;
  /** Capture-name → draft-field map (spec §7 captureMap). */
  readonly captureMap: readonly CaptureMapping[];
  /**
   * Grammar node types that count as the enclosing import/export STATEMENT for
   * import span/ordinal anchoring (cadrage §3 / Codex R1 langs#3-4). PROVIDER-LOCAL:
   * the generic runtime uses ONLY this set for a file and never derives it from a
   * central registry. Include BOTH import and export statement node types where the
   * language has them. Examples: JS/TS `['import_statement','export_statement']`;
   * Python `['import_statement','import_from_statement']`; PHP
   * `['namespace_use_declaration']`; Java `['import_declaration']`.
   */
  readonly enclosingStatementNodeTypes: readonly string[];
}

/** Per-tier capability declaration; `proven` = a fixture demonstrates it. */
export interface ProviderCapabilityDeclaration {
  readonly tiers: readonly CapabilityTier[];
  readonly proven: Readonly<Record<CapabilityTier, boolean>>;
}

/** Context handed to `refine()` — drafts-only mutation (spec §4 refine semantics). */
export interface RefineContext {
  readonly input: ProviderExtractInput;
  /** Runtime language for the file. */
  readonly lang: CodeLang;
}

/** Services the CORE injects into `extractDraft` (engine seams, kept minimal in P1a). */
export interface ExtractionServices {
  /** No-op marker today; reserved so P1b/P1c can inject resolvers without a signature break. */
  readonly version: string;
}

/**
 * A P1c import-resolution request. `source`/`fromPath` drive file-level (v1)
 * resolution; `importedNames` + `span` are carried NOW (already on the module node)
 * so symbol-level (B) is additive — no request-contract rewrite for
 * `import {foo as bar}` / `from x import y` / default / namespace (Codex R1 #3).
 */
export interface ImportResolutionRequest {
  /** The module specifier as written (e.g. `./utils`, `react`, `app.models.user`). */
  readonly source: string;
  /** Project-relative POSIX path of the importing file. */
  readonly fromPath: string;
  /** Source-side imported binding names (default→"default", namespace→"*"). For B. */
  readonly importedNames: readonly string[];
  /** The import statement span (the module node's identity span). For B + diagnostics. */
  readonly span?: Span;
}

/**
 * Pure project resolver services injected into `resolveImport` (Codex R1 #3/#5): a
 * provider does PATH LOGIC ONLY — it never reads disk and never mints ids.
 * `fileExists` answers "is this project-relative POSIX path an INDEXED file"
 * (resolution targets are indexed files); `langOfFile` returns an indexed file's
 * runtime lang (so the core can mint the target file-node id).
 */
export interface ResolveImportContext {
  fileExists(relPath: string): boolean;
  langOfFile(relPath: string): CodeLang | undefined;
}

/** A P1c import resolution: the provider-verified target PATH + confidence (the core mints the edge/target ids). */
export interface ImportResolution {
  readonly source: string;
  /** Project-relative POSIX path of the resolved target file, or null when unresolved/external. */
  readonly resolvedPath: string | null;
  readonly confidence: number;
}

/**
 * A language provider (spec §4). `id` is a PROVIDER id (a string like `js-ts`),
 * distinct from a runtime {@link CodeLang}.
 */
export interface CodeLanguageProvider {
  readonly id: string;
  readonly displayName: string;
  /** Runtime langs this provider emits, e.g. `['javascript','typescript','tsx']`. */
  readonly languages: readonly CodeLang[];
  /** Owned file extensions, e.g. `['.js','.jsx','.ts','.tsx']`. */
  readonly extensions: readonly string[];
  /** Extension-collision tiebreak (default 0; higher wins, then registration order). */
  readonly priority?: number;
  /** Provider version — feeds freshness via `configHashInputs`. */
  readonly version: string;
  readonly parser: ParserDeclaration;
  readonly queries: QueryDeclarations;
  readonly vocabulary: ProviderVocabularyDeclaration;
  readonly capabilities: ProviderCapabilityDeclaration;

  /** Resolve the runtime lang for a path (e.g. `.jsx` → `tsx`, `.js` → `javascript`). */
  langForPath(path: string): CodeLang;

  /** Produce the id-free draft (delegates to the generic query runtime). */
  extractDraft(input: ProviderExtractInput, services: ExtractionServices): Promise<ExtractionDraft>;

  /** Optional drafts-only refinement (React reclassification etc.). */
  refine?(draft: ExtractionDraft, ctx: RefineContext): ExtractionDraft | Promise<ExtractionDraft>;

  /**
   * P1c import resolution (file-level v1). Resolve one import's `source` (relative
   * to `req.fromPath`) to a project-internal target FILE path using the pure `ctx`
   * services. Return resolutions (path + confidence); `[]` or a null `resolvedPath`
   * when external/unresolved → the core emits NO `resolves_to` edge. The provider
   * returns PATHS only; the core mints the edge + target file id (dec#108/#109).
   * Optional: a provider without a resolver leaves the pass a no-op for its files.
   */
  resolveImport?(
    req: ImportResolutionRequest,
    ctx: ResolveImportContext,
  ): Promise<readonly ImportResolution[]>;

  /**
   * P1c-B symbol-level resolution: is `node` (a symbol in `fileSymbols`, that file's
   * full symbol set) IMPORTABLE from outside its file — i.e. a legitimate binding
   * target for `module --imports_symbol--> node`? Language semantics live here
   * (dec#108/#109: provider answers "importable?", core mints the edge/id).
   *
   * Default when a provider does NOT implement it ({@link defaultImportableSymbol}):
   * `node.kind === 'symbol' && node.exported === true && node.subtype !== 'export'`
   * — the TS rule (the `subtype !== 'export'` guard excludes synthetic export-clause
   * placeholder nodes, which are NOT real definitions). Python overrides it (no export
   * keyword → top-level-module test via `fileSymbols` span containment). PHP/Java have
   * no resolver yet, so this is never reached for them (B is a no-op there).
   */
  isImportableSymbol?(node: CodeNode, fileSymbols: readonly CodeNode[]): boolean;
}

/**
 * The default {@link CodeLanguageProvider.isImportableSymbol}: a real, externally
 * importable definition. Excludes synthetic `subtype:'export'` placeholders (TS
 * export-clause nodes) so B never binds to a non-definition (Codex cadrage review).
 */
export function defaultImportableSymbol(node: CodeNode): boolean {
  return node.kind === 'symbol' && node.exported === true && node.subtype !== 'export';
}

/** Shape of one `Manifest['languages']` entry (kept loose to avoid a cycle). */
export interface RegistryLanguageEntry {
  readonly enabled: boolean;
  readonly grammar_name: string;
  readonly grammar_version: string;
  readonly tree_sitter_grammar_hash: string;
}

/** The provider registry (spec §4). */
export interface CodeLanguageRegistry {
  register(p: CodeLanguageProvider): void;
  /** Deterministic on extension collision (priority, then registration order). */
  providerForPath(path: string): { provider: CodeLanguageProvider; lang: CodeLang } | null;
  providerForLang(lang: CodeLang): CodeLanguageProvider | null;
  activeLanguages(): CodeLang[];
  includedExtensions(): string[];
  /** Keyed by runtime CodeLang (javascript/typescript/tsx) — unchanged shape. */
  languageEntries(): Record<string, RegistryLanguageEntry>;
  /** Provider versions + every query-asset hash (freshness). */
  configHashInputs(): unknown;
}
