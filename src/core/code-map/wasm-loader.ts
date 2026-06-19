/**
 * Tree-sitter WASM engine + grammar loader (spec §6.2).
 *
 * Decided design points (spec §6.2):
 *  - web-tree-sitter is the engine glue (vendored into dist/vendor/; copied to
 *    dist/wasm/ alongside the grammar .wasm by scripts/copy-code-map-wasm.mjs).
 *  - Grammar .wasm (typescript / tsx / javascript) ship under dist/wasm/.
 *  - All assets are resolved by `new URL('./wasm/<file>.wasm', import.meta.url)`
 *    — NEVER cwd/__dirname — so the loader is worktree-safe under ESM.
 *  - Lazy-load on FIRST PARSE only. CRITICAL: the web-tree-sitter *JS glue* is a
 *    devDependency, so it is NEVER imported at module-load time — a static import
 *    would sit in the eager graph of cli.js / mcp.js and brick the ENTIRE CLI on
 *    a published package (devDeps dropped) even for `--version` / find / brief /
 *    status. Instead the glue is loaded via a DYNAMIC import inside `initEngine()`
 *    (the first-parse init path), preferring the VENDORED copy at
 *    `dist/vendor/web-tree-sitter/tree-sitter.js` (resolved via import.meta.url,
 *    bundled by scripts/copy-code-map-wasm.mjs) so the published package works at
 *    parse time too; it falls back to the bare 'web-tree-sitter' specifier when
 *    the vendored copy is absent (running from source).
 *  - `Parser.init()` runs once per process; each grammar `Language` is loaded
 *    only when a file of that language appears, then cached. Nothing here runs at
 *    import time or on the query path.
 *  - Hashes: `engineGlueHash()` = sha256 of the vendored engine .wasm;
 *    `grammarHash(lang)` = sha256 of the grammar .wasm. These feed manifest /
 *    shard freshness and are kept SEPARATE from extractor_config_hash.
 *
 * Packaging fallback: if the dist/wasm/ bundle is absent (e.g. running from
 * source before the copy step has run, or the fallback packaging path), the
 * loader resolves the .wasm assets from the installed node_modules
 * devDependencies via `createRequire`. This keeps parse logic + tests working
 * regardless of whether the dist bundling step has executed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// IMPORTANT: type-only import — fully erased at compile (no verbatimModuleSyntax),
// so this does NOT put web-tree-sitter in the runtime import graph. The values
// (Parser / Language) are loaded lazily via dynamic import in loadEngineGlue().
import type { Parser as ParserType, Language as LanguageType, Query as QueryType } from 'web-tree-sitter';
import type { CodeLang } from './types.js';

const require = createRequire(import.meta.url);

/**
 * The grammar keys THIS loader serves. It is the js-ts provider's own WASM table,
 * so it is keyed by a LOCAL type — NOT `Exclude<CodeLang, 'jsx'>` — so that opening
 * the global `CodeLang` union (P1b §3.1) for a new provider (e.g. `python`, which
 * loads its grammar through its OWN provider loader) does not force a phantom key
 * here. The loader maps the js-ts runtime langs onto these three grammars.
 */
type JsTsGrammarLang = 'javascript' | 'typescript' | 'tsx';

/** Grammar packages keyed by Code Map language tag. */
const GRAMMAR_WASM_BASENAME: Record<JsTsGrammarLang, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

/** node_modules fallback paths (resolved lazily; only used if dist bundle absent). */
const GRAMMAR_NODE_MODULES_SPEC: Record<JsTsGrammarLang, string> = {
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
};

const ENGINE_WASM_BASENAME = 'tree-sitter.wasm';
const ENGINE_NODE_MODULES_SPEC = 'web-tree-sitter/tree-sitter.wasm';

/**
 * Narrow a runtime `CodeLang` onto the js-ts grammar key. `jsx` uses the tsx
 * grammar (a strict superset of jsx + js). Any lang outside the js-ts set is not
 * something THIS loader serves (it is some other provider's grammar) — default to
 * `typescript` to stay total, matching the legacy fall-through behavior.
 */
