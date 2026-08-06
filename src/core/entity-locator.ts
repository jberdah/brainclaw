/**
 * pln#649 step 2 (dec#153) — locate the store that OWNS an entity, by id.
 *
 * THE PROBLEM THIS SOLVES. dec#153 made the entity the routing authority: for any
 * work unit, `owner_project` is fixed at creation and every read/mutation must
 * reach THAT store, regardless of pid, cwd, session or the shared global pointer.
 * Step 1 persisted the owner *inside* the record — but to read that field you must
 * first find the file, which is the very thing ambient resolution gets wrong. This
 * module breaks that circle: it finds the record by probing a BOUNDED candidate
 * set, so a worker holding only an `assignment_id` can be routed correctly without
 * anything ambient being trusted.
 *
 * WHY A PROBE AND NOT AN INDEX. The plan allowed an index; the code does not need
 * one, and an index would be strictly worse here:
 *   - the candidate set is already enumerable and small (the store itself, the
 *     workspace's nested children, declared cross-project links) — one `existsSync`
 *     each, and the current store is probed FIRST so the overwhelmingly common
 *     single-project case costs exactly one stat;
 *   - an index is a second source of truth that can go stale, be half-written, or
 *     disagree with the filesystem — and the whole point of dec#153 is to stop
 *     trusting a derived answer over the record itself;
 *   - `resolveEntityDir` is store-LOCAL (io.ts:79-107 — it joins memoryDir(cwd)
 *     and falls back only to a legacy path inside the SAME store), so each probe
 *     is properly isolated and cannot leak a parent store's hit.
 * If enumeration ever becomes expensive (hundreds of projects), a cache belongs in
 * FRONT of this function, not instead of it.
 *
 * AMBIGUITY IS A RESULT, NOT AN ERROR. Two stores holding the same id is exactly
 * the divergence T3 must refuse on (step 4), so it is reported as `ambiguous` with
 * every match rather than silently resolved by first-wins. Callers decide; this
 * module never picks a winner it cannot justify.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { resolveCrossProjectLinks } from './cross-project.js';
import { entityRecordPaths, MEMORY_DIR } from './io.js';
import { resolvePrimaryStore, resolveWorkspaceRoot } from './store-resolution.js';
import { scanNestedBrainclawProjectsDetailed, summarizeWorkspaceProjects } from './workspace-projects.js';

/** Entity kinds whose records live in a per-store directory keyed by id. */
export type LocatableEntity = 'assignment' | 'claim' | 'agent_run' | 'plan' | 'loop';

/**
 * Depth ceiling for nested-store scans.
 *
 * Review P1-2 offered two remedies for the false `not_found` at depth 7: raise the
 * ceiling, or report incompleteness. I tried raising it to 12 and MEASURED the
 * result — a test whose resolved workspace root was a large shared directory took
 * 130 SECONDS in enumeration alone. Trading a false `not_found` for a pathological
 * walk on a routing path is the worse defect, and it validated this review's own
 * warning about hidden enumeration cost. So the ceiling stays at the underlying
 * default and the enumeration REPORTS when it stopped early (`incomplete`), which
 * lets a caller distinguish "not there" from "I could not look that far".
 */
export const DEFAULT_SCAN_DEPTH = 6;

/** Where an entity's record actually is. */
export interface EntityLocation {
  /** Absolute path of the project directory (the store's cwd, not the .brainclaw dir). */
  cwd: string;
  project_id?: string;
  project_name?: string;
}

export interface LocateEntityResult {
  /**
   * found       — exactly one store holds the id.
   * not_found   — no candidate holds it (the caller decides whether that is an
   *               error; a legacy id in an unlinked store looks the same).
   * ambiguous   — two or more stores hold it. Fuel for the T3 hard refusal; never
   *               resolved by first-wins here.
   */
  status: 'found' | 'not_found' | 'ambiguous';
  /** Set only when status === 'found'. */
  location?: EntityLocation;
  /** Every store that holds the id (length 0, 1, or ≥2, matching `status`). */
  matches: EntityLocation[];
  /**
   * Stores probed, in probe order.
   *
   * COST HONESTY (review P2-4): this is the RECORD-probe count only. It does NOT
   * include the enumeration that necessarily runs first — loading config, resolving
   * the store chain to the boundary, scanning nested trees, reading link config.
   * An instrumented single-store hit performed 6 existsSync + 4 readFileSync +
   * 1 statSync + 2 readdirSync while reporting ONE probe here. Nor does the loop
   * short-circuit on a local hit: every candidate is probed BY DESIGN, because a
   * duplicate elsewhere is what makes the result `ambiguous`, and stopping early
   * would silently turn a divergence into a confident wrong answer.
   */
  probed: string[];
  /**
   * True when candidate enumeration hit a depth ceiling, so `not_found` means
   * "not in the stores I could reach" rather than "nowhere". A caller about to
   * REFUSE a mutation must be able to tell those apart.
   */
  enumeration_incomplete: boolean;
}

