/**
 * Code Map P1a — CORE extraction entrypoint (spec §3 / Grok v2 HIGH #1).
 *
 * `extractFile(input)` is the NEW public entrypoint for the query-driven pipeline:
 *   registry.providerForPath(path) → provider.extractDraft → provider.refine? → finalize()
 *
 * Identity is owned exclusively by `finalize` (Sprint 2) — this module never mints
 * ids. It coexists with the legacy `extractor.ts` during P1a (Sprint 4 rewires
 * refresh.ts and removes the legacy bodies).
 *
 * Per-file best-effort (spec §7): the runtime never throws; if `refine()` throws,
 * the core falls back to the pre-refine draft + a `refine_error` diagnostic. The
 * parse tree carried on `draft.attributes.__tree` is deleted after finalize.
 */
import type { Tree } from 'web-tree-sitter';
import type { ExtractInput, ExtractResult } from './extractor.js';
import { finalize } from './finalizer.js';
import type { ExtractionDraft } from './drafts.js';
import type { CodeLanguageRegistry } from './lang/provider.js';
import { defaultRegistry } from './lang/providers.js';

/**
 * The default registry is constructed + registered in `lang/providers.ts` (P1b
 * §3.2) — the declared extension point for "which providers ship by default".
 * Re-exported here so existing importers (`core.js`) keep working unchanged.
 */
export { defaultRegistry };

const SERVICES = { version: '0.1.0' } as const;

function fileOnlyResult(input: ExtractInput, parseStatus: ExtractResult['parseStatus']): ExtractResult {
  // Reuse the finalizer over an empty draft so the file node id matches exactly.
  return finalize(
    {
      file: { path: input.path },
      definitions: [],
      imports: [],
      exports: [],
      tests: [],
      facts: [{ code: 'skipped_unsupported', message: `no provider for ${input.path}` }],
      attributes: { parseStatus },
    },
    input,
  );
}

/** Delete the retained parse tree (best-effort). */
function releaseTree(draft: ExtractionDraft): void {
  const tree = draft.attributes?.__tree as Tree | undefined | null;
  if (tree) {
    try {
      tree.delete();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Extract a single file via the provider pipeline. Signature-compatible with the
 * legacy `extractor.ts:extractFile`. Resolves the provider by path; an unsupported
 * extension yields a `skipped_unsupported` file-only result (never throws).
 */
export async function extractFile(
  input: ExtractInput,
  registry: CodeLanguageRegistry = defaultRegistry,
): Promise<ExtractResult> {
  const resolved = registry.providerForPath(input.path);
  if (!resolved) {
    return fileOnlyResult(input, 'skipped_unsupported');
  }
  const { provider, lang } = resolved;

  // The caller's `input.lang` is authoritative for identity (it matches what the
  // refresh pipeline resolved + what the oracle froze). We pass it through; the
  // resolved `lang` is used only as a cross-check / for providers that re-resolve.
  const providerInput = {
    projectId: input.projectId,
    path: input.path,
    lang: input.lang,
    source: input.source,
    sizeBytes: input.sizeBytes,
    maxParseFileBytes: input.maxParseFileBytes,
    maxQueryWaitMs: input.maxQueryWaitMs,
  };
  void lang;

  let draft = await provider.extractDraft(providerInput, SERVICES);

  if (provider.refine) {
    try {
      draft = await provider.refine(draft, { input: providerInput, lang: input.lang });
    } catch (err) {
      // Fall back to the pre-refine draft + a loud diagnostic (never drop the file).
      draft = {
        ...draft,
        facts: [
          ...draft.facts,
          { code: 'refine_error', message: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  }

  try {
    return finalize(draft, input);
  } finally {
    releaseTree(draft);
  }
}