function grammarLangFor(lang: CodeLang): JsTsGrammarLang {
  switch (lang) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return lang;
    case 'jsx':
      return 'tsx';
    default:
      return 'typescript';
  }
}

/**
 * Resolve a bundled wasm asset path. Prefers `dist/wasm/<basename>` resolved
 * relative to THIS module via import.meta.url; falls back to the node_modules
 * devDependency when the dist bundle is not present.
 */
function resolveWasmPath(distBasename: string, nodeModulesSpec: string): string {
  // dist-bundled location: <module dir>/wasm/<basename>. At runtime this module
  // is dist/core/code-map/wasm-loader.js, so '../../wasm/<basename>' === dist/wasm/.
  try {
    const bundled = fileURLToPath(new URL(`../../wasm/${distBasename}`, import.meta.url));
    if (fs.existsSync(bundled)) return bundled;
  } catch {
    /* fall through to node_modules */
  }
  // node_modules fallback (devDependency). Keeps parse logic + tests working
  // even before the dist copy step has run.
  return require.resolve(nodeModulesSpec);
}

function readWasm(path: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path));
}

// --- engine glue (web-tree-sitter JS) — dynamic, lazy, never in module graph ---

/** Static shape of the bits of the web-tree-sitter module we use. */
interface EngineGlue {
  Parser: typeof ParserType;
  Language: typeof LanguageType;
  Query: typeof QueryType;
}

let glueModule: EngineGlue | null = null;
let glueLoadPromise: Promise<EngineGlue> | null = null;

/**
 * Dynamically import the web-tree-sitter JS glue on FIRST PARSE only. Prefers the
 * vendored copy bundled into dist/vendor/web-tree-sitter/tree-sitter.js (resolved
 * relative to this module via import.meta.url) so a published package — which has
 * dropped the web-tree-sitter devDependency — still parses. Falls back to the
 * bare 'web-tree-sitter' specifier when the vendored copy is absent (running from
 * source / tests against node_modules).
 *
 * This function is the ONLY place that pulls web-tree-sitter into the runtime
 * graph, and it runs strictly inside the parse path — so cli.js / mcp.js module
 * load (and find / brief / status, which never parse) work with the engine glue
 * entirely absent.
 */
async function loadEngineGlue(): Promise<EngineGlue> {
  if (glueModule) return glueModule;
  if (glueLoadPromise) return glueLoadPromise;
  glueLoadPromise = (async () => {
    // Vendored copy: <module dir>/../../vendor/web-tree-sitter/tree-sitter.js.
    // At runtime this module is dist/core/code-map/wasm-loader.js, so
    // '../../vendor/...' === dist/vendor/...
    let mod: EngineGlue;
    const vendored = new URL('../../vendor/web-tree-sitter/tree-sitter.js', import.meta.url);
    let vendoredExists = false;
    try {
      vendoredExists = fs.existsSync(fileURLToPath(vendored));
    } catch {
      vendoredExists = false;
    }
    if (vendoredExists) {
      mod = (await import(vendored.href)) as unknown as EngineGlue;
    } else {
      // Fallback: bare specifier (node_modules devDependency). On a published
      // package without the vendored copy this would throw — but the copy script
      // always vendors the glue, so this branch is the from-source/tests path.
      mod = (await import('web-tree-sitter')) as unknown as EngineGlue;
    }
    glueModule = mod;
    return mod;
  })();
  return glueLoadPromise;
}

/**
 * Parser constructor from the lazily-loaded engine glue (parse path only). Awaits
 * {@link initEngine} first so any caller constructs a parser off an INITIALIZED
 * engine — a parser built before `Parser.init()` would brick on first use.
 */
export async function getParser(): Promise<typeof ParserType> {
  await initEngine();
  const glue = await loadEngineGlue();
  return glue.Parser;
}

