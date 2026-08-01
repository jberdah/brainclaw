/**
 * pln#636 C2 — server-side lazy conformity reconcile.
 *
 * WHY SERVER-SIDE AT ALL. C1's PreToolUse hook only reaches hook-capable hosts.
 * The workers that most need a scope signal are the ones that reach nothing: a
 * spawned sandboxed lane never sees MCP, never loads a hook, and reports through
 * a file. So the universal net has to live where the *outcome* is ingested, not
 * where the write happens. Reconcile at the lifecycle boundaries every tier
 * eventually crosses — release, assignment completion, harvest ingestion,
 * session end — per the validated lazy-reconcile pattern. No daemon, no watcher.
 *
 * WHY POST-HOC IS THE HONEST SHAPE. By the time any of these fire the write has
 * already landed. The only truthful output is an advisory that names the strays
 * and the two calls that resolve them — never an error, never a block
 * (trp_5f342186 is the scar tissue).
 *
 * THE BASELINE PROBLEM, and why `base_sha` exists (C0-b, review F3). Neither
 * `git diff HEAD` nor the worktree's dirty set is authoritative: a lane that
 * commits mid-work moves the ground under both, so the same claim would read
 * "touched nothing" the moment it committed. The comparison runs against the
 * commit recorded at claim creation — a fixed point — and unions in the dirty
 * set so uncommitted work counts too.
 *
 * SILENT ON DOUBT. Every degradation path (no baseline, no git, detached
 * worktree, unreadable repo) yields `unverifiable`, which emits NOTHING. The
 * acceptance bar for this whole design is a zero false-positive rate on the real
 * 613-claim corpus, and 42.4% of that corpus is not path-resolvable at all.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { assessScopeConformity, type ConformityVerdict } from './claim-scope.js';
import type { NextAction } from './facade-schema.js';
import type { StructuredWarningInput } from './warnings.js';
import type { Claim } from './schema.js';

/** Cap on how many stray paths ride along in a warning payload. */
const MAX_REPORTED_PATHS = 10;

/**
 * Run git and return stdout, or undefined on ANY failure.
 *
 * Never throws and never inspects stderr: a conformity nicety may not degrade
 * the workflow it observes, so an unavailable git, a detached worktree or a
 * garbage-collected branch all read as "cannot tell".
 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    return r.stdout;
  } catch {
    return undefined;
  }
}

function splitPaths(out: string | undefined): string[] {
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Split WITHOUT trimming, for `--porcelain` output.
 *
 * The porcelain prefix is fixed-width — status codes in columns 1-2, a space in
 * column 3, path from index 3 — so a leading space is DATA. Trimming ` M
 * src/x.ts` first turns the subsequent `slice(3)` into `rc/x.ts`: a path that
 * matches no pathspec and reads as a stray, i.e. a false accusation on every
 * unstaged edit.
 */
