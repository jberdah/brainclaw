/**
 * Code Map ↔ bclaw_work integration seam (spec §10).
 *
 * This is the ONLY place bclaw_work touches Code Map. It is strictly opt-in:
 * the section is produced only when the Code Map manifest carries
 * `code_map_enabled: true`. When the flag is off (the P0 default, and the case
 * for any project without a Code Map store), the helper returns `null` after a
 * single cheap manifest stat — it never parses, never refreshes, never blocks,
 * so bclaw_work latency is unchanged for the off path.
 *
 * Behaviour when enabled (spec §10 rules):
 *  - NEVER triggers a full (or any) refresh during bclaw_work.
 *  - Index missing  -> a short `missing_index` hint (no results).
 *  - Index stale    -> serve the find() results WITH the stale freshness badge.
 *  - Lock active    -> wait at most `max_query_wait_ms` (default 2500ms) for the
 *                      lock to clear; if it does not, serve last-known results if
 *                      available, else skip with a `partial` badge. Never blocks
 *                      bclaw_work beyond that bounded wait (rule §6 rule 8).
 */
import { readManifest } from './store.js';
import { withFreshness } from './freshness.js';
import { readCodeLock, isLockAbandoned } from './lock.js';
import { codeMapDir, lockPath } from './paths.js';
import { JsonlBackend } from './backend.js';
import type { CodeFindMatch } from './backend.js';
import type { FreshnessBadge } from './types.js';

/** Hard ceiling on how long the work-section may wait on an active lock (§6 rule 7, §10). */
export const WORK_SECTION_MAX_WAIT_MS = 2500;
/** Poll interval while waiting for a live lock to clear. */
const LOCK_POLL_MS = 100;

export interface CodeMapWorkSectionOpts {
  cwd?: string;
  preferredDirName?: string;
  /** Optional query to seed find(); falls back to the scope/contextTarget. */
  query?: string;
  /** Max matches to surface in the section. */
  limit?: number;
  /** Test seam: injected backend (defaults to a fresh JsonlBackend). */
  backend?: JsonlBackend;
  /** Test seam: clock for the bounded lock wait. */
  now?: () => number;
  /** Test seam: cooperative sleep used between lock polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: override the alive check used to classify the lock. */
  isPidAlive?: (pid: number) => boolean;
}

