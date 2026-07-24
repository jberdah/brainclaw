/**
 * Write-side freshness hashing + per-shard freshness classification
 * (spec §5.1, §6.2, §12.4).
 *
 * The READ-path lazy freshness check (§6.1) is Sprint 3 — NOT implemented here.
 * This module owns only:
 *  - `computeExtractorConfigHash` — sha256 of a stable serialization of
 *    extractor_config + the active language set + (P1a) the registry's
 *    `configHashInputs()` (provider versions + every query-asset hash). Changing
 *    ignore rules, size caps, supported extensions, query budget, active langs, a
 *    provider version, OR a tags/imports `.scm` => stale_extractor.
 *    NOTE: grammar/engine hashes are deliberately NOT folded in (spec §6.2):
 *    stale_grammar (changed parse binary) is kept separable from stale_extractor.
 *  - `shardFreshnessStatus` — classify a stored shard against the current
 *    extractor_config_hash + per-language grammar hashes.
 */
import crypto from 'node:crypto';
import type {
  CoarseFreshness,
  CodeLang,
  ExtractorConfig,
  FileShard,
  FreshnessBadge,
  FreshnessStatus,
  Manifest,
} from './types.js';

/**
 * pln#601 — collapse the detailed 7-value {@link FreshnessStatus} into the coarse,
 * surface-uniform signal (`fresh|stale|partial|missing`). Every `stale_*` variant
 * rolls up to `stale`; `missing_index` → `missing`; `partial`/`fresh` pass through.
 * This is the SINGLE definition of the rollup so no surface can disagree.
 */
export function coarseFreshness(status: FreshnessStatus): CoarseFreshness {
  switch (status) {
    case 'fresh':
      return 'fresh';
    case 'partial':
      return 'partial';
    case 'missing_index':
      return 'missing';
    default:
      // stale_changed_files | stale_extractor | stale_grammar | stale_git_head
      return 'stale';
  }
}

/** pln#601 — stamp/refresh a badge's `coarse` rollup from its (possibly just-adjusted) status. */
export function withCoarse(b: FreshnessBadge): FreshnessBadge {
  return { ...b, coarse: coarseFreshness(b.status) };
}

/** Stable serialization: sort object keys recursively so hashing is order-independent. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * spec §5.1 / §9 — sha256 of (extractor_config + active language set + the
 * registry's provider/query-asset fingerprint). The active language set is the
 * sorted list of enabled languages, so enabling/disabling a language invalidates
 * affected shards as stale_extractor. `registryInputs` (from
 * `registry.configHashInputs()`) folds in provider `version` + every tags/imports
 * `.scm` hash, so editing a query asset flips affected shards to stale_extractor
 * (dec#109 P0#3). Optional + omitted-vs-undefined hash the same so legacy callers
 * (config-only) keep a stable hash for that input combination.
 */
