import type { Candidate } from './schema.js';
import type { State } from './schema.js';

/**
 * Lightweight duplicate detection.
 * Compares a candidate's text against existing state entries and pending candidates.
 * Returns a list of similar items with a simple similarity reason.
 */
export interface DuplicateMatch {
  id: string;
  source: 'state' | 'candidate';
  text: string;
  reason: string;
}

export function detectDuplicates(
  candidateText: string,
  candidateType: string,
  state: State,
  pendingCandidates: Candidate[],
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const normalised = normalise(candidateText);

  // Check state entries for the same type
  const sectionMap: Record<string, Array<{ id: string; text: string }>> = {
    constraint: state.active_constraints,
    decision: state.recent_decisions,
    trap: state.known_traps,
    handoff: state.open_handoffs.map(h => ({ ...h, text: h.text })),
  };

  const items = sectionMap[candidateType] ?? [];
  for (const item of items) {
    const sim = similarity(normalised, normalise(item.text));
    if (sim >= 0.7) {
      matches.push({
        id: item.id,
        source: 'state',
        text: item.text,
        reason: sim >= 0.95 ? 'exact match' : 'similar text',
      });
    }
  }

  // Check pending candidates of the same type
  for (const c of pendingCandidates) {
    if (c.type !== candidateType) continue;
    const sim = similarity(normalised, normalise(c.text));
    if (sim >= 0.7) {
      matches.push({
        id: c.id,
        source: 'candidate',
        text: c.text,
        reason: sim >= 0.95 ? 'exact match' : 'similar text',
      });
    }
  }

  return matches;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Bigram-based similarity (Dice coefficient). Fast, no dependencies.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  let intersection = 0;
  const bCopy = new Map(bigramsB);

  for (const [bg, count] of bigramsA) {
    const bCount = bCopy.get(bg) ?? 0;
    if (bCount > 0) {
      intersection += Math.min(count, bCount);
    }
  }

  const totalA = [...bigramsA.values()].reduce((s, v) => s + v, 0);
  const totalB = [...bigramsB.values()].reduce((s, v) => s + v, 0);

  return (2 * intersection) / (totalA + totalB);
}

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const bg = text.slice(i, i + 2);
    result.set(bg, (result.get(bg) ?? 0) + 1);
  }
  return result;
}
