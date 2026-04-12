import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';

const PREFIXES: Record<string, string> = {
  active_constraints: 'cst',
  bootstrap_seeds: 'bsd',
  recent_decisions: 'dec',
  known_traps: 'trp',
  open_handoffs: 'hnd',
  plan_items: 'pln',
  plan_steps: 'stp',
  sequences: 'seq',
  instruction_entries: 'ins',
  ai_surface_tasks: 'ast',
  inbox_messages: 'msg',
  assignments: 'asgn',
};

const ID_COUNTER_FILE = '.id-counter.json';

function counterPath(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), '.brainclaw', ID_COUNTER_FILE);
}

/** Generate a concurrence-safe prefixed ID using 4 random bytes. */
export function generateId(section: string): string {
  const prefix = PREFIXES[section] ?? section.slice(0, 3);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${rand}`;
}

/**
 * Atomically increment the per-prefix counter and return the next short label.
 * Best-effort: if the counter file is unavailable the call still succeeds.
 */
export function getNextShortLabel(prefix: string, cwd?: string): string {
  const fp = counterPath(cwd);
  return withLock(fp, () => {
    let counter: Record<string, number> = {};
    try {
      counter = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Record<string, number>;
    } catch { /* first use or missing file */ }
    const next = (counter[prefix] ?? 0) + 1;
    counter[prefix] = next;
    fs.writeFileSync(fp, JSON.stringify(counter), 'utf-8');
    return `${prefix}#${next}`;
  });
}

/**
 * Generate both a concurrence-safe hash ID and a human-readable short label.
 * The hash ID is the canonical storage key; the short label is for display and aliased lookups.
 */
export function generateIdWithLabel(section: string, cwd?: string): { id: string; short_label: string } {
  const id = generateId(section);
  const prefix = PREFIXES[section] ?? section.slice(0, 3);
  const short_label = getNextShortLabel(prefix, cwd);
  return { id, short_label };
}

export function nowISO(): string {
  return new Date().toISOString();
}
