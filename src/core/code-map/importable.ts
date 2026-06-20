/**
 * Code Map P1c-B — importable-symbol index (the soundness boundary for symbol-level
 * resolution; Codex cadrage review: lock this before resolver integration).
 *
 * Given a TARGET file's symbol nodes + the target's provider, builds
 * `name -> importable candidates`. A name binds to a `imports_symbol` edge ONLY when
 * exactly ONE importable candidate carries it ({@link lookupImportable}) — a missing
 * or AMBIGUOUS name yields no edge (never guess by order/span/subtype).
 *
 * "Importable" is a LANGUAGE concern (dec#108/#109): it comes from the provider's
 * `isImportableSymbol` hook, or {@link defaultImportableSymbol} (exported && not a
 * synthetic export placeholder). The core only mints ids/edges.
 */
import type { CodeNode } from './types.js';
import type { CodeLanguageProvider } from './lang/provider.js';
import { defaultImportableSymbol } from './lang/provider.js';

/**
 * Build `name -> importable symbol candidates` for one target file. `nodes` is the
 * target shard's node list; only `kind: 'symbol'` nodes are considered, and the full
 * symbol set is passed to the provider hook (Python needs it for top-level span
 * containment).
 */
export function buildImportableIndex(
  nodes: readonly CodeNode[],
  provider: CodeLanguageProvider | null,
): Map<string, CodeNode[]> {
  const symbols = nodes.filter((n) => n.kind === 'symbol');
  const predicate = provider?.isImportableSymbol
    ? (n: CodeNode) => provider.isImportableSymbol!(n, symbols)
    : defaultImportableSymbol;
  const byName = new Map<string, CodeNode[]>();
  for (const n of symbols) {
    if (!predicate(n)) continue;
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  return byName;
}

/**
 * Resolve one imported name to its UNAMBIGUOUS importable symbol, or null when the
 * name is absent OR matches more than one importable candidate (ambiguous → skip).
 */
export function lookupImportable(index: Map<string, CodeNode[]>, name: string): CodeNode | null {
  const cands = index.get(name);
  if (!cands || cands.length !== 1) return null;
  return cands[0]!;
}
