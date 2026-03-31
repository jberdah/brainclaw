import fs from 'node:fs';
import path from 'node:path';
import type { PackageScores } from './socket-client.js';

export interface CacheEntry {
  scores: PackageScores;
  fetched_at: string; // ISO 8601
}

interface CacheStore {
  version: 1;
  entries: Record<string, CacheEntry>; // key = "ecosystem/depname@version"
}

function cacheKey(ecosystem: string, depname: string, version: string): string {
  return `${ecosystem}/${depname}@${version}`;
}

function loadStore(cachePath: string): CacheStore {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.entries === 'object') {
      return parsed as CacheStore;
    }
  } catch {
    // file missing or corrupt — start fresh
  }
  return { version: 1, entries: {} };
}

function saveStore(cachePath: string, store: CacheStore): void {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(store, null, 2), 'utf-8');
}

export class SecurityCache {
  private store: CacheStore;
  private readonly cachePath: string;
  private readonly ttlMs: number;

  constructor(cachePath: string, ttlHours: number = 24) {
    this.cachePath = cachePath;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.store = loadStore(cachePath);
  }

  get(ecosystem: string, depname: string, version: string): PackageScores | null {
    const key = cacheKey(ecosystem, depname, version);
    const entry = this.store.entries[key];
    if (!entry) return null;

    const age = Date.now() - new Date(entry.fetched_at).getTime();
    if (age > this.ttlMs) {
      delete this.store.entries[key];
      return null;
    }

    return entry.scores;
  }

  set(ecosystem: string, depname: string, version: string, scores: PackageScores): void {
    const key = cacheKey(ecosystem, depname, version);
    this.store.entries[key] = {
      scores,
      fetched_at: new Date().toISOString(),
    };
  }

  flush(): void {
    saveStore(this.cachePath, this.store);
  }

  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of Object.entries(this.store.entries)) {
      if (now - new Date(entry.fetched_at).getTime() > this.ttlMs) {
        delete this.store.entries[key];
        pruned++;
      }
    }
    return pruned;
  }

  size(): number {
    return Object.keys(this.store.entries).length;
  }
}
