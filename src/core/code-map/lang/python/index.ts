/**
 * Code Map P1b — PythonProvider (provider #2; cadrage §5/§6).
 *
 * Owns `.py` (runtime lang `python`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive structural
 * extraction. `refine()` carries what the tree-sitter queries CANNOT express
 * syntactically (cadrage §5, all provider-local):
 *  - class methods: a `function_definition` directly in a `class_definition` body →
 *    subtype `method` (`__init__` included). Identity span stays the
 *    `function_definition` (decorators excluded — the query anchors the inner node).
 *  - nested defs (a `function_definition` NOT directly owned by a class body) →
 *    stay `function`.
 *  - decorator-driven: `@property` → `property`; `@staticmethod`/`@classmethod` →
 *    `method`. Decorators are NON-emitting (no node, no persisted attribute).
 *  - `async def` → `function`/`method` by context (async is classification-only;
 *    NOT persisted — there is no durable attribute field).
 *  - module-level `UPPER_CASE` simple/annotated assignment → `constant`
 *    (else `variable`; class/instance attrs are NOT symbols, never constants).
 *
 * NO exports edges — Python has no export statement (capabilities: T2 = imports).
 *
 * Identity is owned by the CORE finalizer — this provider mints NO ids. The grammar
 * is loaded through the SHARED engine glue (`loadGrammarWasm` → same initialized
 * web-tree-sitter instance as js-ts), NEVER a fresh `web-tree-sitter` import
 * (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode } from 'web-tree-sitter';
import type { CodeLang, NodeSubtype } from '../../types.js';
import type { ExtractionDraft, DefinitionDraft } from '../../drafts.js';
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

/** The python grammar .wasm: dist basename + node_modules devDep fallback spec. */
const PY_WASM_BASENAME = 'tree-sitter-python.wasm';
const PY_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-python.wasm';
const PY_GRAMMAR_NAME = 'tree-sitter-python';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  // Published / dist runtime: this module is dist/core/code-map/lang/python/index.js
  // and the build copies the .scm assets alongside it (copy-code-map-wasm.mjs).
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  // From-source / dist-test fallback: tsc emits to dist[-test]/... but does NOT copy
  // .scm, so walk up to the repo root (the dir holding package.json) and read the
  // curated asset from src/core/code-map/lang/python/.
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'python', basename);
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
  grammarForLang: () => loadGrammarWasm(PY_WASM_BASENAME, PY_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => PY_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(PY_WASM_BASENAME, PY_WASM_NODE_MODULES_SPEC),
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
  // Python import statement node types (cadrage §3 / Codex R1): `import a, b` is an
  // `import_statement`; `from x import …` is an `import_from_statement`. Python has
  // no export statement. PROVIDER-LOCAL — runtime gets this per file, no registry.
  // (Same set the old module-global carried for Python → byte-identical output.)
  enclosingStatementNodeTypes: ['import_statement', 'import_from_statement'],
  // P1b §3.4: the runtime drives capture→draft mapping off the HARD-CODED
  // capture-name convention (query-runtime.ts). This captureMap is a declared
  // MIRROR, validated by `assertCaptureMapConforms`. Every entry names a
  // convention-recognized role; Python invents none.
  captureMap: [
    { capture: 'definition.function.node', field: 'node', subtype: 'function' },
    { capture: 'definition.function.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.variable.node', field: 'node', subtype: 'variable' },
    { capture: 'definition.variable.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
    { capture: 'import.named.name', field: 'imported', optional: true },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: ['function', 'method', 'class', 'variable', 'constant', 'property'],
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

const UPPER_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * True iff `defNode` (a `function_definition`) is a method — i.e. directly owned by
 * a `class_definition` body. The grammar nests a def's statements under a `block`
 * whose parent is the `class_definition`; a decorated method is wrapped in a
 * `decorated_definition` (also inside that `block`). So walk: function_definition →
 * (optional decorated_definition) → block → class_definition.
 */
function isClassMethod(defNode: TsNode): boolean {
  let owner = defNode.parent;
  // A decorated def sits inside a `decorated_definition` wrapper.
  if (owner && owner.type === 'decorated_definition') owner = owner.parent;
  if (!owner || owner.type !== 'block') return false;
  const blockParent = owner.parent;
  return !!blockParent && blockParent.type === 'class_definition';
}

/**
 * Collect decorator names applied to `defNode`. A decorated def's parent is a
 * `decorated_definition` whose `decorator` children carry the applied names (e.g.
 * `@property`, `@staticmethod`, `@app.route(...)`). We read each decorator's leading
 * identifier/attribute text (best-effort) to classify property/staticmethod/classmethod.
 */
function decoratorNames(defNode: TsNode): string[] {
  const wrapper = defNode.parent;
  if (!wrapper || wrapper.type !== 'decorated_definition') return [];
  const names: string[] = [];
  for (let i = 0; i < wrapper.namedChildCount; i++) {
    const child = wrapper.namedChild(i);
    if (!child || child.type !== 'decorator') continue;
    // decorator text is like `@property` / `@staticmethod` / `@app.route("/x")`.
    // Strip the leading `@` and any call/attribute tail to get the head name.
    const text = child.text.replace(/^@/, '').trim();
    const head = text.split(/[(\s]/)[0]; // up to first `(` or whitespace
    names.push(head);
  }
  return names;
}

export class PythonProvider implements CodeLanguageProvider {
  readonly id = 'python';
  readonly displayName = 'Python';
  readonly languages: readonly CodeLang[] = ['python'];
  readonly extensions: readonly string[] = ['.py'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  /** `.py` → `python`. */
  langForPath(_p: string): CodeLang {
    return 'python';
  }

  async extractDraft(
    input: ProviderExtractInput,
    _services: ExtractionServices,
  ): Promise<ExtractionDraft> {
    return extractDraftViaRuntime(this.id, input, this.parser.grammarForLang);
  }

  /**
   * Reclassify subtypes the structural query cannot express (cadrage §5). Drafts-only.
   *  - function in a class body → method (decorator @property → property;
   *    @staticmethod/@classmethod → method); nested/top-level defs stay function.
   *  - module-level UPPER_CASE assignment → constant; else stays variable.
   * `async` is never persisted (no attribute field) — it is classification-only and
   * does not change the subtype beyond function/method by context.
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const definitions: DefinitionDraft[] = draft.definitions.map((d) => {
      const src = isDefSourceNode(d.sourceNode) ? d.sourceNode : null;

      if (d.subtype === 'function') {
        if (!src) return d;
        const decos = decoratorNames(src.node);
        // @property wins as a value-like member; @staticmethod/@classmethod are methods.
        if (decos.includes('property')) return setSubtype(d, 'property');
        const inClass = isClassMethod(src.node);
        if (decos.includes('staticmethod') || decos.includes('classmethod')) {
          return setSubtype(d, 'method');
        }
        return inClass ? setSubtype(d, 'method') : d; // top-level / nested stay function
      }

      if (d.subtype === 'variable') {
        // Module-level UPPER_CASE → constant; the tags.scm anchors variables under
        // (module) only, so any captured variable IS module-level.
        return UPPER_RE.test(d.name) ? setSubtype(d, 'constant') : d;
      }

      return d;
    });
    return { ...draft, definitions };
  }
}

function setSubtype(d: DefinitionDraft, subtype: NodeSubtype): DefinitionDraft {
  return d.subtype === subtype ? d : { ...d, subtype };
}

async function extractDraftViaRuntime(
  providerId: string,
  input: ProviderExtractInput,
  grammarForLang: (lang: CodeLang) => Promise<unknown>,
): Promise<ExtractionDraft> {
  return extractWithQueries({
    providerId,
    lang: input.lang,
    source: input.source,
    sizeBytes: input.sizeBytes,
    maxParseFileBytes: input.maxParseFileBytes,
    maxQueryWaitMs: input.maxQueryWaitMs,
    path: input.path,
    grammarForLang,
    tagsSource: TAGS,
    tagsHash: TAGS_HASH,
    importsSource: IMPORTS,
    importsHash: IMPORTS_HASH,
    enclosingStatementNodeTypes: queries.enclosingStatementNodeTypes,
  });
}

/** Singleton instance for registry wiring. */
export const pythonProvider = new PythonProvider();