/** Directory key in ENTITY_DIR_MAP for each mapped entity kind. */
function subdirFor(entity: Exclude<LocatableEntity, 'loop'>): string {
  return entity === 'assignment' ? 'assignments'
    : entity === 'claim' ? 'claims'
      : entity === 'agent_run' ? 'runs'
        : 'plans';
}

/**
 * EVERY file path a record with this id could occupy in one store.
 *
 * Deliberately NOT `resolveEntityDir(..., 'read')` any more (review P1-1, which the
 * reviewer reproduced): that helper picks the canonical directory as soon as it
 * contains ANY file (`hasContent`), which answers "where do records generally
 * live" — not "where is THIS record". A store mid-migration holding
 * `coordination/assignments/asgn_new.json` plus a legacy `assignments/asgn_old.json`
 * made `asgn_old` unroutable: the canonical dir had content, so the legacy path was
 * never looked at. Choosing a directory is the wrong primitive for a per-file
 * question, so both layouts are probed by FILE and the caller sees one hit.
 */
/**
 * The identifier shape `JsonStore` enforces before building a record path
 * (json-store.ts:78). Duplicated HERE rather than trusted from the caller (review
 * P2-6): this module joins an id into a filesystem path, so an id containing `..`
 * or a separator would escape the store it is supposed to be probing. Callers on
 * the MCP surface validate too and return a clean input_error — this is the
 * backstop that makes the escape impossible rather than merely unlikely.
 */
export function isLocatableId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function recordPaths(entity: LocatableEntity, id: string, storeCwd: string): string[] {
  if (entity === 'loop') {
    // Loops are not in ENTITY_DIR_MAP — their threads live under loops/threads.
    return [path.join(storeCwd, MEMORY_DIR, 'loops', 'threads', `${id}.json`)];
  }
  // Shared primitive (io.ts): this module had a hand-made copy, and so did two
  // loaders. One export, four consumers — a fourth review would otherwise have
  // found the same defect one layer further down.
  return entityRecordPaths(subdirFor(entity), id, storeCwd);
}

/**
 * One candidate, all its possible layouts. A store that is mid-write,
 * permission-denied or otherwise unreadable counts as a miss rather than an
 * exception: routing must not depend on the health of a project the caller has
 * nothing to do with.
 */
function recordExists(entity: LocatableEntity, id: string, storeCwd: string): boolean {
  for (const candidate of recordPaths(entity, id, storeCwd)) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch { /* unreadable — treat as a miss and keep looking */ }
  }
  return false;
}

/**
 * Canonical identity of a store path, for deduplication (review P2-3, reproduced).
 * `path.resolve` is LEXICAL: a Windows directory junction — or a symlink, or a
 * case-different spelling — declared as a cross-project link survived as a SECOND
 * candidate pointing at the same physical store, and the same record was then found
 * twice and reported `ambiguous`. That is a false positive that blocks a healthy
 * mutation, i.e. the exact opposite of what the ambiguity contract is for.
 *
 * Falls back to the lexical form when the path cannot be realpath'd (missing or
 * unreadable): a candidate we cannot canonicalise must still be probed, not dropped.
 */
function canonicalKey(abs: string): string {
  try {
    const real = fs.realpathSync.native(abs);
    // Windows paths are case-insensitive; lower-casing the KEY only (never the
    // stored path) makes `C:\Repo` and `c:\repo` one candidate without changing
    // what is reported back to the caller.
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }
}