/**
 * `Query` constructor from the SAME lazily-loaded engine glue module that
 * {@link initEngine}/{@link loadGrammar} run against, with the engine initialized
 * first. CRITICAL: web-tree-sitter is shipped as a vendored copy under
 * `dist/vendor/` AND exists as a node_modules devDependency; a fresh
 * `import('web-tree-sitter')` resolves to a DISTINCT Emscripten module instance
 * whose `Module` is never initialized by our `Parser.init({wasmBinary})` call.
 * Constructing a `Query` against that un-inited instance throws
 * `Cannot read properties of undefined (reading 'lengthBytesUTF8')`. Sourcing
 * `Query` from `loadEngineGlue()` (same instance, after `initEngine()`) is the
 * only correct path. (Regression fixed: P1a real-refresh WASM bug.)
 */
export async function getQueryClass(): Promise<typeof QueryType> {
  await initEngine();
  const glue = await loadEngineGlue();
  return glue.Query;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// --- Engine init (once per process) ---

let enginePath: string | null = null;
let engineInitPromise: Promise<void> | null = null;

function engineWasmPath(): string {
  if (enginePath === null) {
    enginePath = resolveWasmPath(ENGINE_WASM_BASENAME, ENGINE_NODE_MODULES_SPEC);
  }
  return enginePath;
}

/**
 * Initialize the Tree-sitter engine exactly once per process. The engine .wasm
 * binary is read explicitly and passed via `wasmBinary` so we never depend on
 * emscripten's cwd/script-dir resolution (worktree-safe).
 */
export function initEngine(): Promise<void> {
  if (!engineInitPromise) {
    engineInitPromise = (async () => {
      const glue = await loadEngineGlue();
      const wasmBinary = readWasm(engineWasmPath());
      await glue.Parser.init({ wasmBinary });
    })();
  }
  return engineInitPromise;
}

// --- Grammar cache (lazy, per language) ---

const grammarCache = new Map<JsTsGrammarLang, LanguageType>();
const grammarHashCache = new Map<JsTsGrammarLang, string>();

/**
 * Load (and cache) the grammar Language for a Code Map language. Initializes the
 * engine first if needed. Lazy: only called from the parse loop.
 */
export async function loadGrammar(lang: CodeLang): Promise<LanguageType> {
  const key = grammarLangFor(lang);
  const cached = grammarCache.get(key);
  if (cached) return cached;
  await initEngine();
  const glue = await loadEngineGlue();
  const path = resolveWasmPath(GRAMMAR_WASM_BASENAME[key], GRAMMAR_NODE_MODULES_SPEC[key]);
  const bytes = readWasm(path);
  if (!grammarHashCache.has(key)) grammarHashCache.set(key, sha256(bytes));
  const language = await glue.Language.load(bytes);
  grammarCache.set(key, language);
  return language;
}

/** sha256 of the vendored engine glue .wasm (manifest.engine_glue_hash). */
export function engineGlueHash(): string {
  return sha256(readWasm(engineWasmPath()));
}

/** sha256 of a grammar .wasm (per-language tree_sitter_grammar_hash). */
export function grammarHash(lang: CodeLang): string {
  const key = grammarLangFor(lang);
  const cached = grammarHashCache.get(key);
  if (cached) return cached;
  const path = resolveWasmPath(GRAMMAR_WASM_BASENAME[key], GRAMMAR_NODE_MODULES_SPEC[key]);
  const h = sha256(readWasm(path));
  grammarHashCache.set(key, h);
  return h;
}

/** Map of canonical grammar names per language (manifest.languages.*). */
export const GRAMMAR_NAMES: Record<JsTsGrammarLang, string> = {
  javascript: 'tree-sitter-javascript',
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
};

export function grammarName(lang: CodeLang): string {
  return GRAMMAR_NAMES[grammarLangFor(lang)];
}

/** Test/maintenance seam: drop cached engine + grammars (not used in hot paths). */
export function __resetWasmCaches(): void {
  grammarCache.clear();
  grammarHashCache.clear();
  engineInitPromise = null;
  enginePath = null;
  // NOTE: glueModule / glueLoadPromise are intentionally NOT reset — the dynamic
  // import is process-global and re-importing is unnecessary; Parser.init is the
  // re-runnable seam (gated by engineInitPromise above).
}
