/**
 * Code Map P1a — TypeScriptProvider (provider #1; spec §8).
 *
 * Owns `.js/.jsx/.ts/.tsx` (runtime langs javascript/typescript/tsx). `extractDraft`
 * delegates to the generic query-runtime; `refine()` carries what tree-sitter
 * queries CANNOT express:
 *  - React `component` (PascalCase name + a JSX-returning body) / `hook`
 *    (`/^use[A-Z0-9]/`) reclassification — needs a JSX-body walk (returnsJsx) on the
 *    in-memory source node.
 *  - `function` vs `variable` for lexical declarators: the query emits the
 *    structural `variable` subtype; a declarator whose value is a function/arrow is
 *    reclassified to `function` (then possibly component/hook), matching the legacy
 *    `classifySubtype`.
 *
 * Identity is owned by the CORE finalizer — this provider mints NO ids. The
 * `.jsx → tsx` and `.js → javascript` resolution is explicit in `langForPath`.
 *
 * trp_5026812e: the shared `tags.scm` references TS-only node types and does NOT
 * compile against the JAVASCRIPT grammar. This provider therefore serves a
 * JS-compatible definition subset (`tags.js.scm`) for the `javascript` lang while
 * using `tags.scm` for typescript/tsx. `imports.scm` compiles against all three.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode } from 'web-tree-sitter';
import type { CodeLang, NodeSubtype } from '../../types.js';
import type { ExtractionDraft, DefinitionDraft } from '../../drafts.js';
import { grammarHash, grammarName, loadGrammar } from '../../wasm-loader.js';
import { extractWithQueries } from '../query-runtime.js';
import type {
  CodeLanguageProvider,
  ExtractionServices,
  ImportResolution,
  ImportResolutionRequest,
  ParserDeclaration,
  ProviderCapabilityDeclaration,
  ProviderExtractInput,
  QueryDeclarations,
  RefineContext,
  ResolveImportContext,
} from '../provider.js';
import type { ProviderVocabularyDeclaration } from '../../vocabulary.js';
import {
  isTypeScriptResolutionConfig,
  typeScriptSpecifierBases,
} from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  // Published / dist runtime: this module is dist/core/code-map/lang/typescript/
  // index.js and the build copies the .scm assets alongside it
  // (copy-code-map-wasm.mjs). Prefer that local copy.
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  // From-source / dist-test fallback: tsc emits to dist[-test]/... but does NOT
  // copy .scm, so walk up to the repo root (the dir holding package.json) and read
  // the curated asset from src/core/code-map/lang/typescript/.
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'typescript', basename);
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

// Load the curated query assets once at module init. tags.scm = TS/TSX defs,
// tags.js.scm = JS-compatible def subset (trp_5026812e); imports.scm = all langs.
const TAGS_TS = readScm('tags.scm');
const TAGS_JS = readScm('tags.js.scm');
const IMPORTS = readScm('imports.scm');

const TAGS_TS_HASH = sha256(TAGS_TS);
const TAGS_JS_HASH = sha256(TAGS_JS);
const IMPORTS_HASH = sha256(IMPORTS);

/** The tags source + hash for a runtime lang (.js uses the JS subset). */
function tagsForLang(lang: CodeLang): { source: string; hash: string } {
  if (lang === 'javascript') return { source: TAGS_JS, hash: TAGS_JS_HASH };
  return { source: TAGS_TS, hash: TAGS_TS_HASH };
}

const HOOK_RE = /^use[A-Z0-9]/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;

/** Walk to find the first descendant JSX node (mirrors legacy `returnsJsx`). */
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

/** Mirror of legacy `classifySubtype` (extractor.ts). */
function classifySubtype(
  name: string,
  valueNode: TsNode | null,
  isFunctionLike: boolean,
): NodeSubtype {
  if (HOOK_RE.test(name)) return 'hook';
  if (isFunctionLike && PASCAL_RE.test(name) && valueNode && returnsJsx(valueNode)) return 'component';
  return isFunctionLike ? 'function' : 'variable';
}

const parser: ParserDeclaration = {
  grammarForLang: (lang) => loadGrammar(lang),
  grammarNameForLang: (lang) => grammarName(lang),
  grammarHashForLang: (lang) => grammarHash(lang),
};

