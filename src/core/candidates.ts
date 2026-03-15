import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CandidateSchema, type Candidate } from './schema.js';
import { memoryDir, writeFileAtomic, readFileSync } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';

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

export function saveCandidate(candidate: Candidate, cwd?: string): void {
  ensureInboxDirs(cwd);
  const filepath = path.join(inboxDir(cwd), `${candidate.id}.json`);
  writeFileAtomic(filepath, JSON.stringify(candidate, null, 2) + '\n');
}

export function loadCandidate(id: string, cwd?: string): Candidate {
  const filepath = path.join(inboxDir(cwd), `${id}.json`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Candidate '${id}' not found in inbox`);
  }
  return CandidateSchema.parse(JSON.parse(readFileSync(filepath)));
}

export function updateCandidate(candidate: Candidate, cwd?: string): void {
  saveCandidate(candidate, cwd);
}

export function listCandidates(status?: 'pending' | 'accepted' | 'rejected', cwd?: string): Candidate[] {
  const dir = inboxDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const candidates: Candidate[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(path.join(dir, file));
      const c = CandidateSchema.parse(JSON.parse(raw));
      if (!status || c.status === status) {
        candidates.push(c);
      }
    } catch (err) {
      logger.debug('Skipping malformed candidate file:', file, err);
    }
  }

  return candidates.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function archiveCandidate(candidate: Candidate, dest: 'accepted' | 'rejected', cwd?: string): void {
  const destDir = dest === 'accepted' ? acceptedDir(cwd) : rejectedDir(cwd);
  ensureInboxDirs(cwd);
  const src = path.join(inboxDir(cwd), `${candidate.id}.json`);
  const target = path.join(destDir, `${candidate.id}.json`);
  writeFileAtomic(target, JSON.stringify(candidate, null, 2) + '\n');
  if (fs.existsSync(src)) {
    fs.unlinkSync(src);
  }
}

export function listArchivedCandidates(dest: 'accepted' | 'rejected', cwd?: string): Candidate[] {
  const dir = dest === 'accepted' ? acceptedDir(cwd) : rejectedDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const candidates: Candidate[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(path.join(dir, file));
      candidates.push(CandidateSchema.parse(JSON.parse(raw)));
    } catch (err) {
      logger.debug('Skipping malformed candidate file:', file, err);
    }
  }
  return candidates.sort((a, b) => a.created_at.localeCompare(b.created_at));
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
