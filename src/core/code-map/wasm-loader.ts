/**
 * Tree-sitter WASM engine + grammar loader (spec §6.2).
 *
 * Decided design points (spec §6.2):
 *  - web-tree-sitter is the engine glue (vendored into dist/vendor/; copied to
 *    dist/wasm/ alongside the grammar .wasm by scripts/copy-code-map-wasm.mjs).
 *  - Grammar .wasm (typescript / tsx / javascript) ship under dist/wasm/.
 *  - All assets are resolved by `new URL('./wasm/<file>.wasm', import.meta.url)`
 *    — NEVER cwd/__dirname — so the loader is worktree-safe under ESM.
 *  - Lazy-load on FIRST PARSE only: `Parser.init()` once per process; each
 *    grammar `Language` is loaded only when a file of that language appears,
 *    then cached. Nothing here runs at import time or on the query path.
 *  - Hashes: `engineGlueHash()` = sha256 of the vendored engine .wasm;
 *    `grammarHash(lang)` = sha256 of the grammar .wasm. These feed manifest /
 *    shard freshness and are kept SEPARATE from extractor_config_hash.
 *
 * Packaging fallback: if the dist/wasm/ bundle is absent (e.g. running from
 * source before the copy step has run, or the fallback packaging path), the
 * loader resolves the assets from the installed node_modules devDependencies
 * via `createRequire`. This keeps parse logic + tests working regardless of
 * whether the dist bundling step has executed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import type { CodeLang } from './types.js';

// TODO(code-map packaging): the engine + grammar .wasm are bundled into
// dist/wasm/ (and the engine .wasm vendored into dist/vendor/web-tree-sitter/)
// by scripts/copy-code-map-wasm.mjs, but the web-tree-sitter *JS glue* is still
// imported from node_modules (a devDependency). A real `npm publish` drops
// devDeps, so the JS glue must also be vendored (e.g. bundle tree-sitter.js into
// dist/vendor/ and import it by path) before Code Map ships in a release. The
// .wasm resolution + parse logic + freshness/hashing are complete and tested;
// only the JS-glue vendoring for publish remains. Tracked for P0 packaging
// hardening / a follow-up sprint.

const require = createRequire(import.meta.url);

/** Grammar packages keyed by Code Map language tag. */
const GRAMMAR_WASM_BASENAME: Record<Exclude<CodeLang, 'jsx'>, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

/** node_modules fallback paths (resolved lazily; only used if dist bundle absent). */
const GRAMMAR_NODE_MODULES_SPEC: Record<Exclude<CodeLang, 'jsx'>, string> = {
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
};

const ENGINE_WASM_BASENAME = 'tree-sitter.wasm';
const ENGINE_NODE_MODULES_SPEC = 'web-tree-sitter/tree-sitter.wasm';

/** jsx files use the tsx grammar (it is a strict superset of jsx + js). */
function grammarLangFor(lang: CodeLang): Exclude<CodeLang, 'jsx'> {
  return lang === 'jsx' ? 'tsx' : lang;
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
    const wasmBinary = readWasm(engineWasmPath());
    engineInitPromise = Parser.init({ wasmBinary });
  }
  return engineInitPromise;
}

// --- Grammar cache (lazy, per language) ---

const grammarCache = new Map<Exclude<CodeLang, 'jsx'>, Language>();
const grammarHashCache = new Map<Exclude<CodeLang, 'jsx'>, string>();

/**
 * Load (and cache) the grammar Language for a Code Map language. Initializes the
 * engine first if needed. Lazy: only called from the parse loop.
 */
export async function loadGrammar(lang: CodeLang): Promise<Language> {
  const key = grammarLangFor(lang);
  const cached = grammarCache.get(key);
  if (cached) return cached;
  await initEngine();
  const path = resolveWasmPath(GRAMMAR_WASM_BASENAME[key], GRAMMAR_NODE_MODULES_SPEC[key]);
  const bytes = readWasm(path);
  if (!grammarHashCache.has(key)) grammarHashCache.set(key, sha256(bytes));
  const language = await Language.load(bytes);
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
export const GRAMMAR_NAMES: Record<Exclude<CodeLang, 'jsx'>, string> = {
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
}