export interface CodeMapWorkSection {
  enabled: true;
  /** A short hint when the index has never been built (spec §10). */
  missing_index?: string;
  /** Symbol matches for the query, if any. May be empty on stale/partial. */
  matches: CodeFindMatch[];
  /** The freshness badge — always present so the agent can judge trust. */
  freshness_badge: FreshnessBadge;
  /** Present when an active lock forced a wait + degrade (spec §10). */
  lock_wait_ms?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is a competing Code Map lock currently *live* (not abandoned)? A live lock
 * means a refresh is in flight; we must not read mid-write as fresh.
 */
function liveLockPresent(opts: CodeMapWorkSectionOpts): boolean {
  const lock = readCodeLock(opts.cwd, opts.preferredDirName);
  if (!lock) return false;
  const now = (opts.now ?? Date.now)();
  // Reuse the §5.8 abandonment evaluation; an abandoned lock does not block.
  const storeDir = codeMapDir(opts.cwd, opts.preferredDirName);
  const lockFile = lockPath(opts.cwd, opts.preferredDirName);
  try {
    const abandoned = isLockAbandoned(lock, {
      now,
      isPidAlive: opts.isPidAlive ?? ((pid: number) => {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
      storeDir,
      lockFile,
    });
    return !abandoned;
  } catch {
    // If we cannot evaluate, treat as live (conservative): wait then degrade.
    return true;
  }
}

/**
 * Build the opt-in Code Map section for a bclaw_work response, or `null` when
 * Code Map is not enabled for this project. See the module header for the full
 * behaviour contract (spec §10).
 *
 * The single live call-site is `bclaw_work` in src/commands/mcp.ts — search for
 * `codeMapWorkSection(`.
 */
export async function codeMapWorkSection(
  cwd?: string,
  opts: CodeMapWorkSectionOpts = {},
): Promise<CodeMapWorkSection | null> {
  const ctx: CodeMapWorkSectionOpts = { ...opts, cwd: opts.cwd ?? cwd };

  // OFF PATH: one cheap manifest stat. No store / flag off -> nothing at all.
  const manifest = readManifest(ctx.cwd, ctx.preferredDirName);
  if (!manifest || manifest.code_map_enabled !== true) {
    return null;
  }

  const backend = ctx.backend ?? new JsonlBackend();
  const query = (ctx.query ?? '').trim();
  const limit = ctx.limit ?? 8;

  // LOCK PATH: bounded wait for an active (live) lock to clear (§10).
  let lockWaitMs: number | undefined;
  if (liveLockPresent(ctx)) {
    const sleep = ctx.sleep ?? defaultSleep;
    const now = ctx.now ?? Date.now;
    const deadline = now() + WORK_SECTION_MAX_WAIT_MS;
    while (now() < deadline && liveLockPresent(ctx)) {
      await sleep(LOCK_POLL_MS);
    }
    lockWaitMs = WORK_SECTION_MAX_WAIT_MS - Math.max(0, deadline - now());
    if (liveLockPresent(ctx)) {
      // Still locked after the bounded wait — degrade to partial. Serve
      // last-known matches if a query is present and the index is readable,
      // else skip the section content with a partial badge. Never block.
      if (query) {
        try {
          const out = await backend.find({
            query,
            limit,
            cwd: ctx.cwd,
            preferredDirName: ctx.preferredDirName,
          });
          return {
            enabled: true,
            matches: out.matches,
            freshness_badge: withFreshness({
              status: 'partial',
              details: { spot_check: { status: 'partial', partial_reason: 'code_map_lock_active' }, lock_wait_ms: lockWaitMs },
            }),
            lock_wait_ms: lockWaitMs,
          };
        } catch {
          /* fall through to skip */
        }
      }
      return {
        enabled: true,
        matches: [],
        freshness_badge: withFreshness({
          status: 'partial',
          details: { spot_check: { status: 'partial', partial_reason: 'code_map_lock_active' }, lock_wait_ms: lockWaitMs },
        }),
        lock_wait_ms: lockWaitMs,
      };
    }
  }

  // MISSING INDEX: nothing parsed yet (spec §10). Short hint, no results.
  if (manifest.freshness.status === 'missing_index') {
    return {
      enabled: true,
      missing_index:
        'Code Map index is empty for this project. Run `brainclaw code-map refresh --all` (or bclaw_code_refresh) before relying on find/brief.',
      matches: [],
      freshness_badge: withFreshness({ status: 'missing_index', details: {} }),
      ...(lockWaitMs !== undefined ? { lock_wait_ms: lockWaitMs } : {}),
    };
  }

  // FRESH or STALE: run find() (read-only, never refreshes). The backend's
  // lazy read-path check (§6.1) returns the true freshness badge, so stale
  // results are surfaced WITH the stale badge rather than hidden.
  if (!query) {
    // Use the same read-only index observation as bclaw_code_status. This keeps
    // bclaw_work aligned with status/find/brief for git-HEAD drift too, while
    // still avoiding any lazy refresh or source parsing.
    const status = await backend.status({ cwd: ctx.cwd, preferredDirName: ctx.preferredDirName });
    return {
      enabled: true,
      matches: [],
      freshness_badge: status.freshness_badge,
      ...(lockWaitMs !== undefined ? { lock_wait_ms: lockWaitMs } : {}),
    };
  }

  const out = await backend.find({
    query,
    limit,
    cwd: ctx.cwd,
    preferredDirName: ctx.preferredDirName,
  });
  return {
    enabled: true,
    matches: out.matches,
    freshness_badge: out.freshness_badge,
    ...(lockWaitMs !== undefined ? { lock_wait_ms: lockWaitMs } : {}),
  };
}

/** A next_action suggestion (mirrors the bclaw_work `next_actions` element shape). */
export interface CodeMapNextAction {
  tool: string;
  args: Record<string, unknown>;
  when: string;
}

/**
 * Derive the onboarding/freshness next_action(s) from a Code Map work section
 * (pln#588 adoption). The passive `missing_index` hint string was easy for agents
 * to skip; promoting the refresh to a first-class `next_action` makes a fresh or
 * stale project's first `bclaw_work` actively nudge the agent to build/update the
 * index — without ever refreshing here. Pure + side-effect-free so it can be
 * unit-locked; the bclaw_work handler spreads the result into its next_actions.
 *  - missing_index -> build the whole index (`scope: all`)
 *  - stale_*       -> refresh changed files (`scope: changed`)
 *  - fresh/partial/null -> nothing (don't nag on a usable index or a transient lock)
 */
export function codeMapRefreshNextActions(section: CodeMapWorkSection | null): CodeMapNextAction[] {
  if (!section) return [];
  if (section.missing_index) {
    return [
      {
        tool: 'bclaw_code_refresh',
        args: { scope: 'all' },
        when: 'Code Map index is empty — build it so bclaw_code_find/brief can orient you before editing',
      },
    ];
  }
  if (section.freshness_badge?.freshness === 'stale') {
    return [
      {
        tool: 'bclaw_code_refresh',
        args: { scope: 'changed' },
        when: 'Code Map is stale — refresh changed files before relying on bclaw_code_find/brief',
      },
    ];
  }
  return [];
}
