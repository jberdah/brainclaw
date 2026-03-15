import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CandidateSchema, type Candidate } from './schema.js';
import { memoryDir } from './io.js';
import { nowISO } from './ids.js';
import { JsonStore } from './json-store.js';

const INBOX_DIR = 'inbox';
const ACCEPTED_DIR = 'inbox/accepted';
const REJECTED_DIR = 'inbox/rejected';

function inboxDir(cwd?: string): string {
  return path.join(memoryDir(cwd), INBOX_DIR);
}

function acceptedDir(cwd?: string): string {
  return path.join(memoryDir(cwd), ACCEPTED_DIR);
}

function rejectedDir(cwd?: string): string {
  return path.join(memoryDir(cwd), REJECTED_DIR);
}

export function ensureInboxDirs(cwd?: string): void {
  for (const dir of [inboxDir(cwd), acceptedDir(cwd), rejectedDir(cwd)]) {
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
  ensureInboxDirs(cwd);
  candidateStore('pending', cwd).save(CandidateSchema.parse(candidate));
}

export function loadCandidate(id: string, cwd?: string): Candidate {
  return candidateStore('pending', cwd).load(id);
}

export function updateCandidate(candidate: Candidate, cwd?: string): void {
  saveCandidate(candidate, cwd);
}

export function listCandidates(status?: 'pending' | 'accepted' | 'rejected', cwd?: string): Candidate[] {
  const candidates = candidateStore('pending', cwd).list();
  return status ? candidates.filter((candidate) => candidate.status === status) : candidates;
}

export function archiveCandidate(candidate: Candidate, dest: 'accepted' | 'rejected', cwd?: string): void {
  ensureInboxDirs(cwd);
  candidateStore(dest, cwd).save(CandidateSchema.parse(candidate));
  candidateStore('pending', cwd).delete(candidate.id);
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
