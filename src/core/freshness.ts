import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCurrentHostId } from './host.js';
import { memoryPath, readFileSync, writeFileAtomic } from './io.js';

export interface ContextMarker {
  read_at: string;
  memory_version?: string;
  host_id?: string;
  target?: string;
  project?: string;
  all_hosts?: boolean;
}

const SHARED_PATHS = [
  'config.yaml',
  'project.md',
  'constraints',
  'decisions',
  'traps',
  'handoffs',
  'plans',
  'instructions',
  'claims',
  'runtime',
  'inbox',
];

export function getVisibleMemoryVersion(options: { cwd?: string; hostId?: string; allHosts?: boolean } = {}): string {
  const entries: string[] = [];

  for (const relativePath of SHARED_PATHS) {
    collectFileStats(memoryPath(relativePath, options.cwd), relativePath, entries);
  }

  if (options.allHosts) {
    collectFileStats(memoryPath('runtime-hosts', options.cwd), 'runtime-hosts', entries);
    collectFileStats(memoryPath('runtime-private', options.cwd), 'runtime-private', entries);
    collectFileStats(memoryPath('traps-hosts', options.cwd), 'traps-hosts', entries);
    collectFileStats(memoryPath('traps-private', options.cwd), 'traps-private', entries);
  } else {
    const hostId = options.hostId ?? resolveCurrentHostId();
    collectFileStats(memoryPath(path.join('runtime-hosts', hostId), options.cwd), path.join('runtime-hosts', hostId), entries);
    collectFileStats(memoryPath(path.join('runtime-private', hostId), options.cwd), path.join('runtime-private', hostId), entries);
    collectFileStats(memoryPath(path.join('traps-hosts', hostId), options.cwd), path.join('traps-hosts', hostId), entries);
    collectFileStats(memoryPath(path.join('traps-private', hostId), options.cwd), path.join('traps-private', hostId), entries);
  }

  const hash = crypto.createHash('sha1');
  for (const entry of entries.sort()) {
    hash.update(entry);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function readContextMarker(cwd?: string): ContextMarker | undefined {
  const markerPath = memoryPath('.last-context', cwd);
  if (!fs.existsSync(markerPath)) {
    return undefined;
  }

  const raw = readFileSync(markerPath).trim();
  if (!raw) {
    return undefined;
  }

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as ContextMarker;
      if (parsed && typeof parsed.read_at === 'string') {
        return parsed;
      }
    } catch {
      return undefined;
    }
  }

  return { read_at: raw };
}

export function writeContextMarker(marker: ContextMarker, cwd?: string): void {
  writeFileAtomic(memoryPath('.last-context', cwd), JSON.stringify(marker, null, 2) + '\n');
}

function collectFileStats(absolutePath: string, relativePath: string, entries: string[]): void {
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolutePath).sort()) {
      collectFileStats(path.join(absolutePath, child), `${relativePath}/${child}`, entries);
    }
    return;
  }

  entries.push(`${relativePath}:${stat.size}:${stat.mtimeMs}`);
}