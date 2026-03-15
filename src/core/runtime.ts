import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId, sanitizeHostId } from './host.js';
import { memoryDir, writeFileAtomic, readFileSync } from './io.js';
import { RuntimeNoteSchema, type MemoryVisibility, type RuntimeNote } from './schema.js';

const RUNTIME_SHARED_DIR = 'runtime';
const RUNTIME_MACHINE_DIR = 'runtime-hosts';
const RUNTIME_PRIVATE_DIR = 'runtime-private';

export interface RuntimeListOptions {
  agent?: string;
  visibility?: MemoryVisibility | 'all';
  hostId?: string;
  includeAllHosts?: boolean;
}

export interface RuntimeLookupOptions extends RuntimeListOptions {}

function sharedRuntimeDir(cwd?: string): string {
  return path.join(memoryDir(cwd), RUNTIME_SHARED_DIR);
}

function machineRuntimeDir(cwd?: string): string {
  return path.join(memoryDir(cwd), RUNTIME_MACHINE_DIR);
}

function privateRuntimeDir(cwd?: string): string {
  return path.join(memoryDir(cwd), RUNTIME_PRIVATE_DIR);
}

function sharedAgentDir(agent: string, cwd?: string): string {
  return path.join(sharedRuntimeDir(cwd), agent);
}

function hostRootDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, cwd?: string): string {
  const baseDir = visibility === 'machine' ? machineRuntimeDir(cwd) : privateRuntimeDir(cwd);
  return path.join(baseDir, sanitizeHostId(hostId));
}

function hostAgentDir(visibility: Extract<MemoryVisibility, 'machine' | 'private'>, hostId: string, agent: string, cwd?: string): string {
  return path.join(hostRootDir(visibility, hostId, cwd), agent);
}

export function ensureRuntimeDir(agent: string, cwd?: string, visibility: MemoryVisibility = 'shared', hostId?: string): void {
  const dir = visibility === 'shared'
    ? sharedAgentDir(agent, cwd)
    : hostAgentDir(visibility, hostId ?? resolveCurrentHostId(), agent, cwd);
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

  ensureRuntimeDir(note.agent, cwd, visibility, hostId);
  const filepath = visibility === 'shared'
    ? path.join(sharedAgentDir(note.agent, cwd), `${note.id}.json`)
    : path.join(hostAgentDir(visibility, hostId!, note.agent, cwd), `${note.id}.json`);
  writeFileAtomic(filepath, JSON.stringify(persistedNote, null, 2) + '\n');
}

export function runtimeNotePath(note: RuntimeNote, cwd?: string): string {
  const visibility = note.visibility ?? 'shared';
  const hostId = sanitizeHostId(note.host_id ?? resolveCurrentHostId());
  return visibility === 'shared'
    ? path.join(sharedAgentDir(note.agent, cwd), `${note.id}.json`)
    : path.join(hostAgentDir(visibility, hostId, note.agent, cwd), `${note.id}.json`);
}

export function deleteRuntimeNote(note: RuntimeNote, cwd?: string): boolean {
  const filepath = runtimeNotePath(note, cwd);
  if (!fs.existsSync(filepath)) {
    return false;
  }
  fs.unlinkSync(filepath);
  return true;
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
        const raw = readFileSync(path.join(agentDirectory, file));
        notes.push(RuntimeNoteSchema.parse(JSON.parse(raw)));
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