export function computeExtractorConfigHash(
  config: ExtractorConfig,
  activeLanguages: string[],
  registryInputs?: unknown,
): string {
  const payload = {
    extractor_config: config,
    active_languages: [...activeLanguages].sort(),
    registry: registryInputs ?? null,
  };
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

export interface ShardFreshnessInput {
  shard: Pick<
    FileShard,
    'extractor_config_hash' | 'tree_sitter_grammar_hash' | 'lang' | 'parse_status'
  >;
  /** Current manifest-level extractor config hash. */
  currentExtractorConfigHash: string;
  /** Current per-language grammar hash lookup. */
  grammarHashFor: (lang: CodeLang) => string | undefined;
}

/**
 * spec §12.4 — classify a stored shard:
 *  - extractor_config_hash mismatch => stale_extractor
 *  - tree_sitter_grammar_hash mismatch => stale_grammar
 *  - otherwise fresh (content/path drift is the §6.1 read-path concern, Sprint 3)
 *
 * Precedence: extractor first, then grammar — both are "the binary/logic that
 * produced this shard changed", and the badge only needs to surface one reason;
 * extractor-config drift is the cheaper, more common cause.
 */
export function shardFreshnessStatus(input: ShardFreshnessInput): FreshnessStatus {
  const { shard } = input;
  if (shard.extractor_config_hash !== input.currentExtractorConfigHash) {
    return 'stale_extractor';
  }
  const expectedGrammar = input.grammarHashFor(shard.lang);
  if (
    expectedGrammar !== undefined &&
    shard.tree_sitter_grammar_hash != null &&
    shard.tree_sitter_grammar_hash !== expectedGrammar
  ) {
    return 'stale_grammar';
  }
  return 'fresh';
}

/**
 * Roll per-shard freshness up into a manifest-level freshness summary
 * (spec §5.1). `missing_index` when nothing parsed; otherwise the dominant
 * stale reason, else fresh.
 */
export function summarizeFreshness(
  shards: FileShard[],
): Manifest['freshness'] {
  if (shards.length === 0) {
    return { status: 'missing_index', stale_file_count: 0, partial_reason: null };
  }
  let staleExtractor = 0;
  let staleGrammar = 0;
  let staleChanged = 0;
  for (const s of shards) {
    switch (s.freshness.status) {
      case 'stale_extractor':
        staleExtractor++;
        break;
      case 'stale_grammar':
        staleGrammar++;
        break;
      case 'stale_changed_files':
        staleChanged++;
        break;
      default:
        break;
    }
  }
  const staleTotal = staleExtractor + staleGrammar + staleChanged;
  if (staleTotal === 0) {
    return { status: 'fresh', stale_file_count: 0, partial_reason: null };
  }
  // Surface the dominant reason for the manifest badge.
  let status: FreshnessStatus = 'stale_changed_files';
  if (staleExtractor >= staleGrammar && staleExtractor >= staleChanged) status = 'stale_extractor';
  else if (staleGrammar >= staleChanged) status = 'stale_grammar';
  return { status, stale_file_count: staleTotal, partial_reason: null };
}

/**
 * Read-path git-HEAD drift (trp_42688015).
 *
 * The index records the commit it was built against (`manifest.git.head`). The
 * per-file lazy read check (query.ts §6.1) only samples a query's candidate files
 * within a bounded budget, and `status` reports ONLY the write-side manifest
 * freshness (extractor/grammar hashes) — neither keys on git HEAD. So a whole-tree
 * move such as `git checkout <other-branch>` left the index reported `fresh`, and
 * find/brief could serve OLD-branch paths/symbols. This compares the index head to
 * the working tree's current head and, when they differ, sets a clean `fresh` badge
 * to the dedicated `stale_git_head` reason, recording the precise cause in
 * `details.git_head_changed`.
 *
 * `stale_git_head` is kept DISTINCT from `stale_changed_files` (review finding):
 * the latter means CONFIRMED per-file content/path drift (and carries a real
 * `stale_file_count`); a HEAD move is a weaker signal — "the index was built at
 * another commit, refresh recommended" — and must not masquerade as confirmed file
 * changes with a contradictory `stale_file_count: 0`.
 *
 * No-op when either head is unknown (non-git project, older manifest) or the heads
 * match — so existing fresh/non-git behaviour is unchanged. A badge that is already
 * non-`fresh` (stale_*, partial, missing_index) keeps its more-specific/equally-
 * actionable status; only the cause detail is added.
 */
export function applyGitHeadDrift(
  badge: FreshnessBadge,
  indexHead: string | null | undefined,
  currentHead: string | null | undefined,
): FreshnessBadge {
  if (!indexHead || !currentHead || indexHead === currentHead) return withCoarse(badge);
  const status: FreshnessStatus = badge.status === 'fresh' ? 'stale_git_head' : badge.status;
  return {
    status,
    coarse: coarseFreshness(status),
    details: {
      ...badge.details,
      git_head_changed: { index_head: indexHead, current_head: currentHead },
    },
  };
}
