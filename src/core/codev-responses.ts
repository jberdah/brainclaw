import { memoryDir } from './io.js';
import fs from 'node:fs';
import path from 'node:path';

export interface CodevResponse {
  persona: string;
  agent: string;
  text: string;
  created_at: string;
}

export interface TimedCodevResponse extends CodevResponse {
  duration_ms: number;
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sanitizeForPath(slug: string): string {
  return slug.replace(/[<>:"/\\|?*]/g, '_');
}

export function responseDir(threadSlug: string, cwd?: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'ideation', sanitizeForPath(threadSlug), 'responses');
}

export function responseFilePath(
  threadSlug: string,
  roundNumber: number,
  persona: string,
  cwd?: string,
): string {
  return path.join(responseDir(threadSlug, cwd), `round_${roundNumber}_${persona}.json`);
}

/**
 * Persist a full CoDev/ideation phase body to the artifact store (pln#627
 * Phase C) and return a repo-relative pointer. The inbox thread then carries
 * only a bounded head + this pointer instead of a multi-hundred-KB rfc dump
 * (root cause of the 3.8 MB inbox: full phase briefs persisted as messages).
 * The `.brainclaw/coordination/ideation/<slug>/phases/` dir sits alongside the
 * existing per-round `responses/` store so a thread's artifacts stay together.
 */
export function writePhaseArtifact(
  threadSlug: string,
  label: string,
  text: string,
  cwd?: string,
): { path: string; relPath: string; charCount: number } {
  const dir = path.join(memoryDir(cwd), 'coordination', 'ideation', sanitizeForPath(threadSlug), 'phases');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeForPath(label)}.md`);
  fs.writeFileSync(filePath, text, 'utf8');
  const relPath = path.relative(memoryDir(cwd), filePath).split(path.sep).join('/');
  return { path: filePath, relPath, charCount: text.length };
}

export function writeResponse(
  threadSlug: string,
  roundNumber: number,
  persona: string,
  agent: string,
  text: string,
  cwd?: string,
): void {
  const filePath = responseFilePath(threadSlug, roundNumber, persona, cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: CodevResponse = { persona, agent, text, created_at: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export function readResponse(
  threadSlug: string,
  roundNumber: number,
  persona: string,
  cwd?: string,
): CodevResponse | undefined {
  const filePath = responseFilePath(threadSlug, roundNumber, persona, cwd);
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CodevResponse;
}

export function collectResponses(
  threadSlug: string,
  roundNumber: number,
  personas: string[],
  cwd?: string,
): CodevResponse[] {
  const responses: CodevResponse[] = [];
  for (const persona of personas) {
    const response = readResponse(threadSlug, roundNumber, persona, cwd);
    if (response) responses.push(response);
  }
  return responses;
}

export function awaitAllResponses(
  threadSlug: string,
  roundNumber: number,
  personas: string[],
  cwd?: string,
  pollIntervalMs: number = 10000,
): TimedCodevResponse[] {
  const startedAt = Date.now();
  const pending = new Set(personas);
  const received = new Map<string, TimedCodevResponse>();

  while (pending.size > 0) {
    for (const persona of pending) {
      const response = readResponse(threadSlug, roundNumber, persona, cwd);
      if (response) {
        received.set(persona, { ...response, duration_ms: Date.now() - startedAt });
      }
    }

    for (const persona of received.keys()) {
      pending.delete(persona);
    }

    if (pending.size === 0) break;
    console.log(`Waiting for responses: ${received.size}/${personas.length} received...`);
    syncSleep(pollIntervalMs);
  }

  return personas
    .map((persona) => received.get(persona))
    .filter((response): response is TimedCodevResponse => Boolean(response));
}