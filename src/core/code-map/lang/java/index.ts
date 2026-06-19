/**
 * Code Map langs#3-4 — JavaProvider (provider #4; cadrage v2 §6, dec#113).
 *
 * Owns `.java` (runtime lang `java`). `extractDraft` delegates to the generic
 * query-runtime; the curated `tags.scm`/`imports.scm` (this dir) drive structural
 * extraction. All definition subtypes are fixed by the query (no def
 * reclassification needed). `refine()` carries ONLY the import shaping the
 * structural query cannot express without overlapping matches (Codex R1):
 *  - wildcard `import a.b.*;` → imported name `*` (the package source `a.b` is
 *    already captured; the grammar puts `*` in a sibling `asterisk` node).
 *  - static `import static a.b.C.m;` → split the declaring type `a.b.C` (module
 *    source) from the member `m` (imported name); `import static a.b.C.*;` →
 *    source `a.b.C` + name `*`.
 *  - plain `import a.b.C;` → source `a.b.C`, no imported name.
 *
 * NO exports edges — Java has no export statement (capabilities: T2 = imports).
 * Nested/inner classes + their members are emitted by the same class/method
 * patterns; the finalizer emits only file-level contains/defines (no nesting edges).
 *
 * Identity is owned by the CORE finalizer — this provider mints NO ids. The grammar
 * is loaded through the SHARED engine glue (`loadGrammarWasm`), NEVER a fresh
 * `web-tree-sitter` import (trp_8df65ab7).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as TsNode, Tree } from 'web-tree-sitter';
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

/** The java grammar .wasm: dist basename + node_modules devDep fallback spec. */
const JAVA_WASM_BASENAME = 'tree-sitter-java.wasm';
const JAVA_WASM_NODE_MODULES_SPEC = 'tree-sitter-wasms/out/tree-sitter-java.wasm';
const JAVA_GRAMMAR_NAME = 'tree-sitter-java';

/** Resolve a vendored `.scm` next to this module (dist) or from the source tree. */
function readScm(basename: string): string {
  // Published / dist runtime: this module is dist/core/code-map/lang/java/index.js
  // and the build copies the .scm assets alongside it (copy-code-map-wasm.mjs).
  const local = path.join(HERE, basename);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf-8');
  // From-source / dist-test fallback: tsc emits to dist[-test]/... but does NOT copy
  // .scm, so walk up to the repo root (the dir holding package.json) and read the
  // curated asset from src/core/code-map/lang/java/.
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const fromSrc = path.join(dir, 'src', 'core', 'code-map', 'lang', 'java', basename);
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
  grammarForLang: () => loadGrammarWasm(JAVA_WASM_BASENAME, JAVA_WASM_NODE_MODULES_SPEC),
  grammarNameForLang: () => JAVA_GRAMMAR_NAME,
  grammarHashForLang: () => grammarHashForWasm(JAVA_WASM_BASENAME, JAVA_WASM_NODE_MODULES_SPEC),
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
  // Java import declarations are the import statement; Java has no export statement.
  enclosingStatementNodeTypes: ['import_declaration'],
  // P1b §3.4 / cadrage: every capture mirrors the hard-coded runtime convention and
  // is validated by `assertCaptureMapConforms`. The namespaced java.annotation /
  // java.record are still definition.<subtype>.* captures.
  captureMap: [
    { capture: 'definition.package.node', field: 'node', subtype: 'package' },
    { capture: 'definition.package.name', field: 'name' },
    { capture: 'definition.class.node', field: 'node', subtype: 'class' },
    { capture: 'definition.class.name', field: 'name' },
    { capture: 'definition.interface.node', field: 'node', subtype: 'interface' },
    { capture: 'definition.interface.name', field: 'name' },
    { capture: 'definition.enum.node', field: 'node', subtype: 'enum' },
    { capture: 'definition.enum.name', field: 'name' },
    { capture: 'definition.java.annotation.node', field: 'node', subtype: 'java.annotation' },
    { capture: 'definition.java.annotation.name', field: 'name' },
    { capture: 'definition.java.record.node', field: 'node', subtype: 'java.record' },
    { capture: 'definition.java.record.name', field: 'name' },
    { capture: 'definition.method.node', field: 'node', subtype: 'method' },
    { capture: 'definition.method.name', field: 'name' },
    { capture: 'definition.constructor.node', field: 'node', subtype: 'constructor' },
    { capture: 'definition.constructor.name', field: 'name' },
    { capture: 'definition.field.node', field: 'node', subtype: 'field' },
    { capture: 'definition.field.name', field: 'name' },
    { capture: 'definition.constant.node', field: 'node', subtype: 'constant' },
    { capture: 'definition.constant.name', field: 'name' },
    { capture: 'import.source', field: 'source' },
  ],
};

