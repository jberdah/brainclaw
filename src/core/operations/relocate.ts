/**
 * Cross-project relocation (pln#595) — `bclaw move` / `bclaw_move`.
 *
 * Moves a brainclaw item from one project store to another in a multi-project
 * workspace, PRESERVING ITS ID (so `pln#`/`dec#` references stay stable). Born
 * from the monorepo switch bug (DGX Finding 1): items were created in the wrong
 * store and there was no relocation helper — only raw file surgery or a recreate
 * that mints a new id and breaks references.
 *
 * Scope (v1): the portable knowledge / coordination entities stored one file per
 * id under a single directory — plan, decision, constraint, trap, handoff,
 * sequence. Execution-local entities (claim, assignment, agent_run, session) are
 * intentionally NOT relocatable — they belong to the project where the work ran
 * (cross_project_signaling_vs_execution). candidate/runtime_note are deferred
 * (inbox / visibility-split storage) — a follow-up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { entityRecordPaths, resolveEntityDir, writeFileAtomic } from '../io.js';
import { getEntitySpec, type EntityName } from '../entity-registry.js';
import { appendAuditEntry } from '../audit.js';
import { resolveProjectCwd } from '../cross-project.js';
import { listClaims } from '../claims.js';
import { listSequences } from '../sequence.js';

/**
 * Relocatable entity → the store subdir holding its flat `<id>.json` files.
 *
 * v1 covers only the SHARED, flat-per-id stores. Trap is deliberately limited to
 * the shared `traps/` dir: the host/private visibility variants are host-SCOPED
 * (`traps-hosts/<host>/<id>.json`, `traps-private/<host>/<id>.json` — see
 * saveOperationalTrap), so a flat `<variant>/<id>.json` lookup would both miss
 * them and, if it found one, flatten away the host directory (codex review of
 * pln#595). Host/private traps are deferred alongside candidate/runtime_note
 * until relocation preserves the host scope.
 */
const RELOCATABLE_SUBDIRS: Partial<Record<EntityName, readonly string[]>> = {
  plan: ['plans'],
  decision: ['decisions'],
  constraint: ['constraints'],
  trap: ['traps'],
  handoff: ['handoffs'],
  sequence: ['sequences'],
};

export const RELOCATABLE_ENTITIES = Object.keys(RELOCATABLE_SUBDIRS) as EntityName[];

export interface RelocateEntityInput {
  entity: EntityName;
  id: string;
  /** Target project: name, path, or basename (resolved via resolveProjectCwd). */
  toProject: string;
  /** Source project; defaults to the current project (cwd). */
  fromProject?: string;
  /** Base cwd for resolving project refs. */
  cwd?: string;
  actor?: string;
  actorId?: string;
  /** Move even if an active claim references the item. */
  force?: boolean;
}

export interface RelocateEntityResult {
  entity: EntityName;
  id: string;
  /** Absolute source project root. */
  from: string;
  /** Absolute target project root. */
  to: string;
  /** Store subdir the item lived in (e.g. 'plans', 'traps-private'). */
  subdir: string;
  /** Non-fatal advisories (e.g. dangling sequence refs left in the source). */
  warnings: string[];
}

/**
 * Relocate one entity, id-preserving. Throws on every unsafe condition
 * (non-relocatable entity, same source/target, missing source, target collision,
 * unknown target project, or a live claim unless `force`). Audits BOTH stores.
 */
