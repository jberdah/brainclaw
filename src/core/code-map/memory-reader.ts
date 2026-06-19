/**
 * Default brainclaw-memory reader for Code Map `brief()` related-memory
 * attachment (spec §11).
 *
 * This is the production wiring of the `MemoryReader` seam declared in
 * query.ts. It reuses the canonical entity read path (`listEntities`) — the
 * same one `bclaw_find`/`bclaw_context` use — so related-memory attachment sees
 * exactly the decisions/traps/constraints/plans an agent would see elsewhere,
 * with no duplicated store logic.
 *
 * The seam is deliberately injectable: tests construct `RelatedMemoryItem[]`
 * directly instead of standing up a full entity store, and the backend can swap
 * this for a cross-project or budget-bounded reader later without touching the
 * ranking logic in query.ts.
 */
import { listEntities } from '../entity-operations.js';
import type { EntityName } from '../entity-registry.js';
import type { MemoryReader, QueryContext, RelatedMemoryItem } from './query.js';

/** Entity kinds carrying path/tag context useful to a code-scope brief (spec §11). */
const MEMORY_ENTITY_KINDS: EntityName[] = ['decision', 'trap', 'constraint', 'plan'];

function coerceTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

function coercePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string');
  return [];
}

function toRelatedMemoryItem(kind: EntityName, item: Record<string, unknown>): RelatedMemoryItem {
  return {
    id: typeof item.id === 'string' ? item.id : '',
    kind,
    text: typeof item.text === 'string' ? item.text : '',
    tags: coerceTags(item.tags),
    related_paths: coercePaths(item.related_paths),
  };
}

/**
 * Production `MemoryReader`: read decisions/traps/constraints/plans for the
 * project at `ctx.cwd` via the canonical entity read path. Best-effort — a read
 * failure for one kind never breaks a brief; it simply contributes no memory.
 */
export const defaultMemoryReader: MemoryReader = (ctx: QueryContext): RelatedMemoryItem[] => {
  const cwd = ctx.cwd ?? process.cwd();
  const out: RelatedMemoryItem[] = [];
  for (const kind of MEMORY_ENTITY_KINDS) {
    try {
      const result = listEntities(kind, cwd, { includeLegacy: true });
      for (const raw of result.items) {
        out.push(toRelatedMemoryItem(kind, raw as Record<string, unknown>));
      }
    } catch {
      // best-effort: a brief never fails because one memory kind couldn't load.
    }
  }
  return out;
};