const queries: QueryDeclarations = {
  tags: {
    name: 'tags',
    sourceForLang: (lang) => tagsForLang(lang).source,
    hashForLang: (lang) => tagsForLang(lang).hash,
  },
  imports: {
    name: 'imports',
    sourceForLang: () => IMPORTS,
    hashForLang: () => IMPORTS_HASH,
  },
  // JS/TS import/export statement node types (cadrage §3 / Codex R1). Both are
  // listed because local exports + re-exports (`export … from`) also resolve
  // through the runtime's enclosingStatement walk. PROVIDER-LOCAL — the runtime
  // gets this set per file, never from a registry. (Same set the old module-global
  // carried for JS/TS, so output stays byte-identical.)
  enclosingStatementNodeTypes: ['import_statement', 'export_statement'],
  // P1b §3.4: the runtime drives capture→draft mapping off the HARD-CODED
  // capture-name convention (query-runtime.ts) — that convention IS the contract.
  // This captureMap is a declared MIRROR of it, validated against the convention
  // by `assertCaptureMapConforms` (provider-oracle test). Every entry's `capture`
  // MUST be a convention-recognized role; it cannot invent new capture roles.
  captureMap: [
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.function.exported', field: 'exported', optional: true },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.class.exported', field: 'exported', optional: true },
    { capture: 'definition.type.node', field: 'node', subtype: 'type' },
    { capture: 'definition.type.name', field: 'name' },
    { capture: 'definition.type.exported', field: 'exported', optional: true },
    { capture: 'definition.interface.node', field: 'node', subtype: 'interface' },
    { capture: 'definition.interface.name', field: 'name' },
    { capture: 'definition.interface.exported', field: 'exported', optional: true },
    { capture: 'definition.variable.node', field: 'node', subtype: 'variable' },
    { capture: 'definition.variable.name', field: 'name' },
    { capture: 'definition.variable.exported', field: 'exported', optional: true },
    { capture: 'import.source', field: 'source' },
    { capture: 'import.default.name', field: 'imported', optional: true },
    { capture: 'import.namespace.name', field: 'imported', optional: true },
    { capture: 'import.named.name', field: 'imported', optional: true },
    { capture: 'export.name', field: 'name', optional: true },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['function', 'class', 'type', 'interface', 'variable', 'component', 'hook', 'export'],
  edgeKinds: ['contains', 'defines', 'imports', 'exports'],
  captureMap: queries.captureMap,
};

const capabilities: ProviderCapabilityDeclaration = {
  tiers: ['T1.definitions', 'T2.imports', 'T3.import_resolution'],
  proven: {
    'T1.definitions': true,
    'T2.imports': true,
    'T3.import_resolution': true, // P1c file-level: relative specifiers, intra-project
    'T4.tests_for': false,
  },
};

/** Extensions tried (in order) when resolving an extensionless relative specifier. */
const TS_RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
/** JS-family extensions a written specifier may use for a TS source file (ESM `./x.js` → `x.ts`). */
const JS_LIKE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

/**
 * P1c file-level resolution (relative specifiers only). Given `./x` / `../x`
 * resolved against the importer dir, try in order: the exact path (if it carries
 * an extension), the TS-source siblings of a JS-family extension (ESM convention:
 * `./b.js` may mean `b.ts`/`b.tsx`), the extensionless candidate + each known
 * extension, then `<candidate>/index.<ext>`. Return the FIRST that is an indexed
 * file. Bare/external specifiers (`react`, `@scope/x`) → no resolution (no edge).
 */
function resolveTsCandidate(base: string, ctx: ResolveImportContext): string | null {
  const ext = path.posix.extname(base);
  const candidates: string[] = [];
  if (ext) {
    candidates.push(base);
    if (JS_LIKE_EXTS.has(ext)) {
      const noExt = base.slice(0, -ext.length);
      candidates.push(`${noExt}.ts`, `${noExt}.tsx`);
    }
  } else {
    for (const e of TS_RESOLVE_EXTS) candidates.push(`${base}${e}`);
    for (const e of TS_RESOLVE_EXTS) candidates.push(`${base}/index${e}`);
  }
  for (const c of candidates) {
    if (ctx.fileExists(c)) return c;
  }
  return null;
}

