/**
 * Coordination-hygiene policy (pln#602).
 *
 * Family-level TTL + serve-count thresholds that govern the lazy sweep at the
 * bclaw_work read path and the full sweep at session-start. Keeping the policy
 * in one place lets `brainclaw doctor --hygiene` describe the current governance
 * to operators without chasing constants across five modules.
 *
 * Design contract:
 *   - **Park-don't-delete.** Every TTL crossing must transit through a canonical
 *     grammar (transitionAssignment expired/timed_out, handoff archive) or write
 *     a backup file before unlinking. No policy field toggles deletion.
 *   - **Serve-count K is UX budget, not memory GC.** Once a stale_warning or
 *     workflow_hint has been rendered `k` times we swap it for an aggregate
 *     counter so the agent gets ONE actionable pointer instead of the same
 *     three lines every session (fable-audit-2026-07 empirical evidence).
 *   - **Opt-out means literally opt-out.** `disabled: true` bypasses BOTH the
 *     sweep and the aging — archive stores that curate their own retention
 *     stay in charge.
 *
 * @module
 */
import { loadConfig } from './config.js';
import { logger } from './logger.js';

export interface HygienePolicy {
  /** When true, hygiene passes are no-ops (config opt-out for archive stores). */
  disabled: boolean;
  /** Offered assignment with no heartbeat for this long → expired. */
  assignment_offered_ttl_ms: number;
  /** Accepted assignment with no heartbeat for this long → timed_out. */
  assignment_accepted_ttl_ms: number;
  /** Started assignment with no heartbeat for this long → timed_out. */
  assignment_started_ttl_ms: number;
  /** Closed auto-generated handoff older than this → archived. */
  handoff_closed_ttl_ms: number;
  /** Stale-warning served this many times → replaced by aggregate. */
  stale_warning_serve_k: number;
  /** Workflow hint served this many times → replaced by aggregate. */
  workflow_hint_serve_k: number;
  /** Max items to touch per read-path sweep (perf guard for bclaw_work). */
  read_path_sweep_budget: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_HYGIENE_POLICY: HygienePolicy = {
  disabled: false,
  // A never-accepted dispatch should not survive into the next day's dogfood.
  assignment_offered_ttl_ms: 1 * DAY_MS,
  assignment_accepted_ttl_ms: 1 * DAY_MS,
  assignment_started_ttl_ms: 1 * DAY_MS,
  handoff_closed_ttl_ms: 30 * DAY_MS,
  stale_warning_serve_k: 3,
  workflow_hint_serve_k: 3,
  read_path_sweep_budget: 25,
};

/** The override keys HygieneConfigSchema declares — used to detect typos. */
const HYGIENE_POLICY_KEYS: ReadonlyArray<keyof HygienePolicy> = [
  'disabled',
  'assignment_offered_ttl_ms',
  'assignment_accepted_ttl_ms',
  'assignment_started_ttl_ms',
  'handoff_closed_ttl_ms',
  'stale_warning_serve_k',
  'workflow_hint_serve_k',
  'read_path_sweep_budget',
];

/**
 * Best-effort load: any policy override is merged on top of the defaults.
 * Config parse errors fall back silently to defaults so a broken config.yaml
 * cannot break every bclaw_work call.
 *
 * `config.hygiene` is now declared by ConfigSchema (HygieneConfigSchema), so
 * valid overrides survive the zod parse instead of being stripped (Codex review
 * of PR #48, HIGH — the previous `as unknown as { hygiene? }` cast read a key
 * the schema had already discarded, so `disabled`/TTL overrides never applied).
 * Undefined fields (partial override or an unknown/typo sub-key that the schema
 * stripped) fall back to DEFAULT_HYGIENE_POLICY; a typo is logged so the drop is
 * not fully silent, consistent with the store-wide strip convention.
 */
export function loadHygienePolicy(cwd?: string): HygienePolicy {
  try {
    const config = loadConfig(cwd) as { hygiene?: Partial<HygienePolicy> & Record<string, unknown> };
    const overrides = config.hygiene ?? {};
    for (const key of Object.keys(overrides)) {
      if (!HYGIENE_POLICY_KEYS.includes(key as keyof HygienePolicy)) {
        logger.warn(`config.hygiene: unknown key "${key}" ignored (valid keys: ${HYGIENE_POLICY_KEYS.join(', ')})`);
      }
    }
    // Drop undefined values so a partial override never overwrites a default with undefined.
    const defined = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ) as Partial<HygienePolicy>;
    return { ...DEFAULT_HYGIENE_POLICY, ...defined };
  } catch {
    return { ...DEFAULT_HYGIENE_POLICY };
  }
}