export function relocateEntity(input: RelocateEntityInput): RelocateEntityResult {
  const baseCwd = input.cwd ?? process.cwd();
  const subdirs = RELOCATABLE_SUBDIRS[input.entity];
  if (!subdirs) {
    throw new Error(
      `Cannot move entity '${input.entity}': only portable knowledge/coordination entities are relocatable `
      + `(${RELOCATABLE_ENTITIES.join(', ')}). Execution-local entities (claim, assignment, agent_run, session, …) `
      + `stay in the project where the work ran.`,
    );
  }
  if (!input.id?.trim()) throw new Error('move requires an entity id.');

  const fromCwd = path.resolve(input.fromProject ? resolveProjectCwd(input.fromProject, baseCwd) : baseCwd);
  const toCwd = path.resolve(resolveProjectCwd(input.toProject, baseCwd)); // throws on unknown target
  if (fromCwd === toCwd) {
    throw new Error(`Source and target are the same project (${toCwd}). Nothing to move.`);
  }

  // Locate the source file across the entity's candidate subdirs AND both layouts.
  //
  // `resolveEntityDir(sd, cwd, 'read')` picks the canonical directory as soon as it
  // holds ANY file, so a record still in the pre-migration flat layout was reported
  // "not found in source project" while sitting right there (pln#649 — same
  // directory-vs-file confusion fixed in the locator and the by-id loaders; found
  // here by a Fable audit).
  let srcFile: string | undefined;
  let foundSubdir: string | undefined;
  for (const sd of subdirs) {
    for (const candidate of entityRecordPaths(sd, input.id, fromCwd)) {
      if (fs.existsSync(candidate)) { srcFile = candidate; foundSubdir = sd; break; }
    }
    if (srcFile) break;
  }
  if (!srcFile || !foundSubdir) {
    throw new Error(`${input.entity} '${input.id}' not found in source project (${fromCwd}).`);
  }

  // Validate before moving — never silently relocate a corrupt record.
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(srcFile, 'utf-8'));
  } catch (err) {
    throw new Error(`${input.entity} '${input.id}' is unreadable JSON: ${(err as Error).message}`, { cause: err });
  }
  getEntitySpec(input.entity).schema.parse(raw);

  // Collision guard — never overwrite an item already in the target, and never
  // CREATE a second copy of the same id inside it.
  //
  // Checking only the canonical directory (`'write'`) was worse than a missed
  // overwrite: if the target held the same id in the LEGACY layout, the guard passed
  // and the move wrote a canonical copy beside it — manufacturing an intra-store
  // duplicate id. Found by a Fable audit.
  //
  // THE MECHANISM RECORDED HERE BEFORE WAS WRONG, and is corrected rather than deleted
  // because a wrong mechanism in a comment misleads the next reader more efficiently than
  // no comment at all. It claimed the duplicate is "precisely the state the entity locator
  // refuses as `ambiguous`, so a successful move could leave an entity permanently
  // unroutable". It is not: `recordExists` is a per-STORE boolean and matches are collected
  // per store, so a record duplicated across two LAYOUTS INSIDE ONE STORE collapses to a
  // single `found`. Ambiguity needs two distinct STORES.
  //
  // The real harm is quieter and still worth the guard: the two copies drift, the loader
  // reads whichever layout wins, and a delete that touches only the canonical one promotes
  // the stale copy back to being the record (the zombie now fixed in assignments.ts).
  const dstDir = resolveEntityDir(foundSubdir, toCwd, 'write');
  const dstFile = path.join(dstDir, `${input.id}.json`);
  for (const existing of entityRecordPaths(foundSubdir, input.id, toCwd)) {
    if (fs.existsSync(existing)) {
      throw new Error(
        `${input.entity} '${input.id}' already exists in the target project (${existing}) — refusing to overwrite `
        + 'or to create a second copy of the same id.',
      );
    }
  }

  // Reference guards (plans): refuse to move work under a live claim; warn on
  // sequences that still point at it (v1 does not rewrite refs).
  const warnings: string[] = [];
  if (input.entity === 'plan') {
    const liveClaims = listClaims(fromCwd).filter((c) => c.status === 'active' && c.plan_id === input.id);
    if (liveClaims.length > 0 && !input.force) {
      throw new Error(
        `${input.id} has ${liveClaims.length} active claim(s) in the source project — refusing to move work mid-flight. `
        + `Release the claim(s) first, or pass force to override.`,
      );
    }
    if (liveClaims.length > 0) {
      warnings.push(`moved despite ${liveClaims.length} active claim(s) still in the source project (force).`);
    }
    const refSeqs = listSequences(fromCwd).filter((s) => (s.items ?? []).some((it) => it.planId === input.id));
    for (const s of refSeqs) {
      warnings.push(`sequence ${s.id} in the source project still references this plan (items not rewritten).`);
    }
  }

  // Perform the move: write target first (atomic), then remove the source — so a
  // crash mid-move leaves a duplicate (recoverable) rather than nothing.
  fs.mkdirSync(dstDir, { recursive: true });
  writeFileAtomic(dstFile, `${JSON.stringify(raw, null, 2)}\n`);
  fs.rmSync(srcFile);

  // Audit BOTH stores so provenance survives the move.
  const actor = input.actor ?? 'unknown';
  const auditCommon = {
    action: 'move' as const,
    actor,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    item_id: input.id,
    item_type: input.entity,
    scope: foundSubdir,
  };
  appendAuditEntry({ ...auditCommon, reason: `moved to ${toCwd}` }, fromCwd);
  appendAuditEntry({ ...auditCommon, reason: `moved from ${fromCwd}` }, toCwd);

  return { entity: input.entity, id: input.id, from: fromCwd, to: toCwd, subdir: foundSubdir, warnings };
}