function describe(storeCwd: string): EntityLocation {
  try {
    const config = loadConfig(storeCwd);
    return { cwd: storeCwd, project_id: config.project_id, project_name: config.project_name };
  } catch {
    // A store we can enumerate but not read config for is still a valid location.
    return { cwd: storeCwd };
  }
}

/**
 * Candidate stores, in probe order: the caller's own store first (so the common
 * single-project case stops after one stat), then the workspace's children, then
 * declared cross-project links. Deduplicated by resolved absolute path.
 *
 * Enumeration mirrors the loop project-resolution gate (loops/project-resolution.ts)
 * on purpose — two different candidate sets for "which projects exist here" is how
 * routing surfaces drift apart.
 */
export function enumerateCandidateStores(cwd: string, options: { maxDepth?: number } = {}): string[] {
  return enumerateCandidates(cwd, options).stores;
}

/** Candidate enumeration plus an honest statement of what it could not reach. */
export interface CandidateEnumeration {
  stores: string[];
  /**
   * True when a nested scan stopped at its depth ceiling, so a deeper store may
   * exist and NOT be in `stores` (review P1-2, reproduced at depth 7 with the
   * default ceiling of 6). Surfacing this is the difference between "no such
   * entity" and "I did not look everywhere" — a caller about to REFUSE a mutation
   * needs to know which one it has.
   */
  incomplete: boolean;
}

/**
 * Per-process memo of the CANDIDATE LIST — never of the probes.
 *
 * This module's own header said "a cache belongs in FRONT of this function" and
 * nobody wrote it, which a Fable audit ranked as the second live risk of the whole
 * routing change: `enumerateCandidates` re-walks the workspace tree on EVERY routed
 * mutation, and a worker emits repeated PROGRESS calls for the length of a run.
 * Measured by a reviewer on Windows: p50 3.36 ms vs 0.23 ms for a direct load (~15x
 * per call) — and a depth-12 experiment of mine spent 130 SECONDS in enumeration
 * alone, which is the shape of the tail.
 *
 * WHAT IS AND IS NOT CACHED, deliberately. Only "which stores exist here" is memoised
 * — a filesystem-topology answer that changes when someone creates a project. The
 * PROBES (does this store hold this id?) are never cached: that is the state a
 * mutation is about to change, and a stale answer there would route a write to the
 * wrong store, which is the entire class dec#153 exists to kill.
 *
 * ASSUMED TRADE-OFF: for up to TTL milliseconds after a store is created, it is not a
 * candidate. Consequences are bounded and safe in both directions — a `not_found`
 * carries `enumeration_incomplete`, and an ambiguity that appears late is caught on
 * the next call. The TTL is deliberately short: long enough to collapse a burst of
 * calls from one operation, far too short to matter to a human.
 */
const ENUMERATION_MEMO_TTL_MS = 2_000;
const enumerationMemo = new Map<string, { at: number; value: CandidateEnumeration }>();

/**
 * Drop the memo. Called by tests, and by `runInit` — because a store that has just come
 * into existence is exactly what a cached candidate list cannot know about.
 *
 * This comment used to name that second caller before it existed (Fable audit: intent
 * described as code). Now it does.
 */
export function clearEnumerationMemo(): void {
  enumerationMemo.clear();
}

export function enumerateCandidates(
  cwd: string,
  options: { maxDepth?: number; noMemo?: boolean } = {},
): CandidateEnumeration {
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH;
  // Keyed on the canonical cwd AND the depth, so two callers asking different
  // questions cannot read each other's answer.
  const memoKey = `${canonicalKey(path.resolve(cwd))}::${maxDepth}`;
  if (!options.noMemo) {
    const hit = enumerationMemo.get(memoKey);
    if (hit && Date.now() - hit.at < ENUMERATION_MEMO_TTL_MS) {
      // Copy the array so a caller mutating its result cannot corrupt the memo.
      return { stores: [...hit.value.stores], incomplete: hit.value.incomplete };
    }
  }
  const computed = enumerateCandidatesUncached(cwd, maxDepth);
  if (!options.noMemo) enumerationMemo.set(memoKey, { at: Date.now(), value: computed });
  return { stores: [...computed.stores], incomplete: computed.incomplete };
}