const vocabulary: ProviderVocabularyDeclaration = {
  nodeSubtypes: [
    'package',
    'class',
    'interface',
    'enum',
    'java.annotation',
    'java.record',
    'method',
    'constructor',
    'field',
    'constant',
  ],
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

/** A span key matching the runtime's `spanOf` (1-based start/end line+col). */
function spanKey(span: { start_line: number; start_col: number; end_line: number; end_col: number }): string {
  return `${span.start_line}:${span.start_col}:${span.end_line}:${span.end_col}`;
}

function spanKeyOfNode(node: TsNode): string {
  return `${node.startPosition.row + 1}:${node.startPosition.column + 1}:${node.endPosition.row + 1}:${node.endPosition.column + 1}`;
}

/** Iterative named-node DFS collecting nodes whose type is in `types`. */
function collectByType(root: TsNode, types: ReadonlySet<string>): TsNode[] {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (types.has(n.type)) found.push(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return found;
}

const IMPORT_DECL = new Set(['import_declaration']);

interface ImportShape {
  isStatic: boolean;
  isWildcard: boolean;
}

/** Map each import_declaration's statement span → its static/wildcard shape. */
function importShapesBySpan(tree: Tree): Map<string, ImportShape> {
  const out = new Map<string, ImportShape>();
  for (const decl of collectByType(tree.rootNode, IMPORT_DECL)) {
    let isStatic = false;
    let isWildcard = false;
    // `static` is an anonymous keyword token; `asterisk` is a named node. Iterate
    // ALL children (named + anonymous) to detect both.
    for (let i = 0; i < decl.childCount; i++) {
      const c = decl.child(i);
      if (!c) continue;
      if (c.type === 'static') isStatic = true;
      else if (c.type === 'asterisk') isWildcard = true;
    }
    out.set(spanKeyOfNode(decl), { isStatic, isWildcard });
  }
  return out;
}

export class JavaProvider implements CodeLanguageProvider {
  readonly id = 'java';
  readonly displayName = 'Java';
  readonly languages: readonly CodeLang[] = ['java'];
  readonly extensions: readonly string[] = ['.java'];
  readonly priority = 0;
  readonly version = '0.1.0';
  readonly parser = parser;
  readonly queries = queries;
  readonly vocabulary = vocabulary;
  readonly capabilities = capabilities;

  /** `.java` → `java`. */
  langForPath(_p: string): CodeLang {
    return 'java';
  }

  async extractDraft(
    input: ProviderExtractInput,
    _services: ExtractionServices,
  ): Promise<ExtractionDraft> {
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
   * Drafts-only refinement (cadrage v2 §6): shape import source / imported-names
   * per the static-split and wildcard rules. Definitions need no reclassification.
   */
  refine(draft: ExtractionDraft, _ctx: RefineContext): ExtractionDraft {
    const tree = draft.attributes?.__tree as Tree | undefined | null;
    if (!tree || draft.imports.length === 0) return draft;
    const shapes = importShapesBySpan(tree);
    if (shapes.size === 0) return draft;

    const imports: ImportDraft[] = draft.imports.map((im) => {
      const shape = shapes.get(spanKey(im.span));
      if (!shape) return im;
      if (shape.isWildcard) {
        // `import a.b.*` / `import static a.b.C.*` → source is the captured path; add '*'.
        return { ...im, importedNames: ['*'] };
      }
      if (shape.isStatic) {
        // `import static a.b.C.m` → split declaring type (module) vs member (name).
        const dot = im.source.lastIndexOf('.');
        if (dot > 0) {
          return {
            ...im,
            source: im.source.slice(0, dot),
            importedNames: [im.source.slice(dot + 1)],
          };
        }
        return im;
      }
      // Plain `import a.b.C` → module a.b.C, no imported name.
      return im;
    });

    return { ...draft, imports };
  }
}

/** Singleton instance for registry wiring. */
export const javaProvider = new JavaProvider();