function resolveTsImport(spec: string, fromPath: string, ctx: ResolveImportContext): string | null {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return resolveTsCandidate(path.posix.join(path.posix.dirname(fromPath), spec), ctx);
  }
  const config = isTypeScriptResolutionConfig(ctx.resolverConfig) ? ctx.resolverConfig : undefined;
  const candidates = typeScriptSpecifierBases(spec, config);
  if (candidates.length === 0) return null; // external, invalid, or ambiguous config
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const target = resolveTsCandidate(candidate, ctx);
    if (target) resolved.add(target);
  }
  // Do not adopt TypeScript's fallback preference when config candidates produce
  // different indexed files: Code Map is deliberately soundness-first.
  return resolved.size === 1 ? [...resolved][0]! : null;
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
    'nameNode' in v &&
    typeof (v as { node?: unknown }).node === 'object'
  );
}

/** Resolve a declarator's `value` field from its name node (best-effort). */
function declaratorValue(nameNode: TsNode): TsNode | null {
  const declarator = nameNode.parent;
  if (!declarator) return null;
  try {
    return declarator.childForFieldName('value');
  } catch {
    return null;
  }
}

const FN_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

export class TypeScriptProvider implements CodeLanguageProvider {
  readonly id = 'js-ts';
  readonly displayName = 'JavaScript / TypeScript';
  readonly languages: readonly CodeLang[] = ['javascript', 'typescript', 'tsx'];
  readonly extensions: readonly string[] = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  /** `.jsx → tsx`, `.js/.mjs/.cjs → javascript`, `.tsx → tsx`, `.ts → typescript`. */
  langForPath(p: string): CodeLang {
    const ext = path.extname(p).toLowerCase();
    switch (ext) {
      case '.ts':
        return 'typescript';
      case '.tsx':
        return 'tsx';
      case '.jsx':
        return 'tsx'; // tsx grammar handles jsx (mirrors legacy langForExtension)
      case '.js':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      default:
        return 'typescript';
    }
  }

  async extractDraft(
    input: ProviderExtractInput,
    _services: ExtractionServices,
  ): Promise<ExtractionDraft> {
    const tags = tagsForLang(input.lang);
    return extractWithQueries({
      providerId: this.id,
      lang: input.lang,
      source: input.source,
      sizeBytes: input.sizeBytes,
      maxParseFileBytes: input.maxParseFileBytes,
      maxQueryWaitMs: input.maxQueryWaitMs,
      path: input.path,
      grammarForLang: this.parser.grammarForLang,
      tagsSource: tags.source,
      tagsHash: tags.hash,
      importsSource: IMPORTS,
      importsHash: IMPORTS_HASH,
      enclosingStatementNodeTypes: queries.enclosingStatementNodeTypes,
    });
  }

  /**
   * Reclassify definition subtypes the structural query cannot: function/arrow
   * declarators → function/component/hook; non-fn declarators with a `use*` name →
   * hook. Mirrors the legacy `classifySubtype` decisions exactly. Drafts-only.
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const definitions: DefinitionDraft[] = draft.definitions.map((d) => {
      // Only function-declaration + variable drafts are reclassified (classes,
      // types, interfaces keep their fixed subtype — legacy never reclassifies them).
      const src = isDefSourceNode(d.sourceNode) ? d.sourceNode : null;
      if (d.subtype === 'function') {
        // function declaration: classifySubtype(name, node, isFunctionLike=true).
        const valueNode = src ? src.node : null;
        const subtype = classifySubtype(d.name, valueNode, true);
        return subtype === d.subtype ? d : { ...d, subtype };
      }
      if (d.subtype === 'variable') {
        const value = src ? declaratorValue(src.nameNode) : null;
        const isFnLike = !!value && FN_VALUE_TYPES.has(value.type);
        const subtype = classifySubtype(d.name, value, isFnLike);
        return subtype === d.subtype ? d : { ...d, subtype };
      }
      return d;
    });
    return { ...draft, definitions };
  }

  /**
   * P1c file-level import resolution (intra-project, relative specifiers). Returns
   * paths only — the core mints the `resolves_to` edge + target file id. Bare/
   * external specifiers resolve to nothing (no edge). Confidence 1.0 (exact file).
   */
  async resolveImport(
    req: ImportResolutionRequest,
    ctx: ResolveImportContext,
  ): Promise<readonly ImportResolution[]> {
    const resolved = resolveTsImport(req.source, req.fromPath, ctx);
    return resolved ? [{ source: req.source, resolvedPath: resolved, confidence: 1.0 }] : [];
  }
}

/** Singleton instance for registry wiring. */
export const typeScriptProvider = new TypeScriptProvider();