function enumerateCandidatesUncached(cwd: string, maxDepth: number): CandidateEnumeration {
  const seen = new Set<string>();
  const ordered: string[] = [];
  let incomplete = false;
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    const abs = path.resolve(candidate);
    // Only real stores are candidates — an unreadable path costs nothing later.
    if (!fs.existsSync(path.join(abs, MEMORY_DIR, 'config.yaml'))) return;
    // Dedup on the CANONICAL path so a junction/symlink/case alias of a store
    // already in the list cannot become a second candidate (review P2-3).
    const key = canonicalKey(abs);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(abs);
  };
  /**
   * ONE nested scan per root, with truncation reported BY THE WALK.
   *
   * An earlier version inferred it from the deepest RESULT — a store found at the
   * ceiling depth meant deeper ones might exist. Review P1-1 reproduced why that is
   * wrong: with a store at `root/d1/…/d7` and nothing in `d1…d6`, the walk cut the
   * branch without returning anything near the ceiling, so the heuristic reported
   * completeness while the target sat just below the cut — and the handler emitted a
   * CONFIDENT `not_found`. Truncation is a property of the traversal, not of what it
   * happened to find, so the scanner now says it (still one scan, no extra I/O).
   */
  const addNested = (root: string): void => {
    const scan = scanNestedBrainclawProjectsDetailed(root, maxDepth);
    for (const project of scan.projects) add(project.path);
    if (scan.truncated) incomplete = true;
  };

  const here = path.resolve(cwd);
  add(here);

  let config;
  try {
    config = loadConfig(here);
  } catch {
    // Uninitialised store: `here` was already rejected by `add`, and there is
    // nothing to enumerate from. Returning what we have keeps callers simple.
    return { stores: ordered, incomplete };
  }

  if (config.project_mode === 'multi-project') {
    for (const project of summarizeWorkspaceProjects(here, config).discovered_projects) {
      // `config`-sourced entries are declared namespaces without a path of their own.
      if (project.source !== 'config') add(project.path);
    }
  }

  // A workspace root can host nested project stores; so can the workspace root
  // ABOVE us, which is how a child project reaches its siblings.
  const wsRoot = resolveWorkspaceRoot(here);
  if (wsRoot) {
    add(wsRoot);
    addNested(wsRoot);
  } else if (resolvePrimaryStore(here)?.role === 'workspace') {
    addNested(here);
  }

  // A cross-project link can point at a WORKSPACE, whose own children are then
  // reachable by the linked side (review P1-2, reproduced: A → linked B → B/apps/C
  // returned candidates [A, B] and not_found for a record living in C). Adding the
  // link root alone was an arbitrary stop one level short of what the product can
  // reach, so nested stores under each link are enumerated too.
  for (const link of resolveCrossProjectLinks(here)) {
    add(link.absolutePath);
    addNested(link.absolutePath);
  }

  return { stores: ordered, incomplete };
}

/**
 * Find the store holding `id`. Never throws for a missing store or unreadable
 * config — a locator that fails loudly on an unrelated broken sibling would make
 * routing depend on the health of projects the caller has nothing to do with.
 */
/**
 * The owner project id shared by EVERY match, or undefined when the records do not
 * agree on one — which includes all the ways they can fail to answer:
 *
 *   - a record with no `project_id` (legacy, created before step 1 persisted it):
 *     step 1 decided a missing owner must NOT trigger new behaviour, so one absent
 *     field makes the whole set undecided rather than letting the others vote;
 *   - records naming DIFFERENT owners — a genuine divergence, the case the hard
 *     refusal exists for;
 *   - a record that cannot be read or parsed. NEVER throws: this module refuses to
 *     make routing depend on the health of a project the caller has nothing to do
 *     with, and an unreadable record must degrade to `ambiguous`, not to a crash.
 */
function sharedRecordOwner(
  entity: LocatableEntity,
  id: string,
  matches: EntityLocation[],
): string | undefined {
  let owner: string | undefined;
  for (const match of matches) {
    let recordOwner: string | undefined;
    for (const candidate of recordPaths(entity, id, match.cwd)) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        const value = (raw as { project_id?: unknown } | null)?.project_id;
        if (typeof value === 'string' && value.trim()) recordOwner = value;
      } catch { /* unreadable → undecided, handled below */ }
      break;
    }
    if (!recordOwner) return undefined;
    if (owner === undefined) owner = recordOwner;
    else if (owner !== recordOwner) return undefined;
  }
  return owner;
}

