import fs from 'node:fs';
import path from 'node:path';
import { resolveEventSessionId } from './identity.js';
import { RuntimeEventSchema, type RuntimeEvent } from './schema.js';
import { readFileSync, resolveEntityDir } from './io.js';
import { logger } from './logger.js';

function runtimeDir(cwd?: string): string {
  return resolveEntityDir('runtime', cwd ?? process.cwd(), 'read');
}

function collectJsonFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

export function listRuntimeEvents(cwd?: string): RuntimeEvent[] {
  const base = runtimeDir(cwd);
  if (!fs.existsSync(base)) return [];

  const events: RuntimeEvent[] = [];
  for (const file of collectJsonFiles(base)) {
    try {
      const parsed = JSON.parse(readFileSync(file));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          events.push(RuntimeEventSchema.parse(item));
        }
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
        for (const item of parsed.events) {
          events.push(RuntimeEventSchema.parse(item));
        }
      } else {
        events.push(RuntimeEventSchema.parse(parsed));
      }
    } catch (err) {
      logger.debug('Ignoring malformed runtime event file:', file, err);
    }
  }

  return events.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function listRuntimeEventsBySession(session: string, cwd?: string): RuntimeEvent[] {
  return listRuntimeEvents(cwd).filter((event) => resolveEventSessionId(event) === session);
}
