import crypto from 'node:crypto';

const PREFIXES: Record<string, string> = {
  active_constraints: 'cst',
  recent_decisions: 'dec',
  known_traps: 'trp',
  open_handoffs: 'hnd',
  plan_items: 'pln',
  instruction_entries: 'ins',
};

/** Generate a concurrence-safe prefixed ID using 4 random bytes. */
export function generateId(section: string): string {
  const prefix = PREFIXES[section] ?? section.slice(0, 3);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${rand}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
