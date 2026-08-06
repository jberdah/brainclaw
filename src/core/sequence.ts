import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from './json-store.js';
import { mutate } from './mutation-pipeline.js';
import { generateIdWithLabel, nowISO } from './ids.js';
import { entityRecordDirs, resolveEntityDir } from './io.js';
import { SequenceItemSchema, SequenceSchema, type Sequence, type SequenceItem, type SequenceItemInput, type SequenceStatus } from './schema.js';
import { refreshLiveCompanions } from '../commands/export.js';
import { emitRegistryPostImage, emitRegistryTombstone, registryFaultPoint } from './events/registry-post-image.js';

function sequencesDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('sequences', cwd ?? process.cwd(), mode);
}

export function ensureSequencesDir(cwd?: string): void {
  const dir = sequencesDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sequenceStoreForDir(dirPath: string): JsonStore<Sequence> {
  return new JsonStore<Sequence>({
    dirPath,
    documentType: 'sequence',
    getId: (sequence) => sequence.id,
    sort: (a, b) => a.updated_at.localeCompare(b.updated_at),
  });
}

function sequenceStore(cwd?: string, mode: 'read' | 'write' = 'read'): JsonStore<Sequence> {
  return sequenceStoreForDir(sequencesDir(cwd, mode));
}

function normalizeItems(items: SequenceItemInput[]): SequenceItem[] {
  return items
    .map((item) => SequenceItemSchema.parse(item))
    .sort((a, b) => a.rank - b.rank || a.planId.localeCompare(b.planId));
}

function validateRanks(items: SequenceItem[]): void {
  const ranks = new Set<number>();
  for (const item of items) {
    if (ranks.has(item.rank)) {
      throw new Error(`Duplicate sequence rank: ${item.rank}`);
    }
    ranks.add(item.rank);
  }
}

export interface CreateSequenceInput {
  name: string;
  description?: string;
  status?: SequenceStatus;
  items?: SequenceItemInput[];
  owner?: string;
  author: string;
  authorId?: string;
  model?: string;
  projectId?: string;
  hostId?: string;
  sessionId?: string;
  tags?: string[];
}

export interface UpdateSequenceInput {
  id: string;
  name?: string;
  description?: string;
  status?: SequenceStatus;
  items?: SequenceItemInput[];
  owner?: string;
  tags?: string[];
}

export function saveSequence(sequence: Sequence, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureSequencesDir(cwd);
    const store = sequenceStore(cwd, 'write');
    const parsed = SequenceSchema.parse(sequence);
    // pln#568 (I2): journal the post-image BEFORE the projection write.
    const created = !store.exists(parsed.id);
    emitRegistryPostImage('sequence', parsed, { created, agent: parsed.author, agent_id: parsed.author_id, session_id: parsed.session_id, cwd });
    registryFaultPoint('after_registry_journal');
    store.save(parsed);
    // Converge the other layout, as claims/assignments/runs do: a legacy twin holding a
    // stale status is how a "deleted" record comes back.
    const writeDir = sequencesDir(cwd, 'write');
    for (const dirPath of entityRecordDirs('sequences', cwd ?? process.cwd())) {
      if (dirPath === writeDir) continue;
      const legacyPath = path.join(dirPath, `${parsed.id}.json`);
      try {
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
      } catch { /* best effort — the dual-layout list keeps it visible */ }
    }
    // Auto-refresh live companions after sequence changes (non-fatal)
    try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
  });
}

/**
 * BOTH LAYOUTS, canonical winning a duplicate id.
 *
 * FIXED AT THE LIST LAYER ON PURPOSE, and this is the part a "port the by-id loader"
 * instinct gets wrong (Fable audit): `loadSequence` resolves by id OR short_label, and
 * `getActiveSequence` needs the whole set — both are list-mediated. Rewriting
 * `loadSequence` with `entityRecordPaths` would build a path from a short_label, which is
 * not a filesystem key, so it could not work for either caller. One dual-layout list fixes
 * all three readers.
 *
 * Exposure is nil today: sequences postdate the partitioned layout (measured legacy=0), so
 * this is consistency with the sibling entities, not a field fix.
 */
export function listSequences(cwd?: string): Sequence[] {
  const byId = new Map<string, Sequence>();
  for (const dirPath of entityRecordDirs('sequences', cwd ?? process.cwd())) {
    for (const sequence of sequenceStoreForDir(dirPath).list()) {
      if (!byId.has(sequence.id)) byId.set(sequence.id, sequence);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const activeBoost = Number(b.status === 'active') - Number(a.status === 'active');
    if (activeBoost !== 0) return activeBoost;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export function loadSequence(id: string, cwd?: string): Sequence {
  const sequence = listSequences(cwd).find((entry) => entry.id === id || entry.short_label === id);
  if (!sequence) {
    throw new Error(`Sequence not found: ${id}`);
  }
  return sequence;
}

export function getActiveSequence(cwd?: string): Sequence | undefined {
  return listSequences(cwd).find((sequence) => sequence.status === 'active');
}

export function createSequence(input: CreateSequenceInput, cwd?: string): { id: string; shortLabel?: string; name: string } {
  const items = normalizeItems(input.items ?? []);
  validateRanks(items);
  const { id, short_label } = generateIdWithLabel('sequences', cwd);
  const timestamp = nowISO();
  const sequence: Sequence = {
    id,
    short_label,
    name: input.name,
    description: input.description,
    status: input.status ?? 'draft',
    items,
    owner: input.owner,
    created_at: timestamp,
    updated_at: timestamp,
    author: input.author,
    author_id: input.authorId,
    model: input.model,
    project_id: input.projectId,
    host_id: input.hostId,
    session_id: input.sessionId,
    tags: input.tags ?? [],
  };
  saveSequence(sequence, cwd);
  return { id, shortLabel: short_label, name: input.name };
}

export function deleteSequence(id: string, cwd?: string): { id: string; name: string } {
  return mutate({ cwd }, () => {
    ensureSequencesDir(cwd);
    const store = sequenceStore(cwd, 'write');
    const current = store.list().find((entry) => entry.id === id || entry.short_label === id);
    if (!current) {
      throw new Error(`Sequence not found: ${id}`);
    }
    emitRegistryTombstone('sequence', current.id, { agent: current.author, agent_id: current.author_id, session_id: current.session_id, cwd });
    registryFaultPoint('after_registry_journal');
    store.delete(current.id);
    return { id: current.id, name: current.name };
  });
}

export function updateSequence(input: UpdateSequenceInput, cwd?: string): Sequence {
  return mutate({ cwd }, () => {
    ensureSequencesDir(cwd);
    // A FOURTH READER, found by the pin for this change rather than by the audit that
    // prompted it: this looked the record up in the WRITE directory only, so a sequence in
    // the legacy layout was invisible to every update — `Sequence not found` on a record
    // `listSequences` and `loadSequence` could both see. Reads come from the dual-layout
    // list; the write still lands canonical via saveSequence, which then converges the twin.
    const current = listSequences(cwd).find((entry) => entry.id === input.id || entry.short_label === input.id);
    if (!current) {
      throw new Error(`Sequence not found: ${input.id}`);
    }
    const items = input.items ? normalizeItems(input.items) : current.items;
    validateRanks(items);
    const next: Sequence = {
      ...current,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      status: input.status ?? current.status,
      items,
      owner: input.owner ?? current.owner,
      tags: input.tags ?? current.tags,
      updated_at: nowISO(),
    };
    saveSequence(SequenceSchema.parse(next), cwd);
    return next;
  });
}
