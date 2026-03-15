import type { State, Constraint, Decision, Trap } from './schema.js';

export interface ContradictionReport {
  item_id: string;
  conflicts_with: string;
  reason: string;
  section: string;
}

const NEGATION_PAIRS: [string, string][] = [
  ['must', 'must not'],
  ['must', 'must never'],
  ['should', 'should not'],
  ['should', 'should never'],
  ['always', 'never'],
  ['enable', 'disable'],
  ['enabled', 'disabled'],
  ['use', 'do not use'],
  ['use', 'avoid'],
  ['allow', 'block'],
  ['allow', 'deny'],
  ['active', 'resolved'],
  ['required', 'forbidden'],
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function pathsOverlap(a?: string[], b?: string[]): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  return a.some(pa => b.some(pb => pa.startsWith(pb) || pb.startsWith(pa) || pa === pb));
}

function detectPairContradictions(textA: string, textB: string): string | null {
  const normA = normalize(textA);
  const normB = normalize(textB);
  for (const [pos, neg] of NEGATION_PAIRS) {
    if (normA.includes(pos) && normB.includes(neg)) return `"${pos}" vs "${neg}"`;
    if (normA.includes(neg) && normB.includes(pos)) return `"${neg}" vs "${pos}"`;
  }
  return null;
}

function tagsOverlap(a: string[], b: string[]): boolean {
  return a.some(t => b.includes(t));
}

export function detectContradictions(state: State): ContradictionReport[] {
  const reports: ContradictionReport[] = [];

  // Check constraint pairs
  const constraints = state.active_constraints.filter(c => c.status === 'active');
  for (let i = 0; i < constraints.length; i++) {
    for (let j = i + 1; j < constraints.length; j++) {
      const a = constraints[i];
      const b = constraints[j];
      // Only flag if there's path or tag overlap (same domain)
      if (!pathsOverlap(a.related_paths, b.related_paths) && !tagsOverlap(a.tags, b.tags)) continue;
      const contradiction = detectPairContradictions(a.text, b.text);
      if (contradiction) {
        reports.push({ item_id: a.id, conflicts_with: b.id, reason: contradiction, section: 'constraints' });
      }
    }
  }

  // Check decision pairs
  const decisions = state.recent_decisions;
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i];
      const b = decisions[j];
      if (!pathsOverlap(a.related_paths, b.related_paths) && !tagsOverlap(a.tags, b.tags)) continue;
      const contradiction = detectPairContradictions(a.text, b.text);
      if (contradiction) {
        reports.push({ item_id: a.id, conflicts_with: b.id, reason: contradiction, section: 'decisions' });
      }
    }
  }

  return reports;
}

export function detectNewItemContradictions(
  newText: string,
  newTags: string[],
  newPaths: string[] | undefined,
  state: State,
): ContradictionReport[] {
  const reports: ContradictionReport[] = [];
  const newId = 'new_item';

  const check = (existing: { id: string; text: string; tags: string[]; related_paths?: string[] }, section: string) => {
    if (!pathsOverlap(newPaths, existing.related_paths) && !tagsOverlap(newTags, existing.tags)) return;
    const contradiction = detectPairContradictions(newText, existing.text);
    if (contradiction) {
      reports.push({ item_id: newId, conflicts_with: existing.id, reason: contradiction, section });
    }
  };

  for (const c of state.active_constraints.filter(c => c.status === 'active')) check(c, 'constraints');
  for (const d of state.recent_decisions) check(d, 'decisions');

  return reports;
}
