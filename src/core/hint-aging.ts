/**
 * Serve-count aging for stale_warnings + workflow_hints (pln#602).
 *
 * Empirical driver: fable-audit-2026-07 opened with three stale_warnings from
 * 87 days ago (pln_0e4a848b, rtn_d5a940c3, rtn_5eb68c9e) rendered in full at
 * every session, plus a workflow_hint "confirm or retire dec_426b3b00" served
 * on repeat for months. Agents learn to skim past that noise — which is
 * exactly the reflex we cannot afford.
 *
 * Contract: an entry is served in detail `k` times, then folded into a single
 * aggregate line that carries the folded IDS themselves (trp_336e8054: it used
 * to point at `bclaw_find(status:'stale')`, a filter that returns nothing
 * because staleness is computed, not stored) so the agent still has one clear,
 * WORKING pointer. The counter is a small JSON file, safe to lose — hitting it
 * twice per stale item is worse than losing it once, and a missing file just
 * resets counts to zero.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveEntityDir } from './io.js';
import { logger } from './logger.js';
import { loadHygienePolicy, type HygienePolicy } from './hygiene-policy.js';
import type { StalenessWarning } from './staleness.js';

// ── Persistence types ───────────────────────────────────────────

export interface ServeCounter {
  count: number;
  first_at: string;
  last_at: string;
}

export interface ServeRegistry {
  schema_version: 1;
  warnings: Record<string, ServeCounter>;
  hints: Record<string, ServeCounter>;
}

function makeEmptyRegistry(): ServeRegistry {
  return { schema_version: 1, warnings: {}, hints: {} };
}

function registryFile(cwd: string): string {
  const dir = resolveEntityDir('coordination/hygiene', cwd, 'write');
  return path.join(dir, 'serve-counter.json');
}

export function loadServeRegistry(cwd?: string): ServeRegistry {
  const root = cwd ?? process.cwd();
  const file = registryFile(root);
  if (!fs.existsSync(file)) return makeEmptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ServeRegistry>;
    return {
      schema_version: 1,
      warnings: parsed.warnings ?? {},
      hints: parsed.hints ?? {},
    };
  } catch (err) {
    logger.debug('hint-aging: failed to read serve counter, resetting', err);
    return makeEmptyRegistry();
  }
}

export function saveServeRegistry(registry: ServeRegistry, cwd?: string): void {
  const root = cwd ?? process.cwd();
  const file = registryFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(registry, null, 2), 'utf-8');
  } catch (err) {
    logger.debug('hint-aging: failed to write serve counter', err);
  }
}

// ── Aging logic ─────────────────────────────────────────────────

export interface AgeStaleWarningsResult {
  /** The warnings the caller should actually render (detail entries only). */
  warnings: StalenessWarning[];
  /** When present, a single aggregate hint replacing the folded-away items. */
  aggregate?: string;
  /** IDs whose serve counter was bumped this call. */
  served_ids: string[];
  /** IDs whose serve count reached or passed the threshold. */
  folded_ids: string[];
}

export interface AgeWorkflowHintsResult {
  hints: string[];
  aggregate?: string;
  served_ids: string[];
  folded_ids: string[];
}

export interface AgeOptions {
  /** Override policy (tests). */
  policy?: HygienePolicy;
  /**
   * When false, do NOT persist any counter updates — used by the doctor
   * report to preview the effect without writing state.
   */
  recordServe?: boolean;
  /** Override current time for deterministic tests. */
  nowMs?: number;
  /** Pre-loaded registry to avoid re-reading in the same call. */
  registry?: ServeRegistry;
}

function bump(counter: ServeCounter | undefined, nowIso: string): ServeCounter {
  if (!counter) return { count: 1, first_at: nowIso, last_at: nowIso };
  return { count: counter.count + 1, first_at: counter.first_at, last_at: nowIso };
}

/**
 * Fold stale warnings served ≥ k times into a single aggregate line. The
 * aggregate carries the folded item IDS (grouped by entity) so the agent has
 * an exact, executable next-action — never a filter the engine cannot resolve
 * (trp_336e8054).
 *
 * Idempotence: calling with recordServe=false is pure — the returned split is
 * derived from the current registry alone. With recordServe=true the counter
 * bumps by one per warning ID in `warnings`, and folded_ids may grow on the
 * NEXT call as items cross the threshold.
 */
