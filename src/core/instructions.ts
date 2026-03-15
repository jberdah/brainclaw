import fs from 'node:fs';
import path from 'node:path';
import { memoryPath, writeFileAtomic } from './io.js';
import { generateId } from './ids.js';
import { InstructionEntrySchema, type Config, type InstructionEntry, type InstructionLayer } from './schema.js';

export interface CreateInstructionOptions {
  layer: InstructionLayer;
  scope?: string;
  tags?: string[];
  author: string;
  supersedes?: string;
}

export interface ResolveInstructionsOptions {
  project?: string;
  agent?: string;
}

export function loadInstructions(cwd?: string): InstructionEntry[] {
  const dir = memoryPath('instructions', cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries: InstructionEntry[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const filepath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filepath, 'utf-8');
      entries.push(InstructionEntrySchema.parse(JSON.parse(raw)));
    } catch {
      // Ignore malformed instruction files.
    }
  }

  return entries.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function saveInstruction(entry: InstructionEntry, cwd?: string): void {
  writeFileAtomic(memoryPath(path.join('instructions', `${entry.id}.json`), cwd), JSON.stringify(entry, null, 2));
}

export function createInstruction(text: string, options: CreateInstructionOptions, cwd?: string): InstructionEntry {
  const entries = loadInstructions(cwd);
  const timestamp = new Date().toISOString();
  const entry: InstructionEntry = {
    id: generateId('instruction_entries'),
    layer: options.layer,
    scope: options.scope,
    text,
    created_at: timestamp,
    updated_at: timestamp,
    author: options.author,
    tags: options.tags ?? [],
    active: true,
    supersedes: options.supersedes,
  };
  saveInstruction(entry, cwd);
  return entry;
}

export function resolveInstructions(entries: InstructionEntry[], options: ResolveInstructionsOptions = {}): InstructionEntry[] {
  const superseded = new Set(
    entries
      .filter((entry) => entry.active && entry.supersedes)
      .map((entry) => entry.supersedes as string),
  );

  const active = entries.filter((entry) => entry.active && !superseded.has(entry.id));
  const scoped = active.filter((entry) => {
    if (entry.layer === 'global') {
      return true;
    }
    if (entry.layer === 'project') {
      return entry.scope === options.project;
    }
    return entry.scope === options.agent;
  });

  const latestByScope = new Map<string, InstructionEntry>();
  for (const entry of scoped) {
    const key = `${entry.layer}:${entry.scope ?? '*'}`;
    const current = latestByScope.get(key);
    if (!current || current.updated_at.localeCompare(entry.updated_at) <= 0) {
      latestByScope.set(key, entry);
    }
  }

  return [...latestByScope.values()].sort((a, b) => {
    const rank = layerOrder(a.layer) - layerOrder(b.layer);
    if (rank !== 0) return rank;
    return a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id);
  });
}

export function inferProjectFromTarget(target: string | undefined, config: Config): string | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const known = config.projects?.known ?? [];
  if (known.includes(normalized)) {
    return normalized;
  }
  return known.find((project) => normalized === project || normalized.startsWith(`${project}/`));
}

export function findInstructionConflicts(entries: InstructionEntry[]): Array<{ layer: InstructionLayer; scope?: string; ids: string[] }> {
  const superseded = new Set(
    entries
      .filter((entry) => entry.active && entry.supersedes)
      .map((entry) => entry.supersedes as string),
  );

  const groups = new Map<string, InstructionEntry[]>();
  for (const entry of entries.filter((item) => item.active && !superseded.has(item.id))) {
    const key = `${entry.layer}:${entry.scope ?? ''}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  const conflicts: Array<{ layer: InstructionLayer; scope?: string; ids: string[] }> = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      conflicts.push({
        layer: group[0].layer,
        scope: group[0].scope,
        ids: group.map((entry) => entry.id),
      });
    }
  }

  return conflicts;
}

function layerOrder(layer: InstructionLayer): number {
  switch (layer) {
    case 'global':
      return 0;
    case 'project':
      return 1;
    case 'agent':
      return 2;
  }
}