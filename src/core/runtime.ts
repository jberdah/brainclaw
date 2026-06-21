import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId, sanitizeHostId } from './host.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { RuntimeNoteSchema, type MemoryVisibility, type RuntimeNote } from './schema.js';
import { commitMemoryChange } from './memory-git.js';
import { appendEvent } from './event-log.js';
import { emitRegistryPostImage, emitRegistryTombstone, registryFaultPoint } from './events/registry-post-image.js';

export interface RuntimeListOptions {
  agent?: string;
  visibility?: MemoryVisibility | 'all';
  hostId?: string;
  includeAllHosts?: boolean;
}

export type RuntimeLookupOptions = RuntimeListOptions;

function sharedRuntimeDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('runtime', cwd ?? process.cwd(), mode);
}

function machineRuntimeDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('runtime-hosts', cwd ?? process.cwd(), mode);
}

function privateRuntimeDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('runtime-private', cwd ?? process.cwd(), mode);
}

function sharedAgentDir(agent: string, cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return path.join(sharedRuntimeDir(cwd, mode), agent);
}

function hostRootDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, cwd?: string, mode: 'read' | 'write' = 'read'): string {
  const baseDir = visibility === 'machine' ? machineRuntimeDir(cwd, mode) : privateRuntimeDir(cwd, mode);
  return path.join(baseDir, sanitizeHostId(hostId));
}

function hostAgentDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, agent: string, cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return path.join(hostRootDir(visibility, hostId, cwd, mode), agent);
}

export function ensureRuntimeDir(agent: string, cwd?: string, visibility: MemoryVisibility = 'shared', hostId?: string): void {
  const dir = visibility === 'shared'
    ? sharedAgentDir(agent, cwd, 'write')
    : hostAgentDir(visibility, hostId ?? resolveCurrentHostId(), agent, cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveRuntimeNote(note: RuntimeNote, cwd?: string): void {
  const visibility = note.visibility ?? 'shared';
  const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
  const persistedNote: RuntimeNote = visibility === 'shared'
    ? { ...note, visibility, host_id: hostId }
    : { ...note, visibility, host_id: hostId };

  mutate({ cwd }, () => {
    ensureRuntimeDir(note.agent, cwd, visibility, hostId);
    const filepath = visibility === 'shared'
      ? path.join(sharedAgentDir(note.agent, cwd, 'write'), `${note.id}.json`)
      : path.join(hostAgentDir(visibility, hostId!, note.agent, cwd, 'write'), `${note.id}.json`);
    const parsed = RuntimeNoteSchema.parse(persistedNote);
    // pln#568 (I2): journal the post-image BEFORE the projection write — but
    // SHARED notes only. Private/machine-visibility notes must not leak their
    // payload into the shared journal (the observer's board shows shared notes).
    if (visibility === 'shared') {
      const created = !fs.existsSync(filepath);
      emitRegistryPostImage('runtime_note', parsed, { created, agent: note.agent, agent_id: note.agent_id, session_id: note.session_id, cwd });
      registryFaultPoint('after_registry_journal');
    }
    saveVersionedJsonFile('runtime_note', filepath, parsed);
    appendEvent({ action: 'create', item_type: 'runtime_note', item_id: note.id, agent: note.agent, agent_id: note.agent_id }, cwd);
    commitMemoryChange(`runtime note: ${note.note_type ?? 'note'} (${note.agent})`, cwd);
  });
}

export function runtimeNotePath(note: RuntimeNote, cwd?: string): string {
  const visibility = note.visibility ?? 'shared';
  const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
  return visibility === 'shared'
    ? path.join(sharedAgentDir(note.agent, cwd), `${note.id}.json`)
    : path.join(hostAgentDir(visibility, hostId, note.agent, cwd), `${note.id}.json`);
}

export function deleteRuntimeNote(note: RuntimeNote, cwd?: string): boolean {
  return mutate({ cwd }, () => {
    const filepath = runtimeNotePath(note, cwd);
    if (!fs.existsSync(filepath)) {
      return false;
    }
    if ((note.visibility ?? 'shared') === 'shared') {
      emitRegistryTombstone('runtime_note', note.id, {
        agent: note.agent,
        agent_id: note.agent_id,
        session_id: note.session_id,
        cwd,
      });
      registryFaultPoint('after_registry_journal');
    }
    fs.unlinkSync(filepath);
    return true;
  });
}

/**
 * The shared runtime notes that are journaled as post-images (pln#568): notes
 * under `runtime/<agent>/*.json`, EXCLUDING `runtime/agent-runtime/` (which
 * holds runtime EVENT files `evt_*.json`, not saveRuntimeNote post-images —
 * they would otherwise be parsed as notes and report false drift). Single
 * source of truth for the journaled-shared-note set, shared by the registry
 * verifier (verify.ts) and the registry genesis backfill (genesis.ts).
 */
export function listSharedJournaledRuntimeNotes(cwd?: string): RuntimeNote[] {
  const root = sharedRuntimeDir(cwd, 'read');
  if (!fs.existsSync(root)) return [];
  const notes: RuntimeNote[] = [];
  for (const entry of fs.readdirSync(root).sort()) {
    if (entry === 'agent-runtime') continue;
    const agentDir = path.join(root, entry);
    if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) continue;
    for (const file of fs.readdirSync(agentDir).filter((name) => name.endsWith('.json')).sort()) {
      try {
        notes.push(loadVersionedJsonFile<RuntimeNote>('runtime_note', path.join(agentDir, file)).document);
      } catch { /* mirror listRuntimeNotes' tolerant read */ }
    }
  }
  return notes.sort((a, b) => a.id.localeCompare(b.id));
}

function readAgentNotes(dir: string, agent?: string): RuntimeNote[] {
  if (!fs.existsSync(dir)) return [];

  const agents = agent
    ? [agent]
    : fs.readdirSync(dir).filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory());
  const notes: RuntimeNote[] = [];
  for (const a of agents) {
    const agentDirectory = path.join(dir, a);
    if (!fs.existsSync(agentDirectory)) continue;
    const files = fs.readdirSync(agentDirectory).filter((file) => file.endsWith('.json'));
    for (const file of files) {
      try {
        notes.push(loadVersionedJsonFile<RuntimeNote>('runtime_note', path.join(agentDirectory, file)).document);
      } catch { /* skip */ }
    }
  }

  return notes;
}

