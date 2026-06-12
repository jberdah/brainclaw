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
import { MEMORY_FAMILIES, materializeMemoryStateFromJournal } from './materialize.js';

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