function splitLinesRaw(out: string | undefined): string[] {
  if (!out) return [];
  return out.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/**
 * Where a claim's work physically happened: its own worktree when it has one,
 * otherwise the project root. A lane claim's diff is meaningless read from the
 * coordinator's checkout.
 */
function claimWorkdir(claim: Claim, cwd: string): string | undefined {
  const dir = claim.worktree_path ?? cwd;
  try {
    return fs.existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export interface TouchedPathsResult {
  paths: string[];
  /** Populated when the footprint could NOT be established. */
  unverifiableReason?: string;
}

/**
 * Files this claim's worker touched since the claim was created.
 *
 * Union of two sources, because either alone lies:
 *  - `git diff --name-only <base_sha>` — everything committed since the
 *    baseline, which the dirty set loses the instant a lane commits.
 *  - `git status --porcelain` — uncommitted work, which the diff cannot see.
 *
 * A claim with no `base_sha` (created outside a repo, or before C0-b shipped) is
 * unverifiable rather than compared against a guessed baseline.
 */
export function collectTouchedPaths(claim: Claim, cwd: string): TouchedPathsResult {
  const workdir = claimWorkdir(claim, cwd);
  if (!workdir) return { paths: [], unverifiableReason: 'claim worktree no longer exists' };
  if (!claim.base_sha) return { paths: [], unverifiableReason: 'claim has no recorded base_sha baseline' };

  // Confirm the baseline is still reachable before trusting a diff against it —
  // a pruned worktree branch would otherwise make git fail and read as "clean".
  if (git(workdir, ['cat-file', '-e', `${claim.base_sha}^{commit}`]) === undefined) {
    return { paths: [], unverifiableReason: 'recorded base_sha is no longer reachable in this worktree' };
  }

  const committed = splitPaths(git(workdir, ['diff', '--name-only', claim.base_sha]));
  // -uall so a whole new untracked directory is reported file-by-file rather
  // than collapsed to its directory name, which no pathspec would match.
  const dirty = splitLinesRaw(git(workdir, ['status', '--porcelain', '-uall']))
    .map((line) => line.slice(3).trim())
    // A rename reads `R  old -> new`; the destination is what was written.
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .map((p) => p.replace(/^"|"$/g, ''));

  const paths = [...new Set([...committed, ...dirty])].filter((p) => p.length > 0);
  return { paths };
}

export interface ClaimConformityResult {
  verdict: ConformityVerdict;
  /** The paths compared — useful for diagnostics even when in scope. */
  touchedPaths: string[];
  /** Present ONLY for `out_of_scope`. Nothing is emitted otherwise. */
  warning?: StructuredWarningInput;
}

function widenNextActions(claim: Claim, unexpected: string[]): NextAction[] {
  return [
    {
      tool: 'bclaw_update',
      args: {
        entity: 'claim',
        id: claim.id,
        // Widening means declaring the footprint, not rewriting the prose scope:
        // `paths[]` is the machine-readable half (C0-b) and is additive.
        paths: unexpected.slice(0, MAX_REPORTED_PATHS),
      },
      when: 'the work legitimately spans these paths — declare them so the next reconcile is silent',
    },
    {
      tool: 'bclaw_create',
      args: {
        entity: 'trap',
        title: `Work on ${claim.scope} pulls in ${unexpected[0]}`,
        body: 'Recurring coupling found by a claim-scope reconcile. Record why these move together.',
      },
      when: 'the strays reveal a real coupling worth warning the next agent about',
    },
  ];
}

/**
 * Assess one claim's scope conformity, and build the advisory when — and only
 * when — there is a concrete, path-resolvable violation to report.
 *
 * Returns `unverifiable` freely. That is the designed default, not a failure:
 * an accuser that is wrong 42% of the time teaches agents to ignore the channel,
 * which is strictly worse than shipping nothing (the pln#634 failure mode).
 */
export interface ReconcileOptions {
  /**
   * An explicit footprint, used INSTEAD of reading git.
   *
   * This is the file-fallback tier's own statement: a `LANE-RESULT.json` carries
   * `files_changed`, written by a worker that may never have reached MCP and
   * whose worktree may already have been reaped by the time we harvest. Trusting
   * that list is both cheaper and more accurate than a git diff we might not be
   * able to run — and it is precisely the tier C2 exists to cover (review F3).
   */
  touchedPaths?: readonly string[];
}

export function reconcileClaimConformity(
  claim: Claim,
  cwd: string,
  options: ReconcileOptions = {},
): ClaimConformityResult {
  const touched = options.touchedPaths
    ? { paths: [...options.touchedPaths].filter((p) => p.trim().length > 0) }
    : collectTouchedPaths(claim, cwd);
  if (touched.unverifiableReason) {
    return {
      verdict: { kind: 'unverifiable', reason: touched.unverifiableReason },
      touchedPaths: [],
    };
  }

  // A declared `paths[]` footprint is the claim's own machine-readable statement
  // of intent, so it outranks the prose scope when present — that is the entire
  // reason C0-b made it optional-but-additive.
  //
  // Comma, not space: `resolveScopeToPathspecs` splits on ',' and treats any
  // whitespace inside a token as proof of prose (dirty-scope.ts:143-154), so a
  // space-joined list would silently classify as unverifiable.
  const declared = claim.paths?.length ? claim.paths.join(',') : claim.scope;
  const verdict = assessScopeConformity({
    scope: declared,
    cwd: claimWorkdir(claim, cwd) ?? cwd,
    touchedPaths: touched.paths,
  });

  if (verdict.kind !== 'out_of_scope') {
    return { verdict, touchedPaths: touched.paths };
  }

  const shown = verdict.unexpected.slice(0, MAX_REPORTED_PATHS);
  const overflow = verdict.unexpected.length - shown.length;
  return {
    verdict,
    touchedPaths: touched.paths,
    warning: {
      code: 'wrote_outside_claim_scope',
      message:
        `Claim ${claim.id} declared '${claim.scope}' but ${verdict.unexpected.length} touched `
        + `file(s) sit outside it: ${shown.join(', ')}`
        + (overflow > 0 ? ` (+${overflow} more)` : '')
        + '. Advisory only — the work is already written.',
      data: {
        claim_id: claim.id,
        scope: claim.scope,
        declared_pathspecs: verdict.pathspecs,
        unexpected_paths: shown,
        ...(overflow > 0 ? { unexpected_paths_omitted: overflow } : {}),
        base_sha: claim.base_sha,
      },
      next_actions: widenNextActions(claim, verdict.unexpected),
    },
  };
}