export function locateEntity(
  entity: LocatableEntity,
  id: string,
  cwd: string,
  options: { candidates?: string[]; maxDepth?: number } = {},
): LocateEntityResult {
  // An unusable id never touches the filesystem: no path is built, nothing is
  // probed. Reported as not_found rather than thrown so an MCP handler can turn it
  // into a clean input_error without a crash, while an internal caller that forgot
  // to validate still cannot escape a store.
  if (!isLocatableId(id)) {
    return { status: 'not_found', matches: [], probed: [], enumeration_incomplete: false };
  }
  const enumeration = options.candidates
    ? { stores: options.candidates, incomplete: false }
    : enumerateCandidates(cwd, { maxDepth: options.maxDepth });
  const matches: EntityLocation[] = [];
  const probed: string[] = [];

  // Alias-aware dedup lives HERE, not only in enumeration: a caller-supplied
  // candidate list can contain two spellings of one physical store just as easily
  // (found while pinning review P2-3 — the enumeration-only dedup left this path
  // open). Probing an alias twice would report a single record as `ambiguous`.
  const probedKeys = new Set<string>();
  for (const candidate of enumeration.stores) {
    const key = canonicalKey(path.resolve(candidate));
    if (probedKeys.has(key)) continue;
    probedKeys.add(key);
    probed.push(candidate);
    if (recordExists(entity, id, candidate)) matches.push(describe(candidate));
  }

  const incomplete = enumeration.incomplete;
  if (matches.length === 1) {
    return { status: 'found', location: matches[0], matches, probed, enumeration_incomplete: incomplete };
  }
  if (matches.length > 1) {
    // ── dec#155's robustness guard: ≥2 matches carrying the SAME owner route to the
    // owner instead of refusing. Written from that sentence, not from this code.
    //
    // This does NOT weaken the ambiguity contract, and the distinction is the whole
    // point of the module header: "never picks a winner it cannot justify". Here the
    // RECORD names its owner, so the winner is justified BY THE DATA — it is not a
    // first-wins tie-break. Every path where the data does not justify a winner
    // stays `ambiguous`, which is what the two entity-routed surfaces refuse on.
    //
    // It uses the field step 1 persisted (`project_id` on assignment / agent_run /
    // claim) and that this function has ignored ever since, and it exists to avoid
    // REFUSING a healthy mutation when an alias or a mirror surfaces one record
    // twice — a false refusal is the exact opposite of what the contract is for.
    //
    // Paid only on the ambiguous path: one read per match, in a branch that is
    // already the rare case. The single-store hit still costs what it cost.
    //
    // ONE COUNTEREXAMPLE WAS RAISED AND IS EMPTY TODAY — recorded because it will not
    // stay empty by itself. `bclaw_move` deliberately leaves a recoverable duplicate
    // if it crashes between writing the target and removing the source, and it copies
    // the record VERBATIM (relocate.ts) — so the residue would be two copies naming
    // the SAME owner, which this guard would route instead of surfacing, freezing the
    // repair signal. It cannot happen now: `plan` is the only entity both relocatable
    // and locatable, and plan records carry NO `project_id` (checked against real
    // records on disk, not just the schema), so `sharedRecordOwner` returns undefined
    // and the residue stays `ambiguous`. THE DAY PLANS GAIN AN OWNER, relocate must
    // rewrite `project_id` on the moved copy first — then the residue carries
    // divergent owners and stays loudly ambiguous, which is the better companion fix
    // anyway. (Fable audit; the counterexample was sound reasoning about a field the
    // entity does not have.)
    const owner = sharedRecordOwner(entity, id, matches);
    if (owner) {
      const owned = matches.filter((m) => m.project_id === owner);
      // Exactly one match must BE the owner store. Zero means the owner is not among
      // the stores holding the record (so routing there would name a store that does
      // not have it); more than one means two stores claim the same project id, which
      // is itself a divergence and not something to resolve here.
      if (owned.length === 1) {
        return { status: 'found', location: owned[0], matches, probed, enumeration_incomplete: incomplete };
      }
    }
    return { status: 'ambiguous', matches, probed, enumeration_incomplete: incomplete };
  }
  return { status: 'not_found', matches, probed, enumeration_incomplete: incomplete };
}
