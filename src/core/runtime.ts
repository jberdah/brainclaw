import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId, sanitizeHostId } from './host.js';
import { resolveEntityDir, sanitizeAgentPathSegment } from './io.js';
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
  // pln#673 — the agent name is env-controlled and becomes a path segment:
  // normalize it so a traversal cannot be expressed at all.
  return path.join(sharedRuntimeDir(cwd, mode), sanitizeAgentPathSegment(agent));
}

/**
 * Return a pre-normalization directory only when it is provably one direct
 * child of `baseDir`. Compatibility reads must not reintroduce the traversal
 * the normalized write path closes: the agent name is still env-controlled.
 *
 * Dots inside a segment are retained for existing names such as
 * `Legacy.Agent`; separators, Win32 aliases (including trailing dots/spaces),
 * and platform-invalid components are not legacy data we can safely probe.
 */
const UNSAFE_LEGACY_AGENT_SEGMENT_RE = /[<>:"/\\|?*\u0000-\u001F]/;
const WIN32_RESERVED_LEGACY_AGENT_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function legacyAgentDir(baseDir: string, agent: string): string | undefined {
  if (
    agent.length === 0
    || agent !== agent.trim()
    || agent.endsWith('.')
    || UNSAFE_LEGACY_AGENT_SEGMENT_RE.test(agent)
    || WIN32_RESERVED_LEGACY_AGENT_BASENAME_RE.test(agent.split('.')[0]!)
  ) return undefined;

  const base = path.resolve(baseDir);
  const candidate = path.resolve(path.join(base, agent));
  return path.dirname(candidate) === base ? candidate : undefined;
}

/**
 * Both directories an agent's notes can occupy, canonical first (pln#673).
 * Writes always use the normalized segment; reads also probe the RAW name so
 * notes written before the normalization stay visible — the dual-read pattern
 * pln#648/pln#670 already use for relocated records. Deduped when the name is
 * already canonical, which is the case for every agent brainclaw produces.
 */
function agentDirCandidates(baseDir: string, agent: string): string[] {
  const canonical = path.join(baseDir, sanitizeAgentPathSegment(agent));
  const raw = legacyAgentDir(baseDir, agent);
  return raw && canonical !== raw ? [canonical, raw] : [canonical];
}

function hostRootDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, cwd?: string, mode: 'read' | 'write' = 'read'): string {
  const baseDir = visibility === 'machine' ? machineRuntimeDir(cwd, mode) : privateRuntimeDir(cwd, mode);
  return path.join(baseDir, sanitizeHostId(hostId));
}

function hostAgentDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, agent: string, cwd?: string, mode: 'read' | 'write' = 'read'): string {
  // pln#673 — same normalization as the shared tree; the host segment was
  // already sanitized (sanitizeHostId), the agent segment was not.
  return path.join(hostRootDir(visibility, hostId, cwd, mode), sanitizeAgentPathSegment(agent));
}

/** A contained raw path that can be retired after an update reaches its canonical location. */
function legacyRuntimeNotePath(note: RuntimeNote, visibility: MemoryVisibility, hostId: string, cwd?: string): string | undefined {
  const base = visibility === 'shared'
    ? sharedRuntimeDir(cwd, 'write')
    : hostRootDir(visibility, hostId, cwd, 'write');
  const legacyDir = legacyAgentDir(base, note.agent);
  return legacyDir ? path.join(legacyDir, `${note.id}.json`) : undefined;
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
    // An update to a pre-normalization record must not leave two physical
    // copies with the same id. Retire only the verified-contained raw path,
    // and only after the canonical write succeeds.
    const legacyPath = legacyRuntimeNotePath(note, visibility, hostId, cwd);
    if (legacyPath && legacyPath !== filepath && fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
    }
    appendEvent({ action: 'create', item_type: 'runtime_note', item_id: note.id, agent: note.agent, agent_id: note.agent_id }, cwd);
    commitMemoryChange(`runtime note: ${note.note_type ?? 'note'} (${note.agent})`, cwd);
  });
}

export function runtimeNotePath(note: RuntimeNote, cwd?: string): string {
  const visibility = note.visibility ?? 'shared';
  const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
  // pln#673 — the canonical (normalized) location, plus the RAW-name fallback
  // for notes written before the normalization: this function answers "where is
  // THIS note", and a record must not become invisible (nor undeletable)
  // because its directory predates the fix. Canonical first; the raw candidate
  // only wins when it actually holds the file.
  const base = visibility === 'shared'
    ? sharedRuntimeDir(cwd)
    : hostRootDir(visibility, hostId, cwd);
  const candidates = agentDirCandidates(base, note.agent).map((dir) => path.join(dir, `${note.id}.json`));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Park one runtime note's raw record under `.brainclaw/gc-backups/` — the same
 * park-don't-delete net the retention sweeps use (trp_dc9ca61e). Daily-bucketed
 * JSONL so removals do not explode into one file per note. Returns the backup
 * path, or undefined when the source record cannot be read.
 */
export function parkRuntimeNoteBackup(note: RuntimeNote, cwd?: string): string | undefined {
  try {
    const sourcePath = runtimeNotePath(note, cwd);
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed._removed_at = new Date().toISOString();
    parsed._removal_type = 'bclaw_remove';
    const day = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(cwd ?? process.cwd(), '.brainclaw', 'gc-backups', `removed-runtime-notes-${day}.jsonl`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.appendFileSync(backupPath, JSON.stringify(parsed) + '\n', 'utf-8');
    return backupPath;
  } catch {
    return undefined;
  }
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

  // pln#673 — a filtered read probes BOTH the normalized directory and the raw
  // name (a pre-normalization directory must stay readable); an unfiltered read
  // enumerates whatever is on disk, which covers both by construction. The
  // candidates are absolute, so the join below must not prepend `dir` again.
  const agentDirectories = agent
    ? agentDirCandidates(dir, agent)
    : fs.readdirSync(dir)
      .filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory())
      .map((entry) => path.join(dir, entry));
  const notes: RuntimeNote[] = [];
  for (const agentDirectory of agentDirectories) {
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
