import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CandidateSchema, type Candidate, type CandidateSource } from './schema.js';
import { resolveEntityDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { nowISO, getNextShortLabel } from './ids.js';
import { JsonStore } from './json-store.js';
import { refreshLiveCompanions } from '../commands/export.js';

export interface ListCandidatesFilter {
  /** Filter by a specific source value. */
  source?: CandidateSource;
  /**
   * When false, exclude auto-generated candidates (source === 'auto').
   * When true, include only auto-generated candidates.
   * Omitting this field applies no filter on auto_generated status.
   */
  auto_generated?: boolean;
}

export interface CleanupStaleCandidatesOptions {
  maxAgeDays?: number;
  source?: CandidateSource;
  dryRun?: boolean;
  cwd?: string;
}

export interface CleanupStaleCandidatesResult {
  matched: number;
  deleted: number;
  candidates: Candidate[];
}

/**
 * Return the effective source for a candidate.
 *
 * Resolution order:
 *   1. Explicit `source` field if set to a valid enum value ('auto'|'agent'|'human').
 *   2. Inferred from `origin` free-text pattern (e.g. 'runtime-note:...' → 'agent',
 *      'session-end:...' → 'auto', 'mcp:...' / 'cross-project:...' → 'agent').
 *   3. Default 'human' for legacy items without any provenance.
 *
 * This default is only applied in memory — no files are rewritten.
 */
export function resolvedSource(candidate: Candidate): CandidateSource {
  if (candidate.source) return candidate.source;
  return inferSourceFromOrigin(candidate.origin);
}

/** Infer the enum `source` from a free-text `origin` pattern. */
export function inferSourceFromOrigin(origin?: string): CandidateSource {
  if (!origin) return 'human';
  if (origin.startsWith('session-end:')) return 'auto';
  if (origin.startsWith('runtime-note:')) return 'agent';
  if (origin.startsWith('mcp:')) return 'agent';
  if (origin.startsWith('cross-project:')) return 'agent';
  // Unknown origin pattern — treat as agent since something explicit was set,
  // but not matching an auto pattern. Human sources typically have no origin.
  return 'agent';
}

function inboxDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('inbox', cwd ?? process.cwd(), mode);
}

function acceptedDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('inbox/accepted', cwd ?? process.cwd(), mode);
}

function rejectedDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return resolveEntityDir('inbox/rejected', cwd ?? process.cwd(), mode);
}

