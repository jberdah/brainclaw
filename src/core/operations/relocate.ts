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
import { resolveEntityDir, writeFileAtomic } from '../io.js';
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

  // Locate the source file across the entity's candidate subdirs.
  let srcFile: string | undefined;
  let foundSubdir: string | undefined;
  for (const sd of subdirs) {
    const candidate = path.join(resolveEntityDir(sd, fromCwd, 'read'), `${input.id}.json`);
    if (fs.existsSync(candidate)) { srcFile = candidate; foundSubdir = sd; break; }
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

  // Collision guard — never overwrite an item already in the target.
  const dstDir = resolveEntityDir(foundSubdir, toCwd, 'write');
  const dstFile = path.join(dstDir, `${input.id}.json`);
  if (fs.existsSync(dstFile)) {
    throw new Error(`${input.entity} '${input.id}' already exists in the target project — refusing to overwrite.`);
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
