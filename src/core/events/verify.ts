/**
 * Projection-vs-journal verification (pln#543 cutover gate).
 *
 * Lives in its OWN module (not materialize.ts) on purpose: it needs `loadState`
 * (projection read) AND the journal materializer. If this dependency sat in
 * materialize.ts, the materialize -> state edge would close a cycle
 * state -> events/checkpoint -> events/materialize -> state once the checkpoint
 * read path is wired into loadState — a module-init TDZ class (trp_187e42e9).
 * Keeping verify here means materialize never imports state; verify.ts is
 * imported only by doctor + tests, never by state.
 *
 * @module
 */
import { loadState } from '../state.js';
import { MEMORY_FAMILIES, materializeMemoryStateFromJournal, materializeRegistryFromJournal, type MaterializedEntity } from './materialize.js';
import { listClaims } from '../claims.js';
import { listAssignments } from '../assignments.js';
import { listAgentRuns } from '../agentruns.js';
import { listActionRequired } from '../actions.js';
import { listCandidates } from '../candidates.js';
import { listSequences } from '../sequence.js';
import { listSharedJournaledRuntimeNotes } from '../runtime.js';
import { REGISTRY_FAMILIES, type RegistryFamily } from './registry-post-image.js';
import { preparePersistedDocument } from '../migration.js';

export type DriftKind = 'missing_in_journal' | 'missing_in_projection' | 'mismatch';

export interface ProjectionDrift {
  item_type: string;
  item_id: string;
  kind: DriftKind;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/**
 * Compare projection-read state (the truth in dual mode) against the
 * journal-materialized state. Empty drift = the dual-write is faithful and
 * the journal can be trusted as a read substrate — the cutover gate
 * (`brainclaw doctor --verify-journal`).
 */
export function verifyProjectionsAgainstJournal(cwd?: string): ProjectionDrift[] {
  const projection = loadState(cwd);
  const journal = materializeMemoryStateFromJournal(cwd);
  const drift: ProjectionDrift[] = [];

  for (const { itemType, collection } of MEMORY_FAMILIES) {
    const projItems = new Map((projection[collection] as Array<{ id: string }>).map(i => [i.id, i]));
    const jrnItems = new Map((journal[collection] as Array<{ id: string }>).map(i => [i.id, i]));
    for (const [id, projItem] of projItems) {
      const jrnItem = jrnItems.get(id);
      if (!jrnItem) drift.push({ item_type: itemType, item_id: id, kind: 'missing_in_journal' });
      else if (stable(projItem) !== stable(jrnItem)) drift.push({ item_type: itemType, item_id: id, kind: 'mismatch' });
    }
    for (const id of jrnItems.keys()) {
      if (!projItems.has(id)) drift.push({ item_type: itemType, item_id: id, kind: 'missing_in_projection' });
    }
  }
  return drift;
}

/**
 * The registry / coordination families covered by the registry verification
 * (pln#568). Each maps its `RegistryFamily` (→ journal item_type + doc type) to
 * the projection reader. Scoped to the coordination-class families wired in
 * slice 1 plus the remaining pln#568-wired families. Runtime notes are scoped
 * to shared visibility because private/machine notes deliberately do not enter
 * the shared journal.
 */
const VERIFIED_REGISTRY_FAMILIES: Array<{ family: RegistryFamily; list: (cwd?: string) => Array<{ id: string }> }> = [
  { family: 'claim', list: listClaims },
  { family: 'assignment', list: listAssignments },
  { family: 'agent_run', list: listAgentRuns },
  { family: 'action', list: listActionRequired },
  // Only PENDING candidates are journaled (archive emits a tombstone, pln#568),
  // so verify compares the pending projection against the journal live set.
  { family: 'candidate', list: (cwd) => listCandidates('pending', cwd) },
  { family: 'runtime_note', list: listSharedJournaledRuntimeNotes },
  { family: 'sequence', list: listSequences },
];

/**
 * Compare the registry projections (the dual-mode source of truth) against the
 * journal-materialized registry post-images (pln#568). Empty drift = the
 * registry dual-write is faithful and the observer can trust the journal for
 * these families — the registry half of the cutover gate, mirroring
 * {@link verifyProjectionsAgainstJournal} for the memory families. The
 * comparison runs both sides through `preparePersistedDocument` so a projection
 * item and its journal payload (which is exactly that) compare like-for-like.
 */
export function verifyRegistryAgainstJournal(cwd?: string): ProjectionDrift[] {
  const journal = materializeRegistryFromJournal(cwd);
  const drift: ProjectionDrift[] = [];

  for (const { family, list } of VERIFIED_REGISTRY_FAMILIES) {
    const spec = REGISTRY_FAMILIES[family];
    const projItems = new Map(list(cwd).map((i) => [i.id, preparePersistedDocument(spec.docType, i) as Record<string, unknown>]));
    const jrnItems = new Map((journal.get(spec.journalItemType) ?? ([] as MaterializedEntity[])).map((e) => [e.item_id, e.payload]));
    for (const [id, projItem] of projItems) {
      const jrnItem = jrnItems.get(id);
      if (!jrnItem) drift.push({ item_type: spec.journalItemType, item_id: id, kind: 'missing_in_journal' });
      else if (stable(projItem) !== stable(jrnItem)) drift.push({ item_type: spec.journalItemType, item_id: id, kind: 'mismatch' });
    }
    for (const id of jrnItems.keys()) {
      if (!projItems.has(id)) drift.push({ item_type: spec.journalItemType, item_id: id, kind: 'missing_in_projection' });
    }
  }
  return drift;
}