export function ensureInboxDirs(cwd?: string): void {
  for (const dir of [inboxDir(cwd, 'write'), acceptedDir(cwd, 'write'), rejectedDir(cwd, 'write')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function candidateStore(dest: 'pending' | 'accepted' | 'rejected' = 'pending', cwd?: string): JsonStore<Candidate> {
  const dir = dest === 'accepted'
    ? acceptedDir(cwd)
    : dest === 'rejected'
      ? rejectedDir(cwd)
      : inboxDir(cwd);
  return new JsonStore<Candidate>({
    dirPath: dir,
    documentType: 'candidate',
    getId: (candidate) => candidate.id,
    sort: (a, b) => a.created_at.localeCompare(b.created_at),
  });
}

export function saveCandidate(candidate: Candidate, cwd?: string): void {
  mutate({ cwd }, () => {
    ensureInboxDirs(cwd);
    candidateStore('pending', cwd).save(CandidateSchema.parse(candidate));
    // Auto-refresh live companions after candidate changes (non-fatal)
    try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
  });
}

export function loadCandidate(id: string, cwd?: string): Candidate {
  return candidateStore('pending', cwd).load(id);
}

export function updateCandidate(candidate: Candidate, cwd?: string): void {
  saveCandidate(candidate, cwd);
}

export function listCandidates(status?: 'pending' | 'accepted' | 'rejected', cwd?: string, filter?: ListCandidatesFilter): Candidate[] {
  const candidates = candidateStore('pending', cwd).list();
  const byStatus = status ? candidates.filter((candidate) => candidate.status === status) : candidates;
  return applySourceFilter(byStatus, filter);
}

function applySourceFilter(candidates: Candidate[], filter?: ListCandidatesFilter): Candidate[] {
  if (!filter) return candidates;
  let result = candidates;
  if (filter.source !== undefined) {
    result = result.filter((c) => resolvedSource(c) === filter.source);
  }
  if (filter.auto_generated === false) {
    result = result.filter((c) => resolvedSource(c) !== 'auto');
  } else if (filter.auto_generated === true) {
    result = result.filter((c) => resolvedSource(c) === 'auto');
  }
  return result;
}

export function archiveCandidate(candidate: Candidate, dest: 'accepted' | 'rejected', cwd?: string): void {
  mutate({ cwd }, () => {
    ensureInboxDirs(cwd);
    candidateStore(dest, cwd).save(CandidateSchema.parse(candidate));
    candidateStore('pending', cwd).delete(candidate.id);
    // Auto-refresh live companions after candidate archive (non-fatal)
    try { refreshLiveCompanions(cwd); } catch { /* best-effort */ }
  });
}

export function listArchivedCandidates(dest: 'accepted' | 'rejected', cwd?: string): Candidate[] {
  return candidateStore(dest, cwd).list();
}

export function deleteArchivedCandidate(id: string, dest: 'accepted' | 'rejected', cwd?: string): boolean {
  const dir = dest === 'accepted' ? acceptedDir(cwd) : rejectedDir(cwd);
  const filepath = path.join(dir, `${id}.json`);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    return true;
  }
  return false;
}

export function cleanupStaleCandidates(options: CleanupStaleCandidatesOptions = {}): CleanupStaleCandidatesResult {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const source = options.source ?? 'auto';
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
  const candidates = listCandidates('pending', options.cwd).filter((candidate) => {
    if (resolvedSource(candidate) !== source) return false;
    return Date.parse(candidate.created_at) <= cutoffMs;
  });

  if (options.dryRun || candidates.length === 0) {
    return {
      matched: candidates.length,
      deleted: 0,
      candidates,
    };
  }

  mutate({ cwd: options.cwd }, () => {
    const store = candidateStore('pending', options.cwd);
    for (const candidate of candidates) {
      store.delete(candidate.id);
    }
    try { refreshLiveCompanions(options.cwd); } catch { /* best-effort */ }
  });

  return {
    matched: candidates.length,
    deleted: candidates.length,
    candidates,
  };
}

export function addCandidateStar(id: string, by: string, cwd?: string): { candidate: Candidate; added: boolean } {
  const candidate = loadCandidate(id, cwd);
  if (candidate.status !== 'pending') {
    throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
  }

  const actor = by.trim();
  if (!actor) {
    throw new Error('Star actor must not be empty.');
  }

  if (candidate.starred_by.includes(actor)) {
    return { candidate, added: false };
  }

  candidate.starred_by = [...candidate.starred_by, actor].sort((a, b) => a.localeCompare(b));
  candidate.star_count = candidate.starred_by.length;
  candidate.last_starred_at = nowISO();
  updateCandidate(candidate, cwd);
  return { candidate, added: true };
}

export function addCandidateUse(id: string, by: string, context: string, cwd?: string): { candidate: Candidate; added: boolean } {
  const candidate = loadCandidate(id, cwd);
  if (candidate.status !== 'pending') {
    throw new Error(`Candidate '${id}' is already ${candidate.status}.`);
  }

  const actor = by.trim();
  const usageContext = context.trim();
  if (!actor) {
    throw new Error('Usage actor must not be empty.');
  }
  if (!usageContext) {
    throw new Error('Usage context must not be empty.');
  }

  const exists = candidate.usage_events.some((event) => event.by === actor && event.context === usageContext);
  if (exists) {
    return { candidate, added: false };
  }

  candidate.usage_events = [
    ...candidate.usage_events,
    { by: actor, context: usageContext, created_at: nowISO() },
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  candidate.usage_count = candidate.usage_events.length;
  candidate.last_used_at = nowISO();
  updateCandidate(candidate, cwd);
  return { candidate, added: true };
}

export function generateCandidateId(): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `cnd_${rand}`;
}

/** Generate both a hash candidate ID and a short label (e.g. `cnd#47`). */
export function generateCandidateIdWithLabel(cwd?: string): { id: string; short_label: string } {
  const rand = crypto.randomBytes(4).toString('hex');
  const id = `cnd_${rand}`;
  const short_label = getNextShortLabel('cnd', cwd);
  return { id, short_label };
}

/**
 * Resolve a candidate alias (`cnd#47`) or hash ID to the canonical hash ID.
 * Searches pending inbox only — use `resolveArchivedIdOrAlias` for historical items.
 */
export function resolveIdOrAlias(input: string, cwd?: string): string {
  if (!/^[a-z]+#\d+$/.test(input)) return input;
  const candidates = listCandidates(undefined, cwd);
  const found = candidates.find(c => c.short_label === input);
  if (!found) {
    throw new Error(`No pending candidate found with alias '${input}'.`);
  }
  return found.id;
}