function resolveHostIds(rootDir: string, options: RuntimeListOptions): string[] {
  if (!fs.existsSync(rootDir)) return [];
  if (options.includeAllHosts) {
    return fs.readdirSync(rootDir)
      .filter((entry) => fs.statSync(path.join(rootDir, entry)).isDirectory())
      .map((entry) => sanitizeHostId(entry));
  }

  return [sanitizeHostId(options.hostId ?? resolveCurrentHostId())];
}

function readHostScopedNotes(
  visibility: Extract<MemoryVisibility, 'machine' | 'private'>,
  options: RuntimeListOptions,
  cwd?: string,
): RuntimeNote[] {
  const rootDir = visibility === 'machine' ? machineRuntimeDir(cwd) : privateRuntimeDir(cwd);
  const hostIds = resolveHostIds(rootDir, options);
  const notes: RuntimeNote[] = [];

  for (const hostId of hostIds) {
    notes.push(...readAgentNotes(hostRootDir(visibility, hostId, cwd), options.agent));
  }

  return notes;
}

function normalizeRuntimeListOptions(agentOrOptions?: string | RuntimeListOptions): RuntimeListOptions {
  if (typeof agentOrOptions === 'string') {
    return { agent: agentOrOptions };
  }

  return agentOrOptions ?? {};
}

export function listRuntimeNotes(agentOrOptions?: string | RuntimeListOptions, cwd?: string): RuntimeNote[] {
  const options = normalizeRuntimeListOptions(agentOrOptions);
  const visibility = options.visibility;
  const notes: RuntimeNote[] = [];

  if (!visibility || visibility === 'shared' || visibility === 'all') {
    notes.push(...readAgentNotes(sharedRuntimeDir(cwd), options.agent));
  }

  if (!visibility || visibility === 'machine' || visibility === 'all') {
    notes.push(...readHostScopedNotes('machine', options, cwd));
  }

  if (visibility === 'private' || visibility === 'all') {
    notes.push(...readHostScopedNotes('private', options, cwd));
  }

  return notes.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function findRuntimeNoteById(id: string, options: RuntimeLookupOptions = {}, cwd?: string): RuntimeNote | undefined {
  return listRuntimeNotes({ ...options, visibility: options.visibility ?? 'all' }, cwd).find((note) => note.id === id);
}

export function generateRuntimeNoteId(): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `rtn_${rand}`;
}

export interface RuntimeNoteIdMigrationResult {
  migrated: Array<{ from: string; to: string }>;
  errors: string[];
}

/**
 * can_b8d53d18 — soft migration for runtime notes created with the legacy
 * `run_` prefix (the generateId fallback collided with agent_run ids).
 * Rewrites each note's id to `rtn_<same suffix>` and renames its file.
 * Old ids referenced in historical events stay historical; lookups are
 * list-scan based so nothing else needs to change.
 */
export function migrateRuntimeNoteIdPrefixes(cwd?: string): RuntimeNoteIdMigrationResult {
  const result: RuntimeNoteIdMigrationResult = { migrated: [], errors: [] };
  const legacy = listRuntimeNotes({ visibility: 'all', includeAllHosts: true }, cwd)
    .filter((note) => note.id.startsWith('run_'));
  if (legacy.length === 0) return result;

  const existingIds = new Set(listRuntimeNotes({ visibility: 'all', includeAllHosts: true }, cwd).map((n) => n.id));
  mutate({ cwd }, () => {
    for (const note of legacy) {
      try {
        let newId = `rtn_${note.id.slice('run_'.length)}`;
        while (existingIds.has(newId)) newId = generateRuntimeNoteId();
        const oldPath = runtimeNotePath(note, cwd);
        const migrated: RuntimeNote = { ...note, id: newId };
        const newPath = runtimeNotePath(migrated, cwd);
        saveVersionedJsonFile('runtime_note', newPath, RuntimeNoteSchema.parse(migrated));
        if (fs.existsSync(oldPath) && oldPath !== newPath) fs.unlinkSync(oldPath);
        existingIds.add(newId);
        result.migrated.push({ from: note.id, to: newId });
      } catch (err) {
        result.errors.push(`${note.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  return result;
}
