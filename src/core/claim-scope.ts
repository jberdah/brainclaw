/**
 * pln#636 C0-a — claim scope grammar + conformity verdict.
 *
 * WHY THIS IS SMALL. The design originally called for a fresh classifier. It is
 * not needed: `resolveScopeToPathspecs` (core/dirty-scope.ts) already resolves a
 * free-string scope to git pathspecs or `unknown`, and its own header has
 * documented the bifurcation since pln#520 ("~60% are not resolvable to paths at
 * all"). Writing a second classifier would have been duplicated truth. This
 * module adds only the two things that were genuinely missing.
 *
 * MISSING PIECE 1 — a DECLARED grammar for the reserved semantic prefixes.
 * dirty-scope hardcodes `review-loop:` alone (line ~149), but production carries
 * three variants. Census over the 613 live claims in this store:
 *
 *     review-loop           133
 *     ideate-loop             5
 *     ideation-loop           2
 *     C                       1   ← a WINDOWS DRIVE LETTER, not a prefix
 *     project-resolution      1   ← prose that happens to contain a colon
 *     worktree-as-contract    1   ← ditto
 *
 * Two traps fall straight out of that data. A naive `/^[a-z-]+:/i` would read
 * `C:/Users/...` as a semantic scope and stop treating an absolute Windows path
 * as a path. And an unknown `word:` prefix is prose, not a loop reference — so
 * the reserved set is ENUMERATED, never inferred from shape.
 *
 * MISSING PIECE 2 — the verdict's default on `unknown` must be INVERTED relative
 * to the dirty guard, and this is the load-bearing insight of C0:
 *
 *   - The dirty guard BLOCKS on unknown. Its cardinal rule is that a noisy,
 *     visible false-positive beats a silent false-negative, because letting a
 *     worker edit stale code is worse than refusing a legitimate dispatch.
 *   - A conformity advisory must be SILENT on unknown. Accusing an agent of
 *     writing outside its scope when we cannot tell teaches it to ignore the
 *     channel (the pln#634 failure mode) — and a channel an agent has learned to
 *     skip is worse than no channel. Saying nothing costs nothing.
 *
 * Same classification, opposite correct default, because the cost of being wrong
 * points the other way. Hence `unverifiable` is a first-class verdict every
 * consumer must render as silence.
 *
 * @module
 */
import path from 'node:path';
import { resolveScopeToPathspecs } from './dirty-scope.js';

/**
 * Reserved semantic prefixes, enumerated from production usage. A scope starting
 * with one of these refers to a loop lane, never to files.
 *
 * `ideate-loop` and `ideation-loop` BOTH appear in the live store — an
 * inconsistency in the emitting code, not here. Both are accepted so
 * classification is correct today; unifying the emitters is a separate cleanup.
 */
export const RESERVED_SCOPE_PREFIXES = ['review-loop', 'ideate-loop', 'ideation-loop'] as const;

export type ClaimScopeKind = 'paths' | 'loop_ref' | 'prose' | 'empty';

export interface ClassifiedClaimScope {
  kind: ClaimScopeKind;
  /** Populated for kind='loop_ref'. */
  loopRef?: { prefix: string; loopId: string; slotId?: string };
  /** Populated for kind='paths' — git pathspecs, from the shared resolver. */
  pathspecs?: string[];
  /** Why the scope is not path-resolvable. Carried for observability, not blame. */
  reason?: string;
}

/** True when the token is an absolute Windows path (`C:/…`), not a prefixed scope. */
function looksLikeWindowsDrive(scope: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(scope);
}

/**
 * Classify a claim scope.
 *
 * Order matters: the drive-letter check runs BEFORE the prefix check, because
 * `C:` satisfies a naive prefix pattern while being a path.
 */