export function ageStaleWarnings(
  warnings: StalenessWarning[],
  cwd?: string,
  options: AgeOptions = {},
): AgeStaleWarningsResult {
  const policy = options.policy ?? loadHygienePolicy(cwd);
  if (policy.disabled) {
    return { warnings, served_ids: [], folded_ids: [] };
  }

  const registry = options.registry ?? loadServeRegistry(cwd);
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const k = policy.stale_warning_serve_k;
  const detail: StalenessWarning[] = [];
  const folded: StalenessWarning[] = [];
  const served_ids: string[] = [];
  const folded_ids: string[] = [];

  for (const w of warnings) {
    const existing = registry.warnings[w.id];
    const seenCount = existing?.count ?? 0;
    if (seenCount >= k) {
      folded.push(w);
      folded_ids.push(w.id);
    } else {
      detail.push(w);
      served_ids.push(w.id);
      if (options.recordServe !== false) {
        registry.warnings[w.id] = bump(existing, nowIso);
      }
    }
  }

  if (options.recordServe !== false && served_ids.length > 0 && cwd !== undefined) {
    saveServeRegistry(registry, cwd);
  }

  let aggregate: string | undefined;
  if (folded.length > 0) {
    // trp_336e8054 — the aggregate used to recommend `bclaw_find(status:'stale')`,
    // a filter that returns NOTHING: staleness is COMPUTED at session-start, never
    // stored as a status, so the operator could not retrieve the very items the
    // line announced. The folded items are in hand right here — carry their ids,
    // grouped by entity, so the recovery (`bclaw_get` each id) works verbatim.
    const byEntity = new Map<string, string[]>();
    for (const w of folded) {
      const ids = byEntity.get(w.entity) ?? [];
      ids.push(w.id);
      byEntity.set(w.entity, ids);
    }
    const ID_CAP = 8;
    const parts = [...byEntity.entries()].map(([entity, ids]) => {
      const shown = ids.slice(0, ID_CAP);
      const overflow = ids.length - shown.length;
      return `${ids.length} ${entity}${ids.length === 1 ? '' : 's'}: ${shown.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`;
    });
    // trp_dc9ca61e — do not recommend bclaw_transition for runtime_notes: they
    // have no lifecycle and the call errors. bclaw_remove (archive by default)
    // is their retirement path.
    aggregate = `${folded.length} stale item${folded.length === 1 ? '' : 's'} you've already been offered (${parts.join('; ')}) — bclaw_get each id to review; retire with bclaw_transition, or bclaw_remove for runtime_notes (no lifecycle).`;
  }

  return { warnings: detail, aggregate, served_ids, folded_ids };
}

/**
 * Fold workflow hints served ≥ k times. Hints have no stable ID — we key on
 * their normalised text so the same "confirm or retire dec_426b3b00" line
 * folds even across sessions.
 */
export function ageWorkflowHints(
  hints: string[],
  cwd?: string,
  options: AgeOptions = {},
): AgeWorkflowHintsResult {
  const policy = options.policy ?? loadHygienePolicy(cwd);
  if (policy.disabled) {
    return { hints, served_ids: [], folded_ids: [] };
  }

  const registry = options.registry ?? loadServeRegistry(cwd);
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const k = policy.workflow_hint_serve_k;
  const detail: string[] = [];
  const folded: string[] = [];
  const served_ids: string[] = [];
  const folded_ids: string[] = [];

  for (const h of hints) {
    const key = hintKey(h);
    const existing = registry.hints[key];
    const seenCount = existing?.count ?? 0;
    if (seenCount >= k) {
      folded.push(h);
      folded_ids.push(key);
    } else {
      detail.push(h);
      served_ids.push(key);
      if (options.recordServe !== false) {
        registry.hints[key] = bump(existing, nowIso);
      }
    }
  }

  if (options.recordServe !== false && served_ids.length > 0 && cwd !== undefined) {
    saveServeRegistry(registry, cwd);
  }

  let aggregate: string | undefined;
  if (folded.length > 0) {
    aggregate = `${folded.length} workflow hint${folded.length === 1 ? '' : 's'} you've already been offered — bclaw_context(kind:'workflow_hints') to review.`;
  }

  return { hints: detail, aggregate, served_ids, folded_ids };
}

/**
 * Normalise a workflow-hint text into a stable key. The generator interpolates
 * counts and IDs, so keying on the raw text would give every "3 in-progress
 * plan(s)…" variant its own counter. Strip digits and known ID prefixes.
 */
function hintKey(text: string): string {
  return text
    .replace(/\d+/g, '#')
    .replace(/\b(pln|rtn|dec|trp|clm|asgn|sess|cnd|hnd|con)_[a-f0-9]{4,}\b/g, '$1_#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Doctor helpers ─────────────────────────────────────────────

export interface ServeStats {
  total: number;
  over_threshold: number;
  median_count: number;
  oldest_first_at?: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeServeStats(counters: Record<string, ServeCounter>, threshold: number): ServeStats {
  const values = Object.values(counters);
  const counts = values.map((c) => c.count);
  const first_ats = values.map((c) => c.first_at).sort();
  return {
    total: values.length,
    over_threshold: counts.filter((c) => c >= threshold).length,
    median_count: median(counts),
    oldest_first_at: first_ats[0],
  };
}

export const __testing = { hintKey } as const;
