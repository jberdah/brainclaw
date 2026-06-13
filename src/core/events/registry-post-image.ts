/**
 * Registry / coordination family post-images (pln#568, phase 1.5).
 *
 * The 5 memory families (constraint/decision/trap/handoff/plan) journal full
 * post-images via state.ts `emitPerEntityJournalRecords`. The registry /
 * coordination families persist through their own JsonStore chokepoints and
 * historically reached the journal envelope-only (registry-lifecycle, 0
 * payload) or not at all (trp_2a89ae97) — so the observer could never rebuild
 * them from the journal and had to seed them from an MCP `board_summary`.
 *
 * This is their post-image emit, mirroring the memory path: ONE entity-state
 * `create`/`update` record carrying the byte-faithful prepared document (the
 * same bytes JsonStore.save writes to the projection file) plus a
 * journal-assigned `entity_rev`. Because the materialize reducer already
 * upserts ANY entity-state record (materialize.ts `applyRecordsToLive`), no
 * reducer change is needed — the families light up the moment these records
 * appear.
 *
 * I2 — JOURNAL BEFORE PROJECTION. Callers MUST invoke {@link emitRegistryPostImage}
 * BEFORE writing the projection file (and inside the same mutation lock), so a
 * crash mid-persist can only leave the journal AHEAD of the projection (the one
 * direction lazy-reconcile can recover), never the projection ahead. Use
 * {@link registryFaultPoint} between the emit and the file write to test it.
 *
 * The journal `item_type` deliberately matches the observer's `ARRAY_SLOT`
 * keys (vscode-extension/src/board-projection.ts) so a post-image flows
 * straight into the right board slot with no consumer change. Note the one
 * non-obvious mapping: action_required entities journal under item_type
 * `state` (the slot the observer already reserved for them), not `action`.
 *
 * @module
 */
import { appendJournalRecords, resolveJournalMode } from './journal.js';
import { preparePersistedDocument, type VersionedDocumentType } from '../migration.js';

export interface RegistryFamilySpec {
  /** Journal `item_type` — MUST match the observer ARRAY_SLOT key (board-projection.ts). */
  journalItemType: string;
  /** Versioned document type for the byte-faithful post-image (== the projection's). */
  docType: VersionedDocumentType;
}

/**
 * The registry / coordination families that journal entity-state post-images.
 * `action`'s journal item_type is `state` (not `action`) to match the slot the
 * observer reserved for action_required entities.
 */
export const REGISTRY_FAMILIES = {
  claim: { journalItemType: 'claim', docType: 'claim' },
  assignment: { journalItemType: 'assignment', docType: 'assignment' },
  agent_run: { journalItemType: 'agent_run', docType: 'agent_run' },
  action: { journalItemType: 'state', docType: 'action_required' },
  candidate: { journalItemType: 'candidate', docType: 'candidate' },
  runtime_note: { journalItemType: 'runtime_note', docType: 'runtime_note' },
  sequence: { journalItemType: 'sequence', docType: 'sequence' },
} as const satisfies Record<string, RegistryFamilySpec>;

export type RegistryFamily = keyof typeof REGISTRY_FAMILIES;

/**
 * Journal item_types that carry a registry post-image. The dual-write envelope
 * suppression (event-log.ts) keys off this so these families appear in the v2
 * journal ONLY as post-images, never as the legacy envelope-only lifecycle
 * record. Derived from REGISTRY_FAMILIES so the two can never drift.
 */
export const REGISTRY_POST_IMAGE_ITEM_TYPES: ReadonlySet<string> = new Set(
  Object.values(REGISTRY_FAMILIES)
    .map((spec) => spec.journalItemType)
    // `state` is excluded: the coarse persist store_marker also uses item_type
    // `state` (without an item_id) and must keep dual-writing its journal_note.
    // The action post-image is disambiguated by its item_id, so its OWN emit
    // path (emitRegistryPostImage) is what journals it — not the envelope.
    .filter((itemType) => itemType !== 'state'),
);

export interface RegistryEmitOptions {
  /** Whether the projection file is being created (vs updated). Cosmetic for the
   *  reducer (both upsert), surfaced for faithful create/update provenance. */
  created?: boolean;
  agent?: string;
  agent_id?: string;
  session_id?: string;
  cwd?: string;
}

/**
 * Emit ONE entity-state post-image for a registry/coordination entity. No-op
 * when the journal is off. Failures are swallowed inside appendJournalRecords
 * (dual mode: the v1 projection remains the source of truth).
 */
export function emitRegistryPostImage(
  family: RegistryFamily,
  item: { id: string },
  opts: RegistryEmitOptions = {},
): void {
  if (resolveJournalMode(opts.cwd) === 'off') return;
  const spec = REGISTRY_FAMILIES[family];
  appendJournalRecords([{
    action: opts.created ? 'create' : 'update',
    item_type: spec.journalItemType,
    item_id: item.id,
    agent: opts.agent ?? 'system',
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    payload: preparePersistedDocument(spec.docType, item) as Record<string, unknown>,
  }], opts.cwd);
}

/**
 * Emit a tombstone for a registry entity whose projection file is removed
 * (e.g. a candidate that left the pending inbox). No-op when the journal is off.
 */
export function emitRegistryTombstone(
  family: RegistryFamily,
  id: string,
  opts: RegistryEmitOptions = {},
): void {
  if (resolveJournalMode(opts.cwd) === 'off') return;
  const spec = REGISTRY_FAMILIES[family];
  appendJournalRecords([{
    action: 'delete',
    item_type: spec.journalItemType,
    item_id: id,
    agent: opts.agent ?? 'system',
    agent_id: opts.agent_id,
    session_id: opts.session_id,
  }], opts.cwd);
}

/**
 * Test-only crash injection (mirrors state.ts `faultPoint`). No-op unless
 * BRAINCLAW_FAULT_POINT matches — then it throws, simulating a process death at
 * that exact point so the I2 journal-before-projection ordering can be tested
 * deterministically. Callers place it BETWEEN the post-image emit and the
 * projection file write.
 */
export function registryFaultPoint(label: string): void {
  if (process.env.BRAINCLAW_FAULT_POINT === label) {
    throw new Error(`fault-injection: crashed at "${label}" (BRAINCLAW_FAULT_POINT)`);
  }
}