export function classifyClaimScope(scope: string | undefined, cwd: string): ClassifiedClaimScope {
  const trimmed = scope?.trim();
  if (!trimmed) return { kind: 'empty', reason: 'no scope recorded on the claim' };

  if (!looksLikeWindowsDrive(trimmed)) {
    for (const prefix of RESERVED_SCOPE_PREFIXES) {
      if (!trimmed.toLowerCase().startsWith(`${prefix}:`)) continue;
      const rest = trimmed.slice(prefix.length + 1);
      const [loopId, slotId] = rest.split(':');
      return {
        kind: 'loop_ref',
        loopRef: {
          prefix,
          loopId: (loopId ?? '').trim(),
          ...(slotId?.trim() ? { slotId: slotId.trim() } : {}),
        },
        reason: `scope refers to a ${prefix} lane, not to files`,
      };
    }
  }

  const resolved = resolveScopeToPathspecs(trimmed, cwd);
  if (resolved.kind === 'pathspecs') return { kind: 'paths', pathspecs: resolved.pathspecs };
  return { kind: 'prose', reason: resolved.reason };
}

export type ConformityVerdict =
  | { kind: 'in_scope'; matched: string[] }
  | { kind: 'out_of_scope'; unexpected: string[]; pathspecs: string[] }
  | { kind: 'unverifiable'; reason: string };

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** A touched file is in scope when it equals or sits under one declared pathspec. */
function matchesPathspec(file: string, pathspec: string): boolean {
  const f = normalise(file);
  const spec = normalise(pathspec.replace(/^:\(glob\)/, '')).replace(/\/$/, '');
  if (spec.includes('*') || spec.includes('?')) {
    // Delegating real globs to git is the resolver's job; here a glob scope is
    // deliberately unverifiable rather than approximated with a hand-rolled matcher.
    return false;
  }
  return f === spec || f.startsWith(`${spec}/`);
}

/**
 * Compare the files a claim actually touched against the scope it declared.
 *
 * SILENT ON DOUBT, by construction. A loop-ref, prose, empty or glob scope
 * yields `unverifiable`, and so does an empty touched-file list — there is
 * nothing to accuse anyone of. Only a path-resolvable scope with concrete
 * touched files can ever produce `out_of_scope`.
 */
export function assessScopeConformity(input: {
  scope: string | undefined;
  cwd: string;
  /** Files touched since the claim's baseline, repo-relative. */
  touchedPaths: readonly string[];
}): ConformityVerdict {
  const classified = classifyClaimScope(input.scope, input.cwd);
  if (classified.kind !== 'paths' || !classified.pathspecs?.length) {
    return { kind: 'unverifiable', reason: classified.reason ?? 'scope is not path-resolvable' };
  }
  if (input.touchedPaths.length === 0) {
    return { kind: 'unverifiable', reason: 'no touched files to compare' };
  }
  if (classified.pathspecs.some((spec) => spec.includes('*') || spec.includes('?'))) {
    return { kind: 'unverifiable', reason: 'glob scope — left to git rather than approximated here' };
  }

  const specs = classified.pathspecs;
  const matched: string[] = [];
  const unexpected: string[] = [];
  for (const file of input.touchedPaths) {
    // The coordination store and git internals are never "outside scope": every
    // brainclaw call rewrites them, so counting them would accuse every agent.
    const n = normalise(file);
    if (n.startsWith('.brainclaw/') || n.startsWith('.git/')) continue;
    if (specs.some((spec) => matchesPathspec(file, spec))) matched.push(n);
    else unexpected.push(n);
  }

  if (unexpected.length === 0) {
    return matched.length > 0
      ? { kind: 'in_scope', matched }
      : { kind: 'unverifiable', reason: 'every touched file was a system path' };
  }
  return { kind: 'out_of_scope', unexpected, pathspecs: specs };
}

/**
 * Absolute→relative helper for callers holding worktree-absolute paths (a git
 * diff run inside a lane worktree returns repo-relative already, but a hook sees
 * absolute `tool_input.file_path`).
 */
export function toRepoRelative(absoluteOrRelative: string, repoRoot: string): string {
  if (!path.isAbsolute(absoluteOrRelative)) return normalise(absoluteOrRelative);
  return normalise(path.relative(repoRoot, absoluteOrRelative));
}
