/**
 * pln#492 phase 2.d.1 — Critic brief assembly (pure function).
 *
 * Builds the message a slot receives when its phase fires. Honours the
 * phase's `context_filter` so the critic sees adversarial memory only
 * (traps + feedback + runtime_notes + critique_history), the proposal
 * sees positive context (decisions + constraints + plans + project_vision),
 * and revision/synthesis see the full bundle via the '*' wildcard.
 *
 * BM25 ranking, top-K, and the underlying memory store are injected via
 * `BriefMemoryProvider` so this module stays testable in isolation. The
 * dispatch wire-up (phase 2.d.2) plugs in a real provider backed by
 * bclaw_search.
 *
 * The bundle is capped at `maxChars` (default 48 000 ≈ 12 000 tokens at
 * ~4 chars/token English) to mitigate trp#179 (oversized payloads on
 * multi-trap projects forcing agents back to CLI fallbacks). Truncation
 * is greedy by category-then-item order, with a "(memory bundle truncated
 * — N items dropped)" tail so the operator can see when content was
 * dropped.
 */

import type {
  LoopArtifact,
  LoopContextCategory,
  LoopThread,
} from './types.js';
import { deriveWorkerReplyContract, renderWorkerReplyProse } from './worker-reply-contract.js';

export interface BriefMemoryItem {
  /** Stable id (e.g. trp_xxx, dec_xxx, runtime_note path). */
  id: string;
  /** Display category — same enum value the brief asked for. */
  category: LoopContextCategory;
  /** Human-readable text of the memory entry. May be summarised. */
  text: string;
  /** Optional BM25 score (just for diagnostics; not used for ordering). */
  score?: number;
  relatedPaths?: string[];
}

export interface BriefMemoryProvider {
  /**
   * Fetch up to `topK` memory items in `category` ranked against `query`.
   * Implementations are expected to apply BM25 (e.g. via bclaw_search),
   * but the brief assembly is agnostic: it only requires the items to
   * arrive in already-ranked order.
   *
   * The wildcard category '*' is NEVER passed to fetch — the assembler
   * resolves it to the full closed-enum set and calls fetch per-category.
   */
  fetch(category: LoopContextCategory, query: string, topK: number): BriefMemoryItem[];
}

export interface IdeationBriefInput {
  thread: LoopThread;
  /** Role of the slot this brief is being prepared for (e.g. 'critic'). */
  slotRole: string;
  memoryProvider: BriefMemoryProvider;
  /**
   * Cap for the assembled brief text. Default 48 000 ≈ 12 000 tokens
   * at ~4 chars/token English. Hard cap — the assembler truncates the
   * memory bundle (not the proposal seed) when over.
   */
  maxChars?: number;
  /**
   * Items fetched per memory category before truncation. Default 8.
   * The provider may return fewer if it has fewer matches.
   */
  topKPerCategory?: number;
  /** Explicit worker task seed. Defaults to the ideation proposal artifact. */
  seedText?: string;
  /** Lane paths used to suppress unrelated path-scoped memories. */
  scopeHints?: string[];
}

const DEFAULT_MAX_CHARS = 48_000;
const DEFAULT_TOP_K_PER_CATEGORY = 8;

/**
 * Concrete categories the wildcard '*' resolves to. Excludes loop-internal
 * categories (critique_history / revision_history / synthesis_artifact)
 * because those are sourced from the thread itself, not from the memory
 * provider.
 */
const WILDCARD_USER_FACING_CATEGORIES: LoopContextCategory[] = [
  'traps',
  'feedback',
  'runtime_notes',
  'decisions',
  'constraints',
  'handoffs',
  'plans',
  'candidates',
  'project_vision',
];

const LOOP_INTERNAL_CATEGORIES: ReadonlySet<LoopContextCategory> = new Set([
  'critique_history',
  'revision_history',
  'synthesis_artifact',
]);

export interface IdeationBriefResult {
  text: string;
  /**
   * True iff the memory bundle had to be truncated to fit `maxChars`.
   * The text already carries the "truncated" tail; this flag is provided
   * separately so callers can surface it as a warning.
   */
  truncated: boolean;
  /** Number of memory items actually included in the bundle. */
  includedItems: number;
  /** Number of memory items dropped due to the cap. */
  droppedItems: number;
  /** Categories the brief actually pulled from. */
  categoriesUsed: LoopContextCategory[];
}

export function buildIdeationBrief(input: IdeationBriefInput): IdeationBriefResult {
  const {
    thread,
    slotRole,
    memoryProvider,
    maxChars = DEFAULT_MAX_CHARS,
    topKPerCategory = DEFAULT_TOP_K_PER_CATEGORY,
    seedText,
    scopeHints = [],
  } = input;

  const proposal = findProposalArtifact(thread);
  const proposalText = seedText?.trim() || proposal?.body?.trim() || '(no proposal seed found)';

  // Resolve which memory categories the current phase wants. If the
  // current phase has no context_filter, fall back to '*' (full bundle).
  const currentPhaseDef = thread.phases.find((p) => p.name === thread.current_phase);
  const requestedCategories = currentPhaseDef?.context_filter ?? ['*'];

  const userFacingCategories = expandUserFacingCategories(requestedCategories);
  const includesLoopInternal = requestedCategories.some(
    (c) => c === '*' || LOOP_INTERNAL_CATEGORIES.has(c),
  );

  const fetchedItemsByCategory = new Map<LoopContextCategory, BriefMemoryItem[]>();
  const categoriesUsed: LoopContextCategory[] = [];
  for (const category of userFacingCategories) {
    const items = scopeMemoryItems(
      memoryProvider.fetch(category, `${proposalText} ${scopeHints.join(' ')}`.trim(), topKPerCategory),
      scopeHints,
    );
    if (items.length > 0) {
      fetchedItemsByCategory.set(category, items);
      categoriesUsed.push(category);
    }
  }

  // Loop-internal categories: pulled from thread.artifacts directly.
  // critique_history → all critique artifacts in iterations < current.
  // revision_history → all revision artifacts in iterations < current.
  // synthesis_artifact → the most recent synthesis output (if any).
  const priorArtifactsBlock = includesLoopInternal
    ? renderPriorArtifactsBlock(thread, requestedCategories)
    : '';

  const header = renderHeader(thread, slotRole, currentPhaseDef?.name ?? thread.current_phase);
  const proposalBlock = renderProposalBlock(proposalText);
  const memoryBlock = renderMemoryBlock(fetchedItemsByCategory);
  const closing = renderClosingInstructions(slotRole, thread.current_phase);

  // pln#638 PR-5 — the deliverable contract, derived from the CURRENT phase's
  // gate and frozen into the brief at dispatch time. This is the structural fix
  // for proof #1 (a critic typed `coverage_gap`, invisible to the critique gate):
  // the expected type was always known here; it just never travelled. FIXED
  // part, never truncated — a brief that keeps its memory bundle but loses its
  // reply contract would recreate the bug the section exists to prevent.
  const contract = deriveWorkerReplyContract(thread);
  const contractBlock = contract ? renderWorkerReplyProse(contract) : '';

  // Compose with truncation. The proposal seed, header, closing and contract
  // are fixed; memory + prior artifacts share the remaining budget. Memory
  // before prior-artifacts so the critic always sees fresh adversarial pressure.
  const fixedParts = [header, proposalBlock, closing, contractBlock];
  const fixedSize = fixedParts.reduce((n, s) => n + s.length, 0);
  const remainingBudget = Math.max(0, maxChars - fixedSize);

  const { text: truncatedMemory, truncated, droppedItems, includedItems } = truncateToBudget(
    [memoryBlock, priorArtifactsBlock].filter((s) => s.length > 0),
    fetchedItemsByCategory,
    remainingBudget,
  );

  // The contract closes the brief: the last thing a worker reads is how to
  // reply so its work counts.
  const text = [header, proposalBlock, truncatedMemory, closing, contractBlock]
    .filter((s) => s.length > 0)
    .join('\n\n');

  return { text, truncated, includedItems, droppedItems, categoriesUsed };
}

/* ─────────────────────── helpers ─────────────────────── */

function findProposalArtifact(thread: LoopThread): LoopArtifact | undefined {
  // Prefer the most recent proposal artifact (in case revisions added
  // updated proposal artifacts later).
  for (let i = thread.artifacts.length - 1; i >= 0; i--) {
    const a = thread.artifacts[i];
    if (a.type === 'proposal') return a;
  }
  return undefined;
}

function expandUserFacingCategories(
  requested: readonly LoopContextCategory[],
): LoopContextCategory[] {
  if (requested.includes('*')) {
    return [...WILDCARD_USER_FACING_CATEGORIES];
  }
  // Drop loop-internal categories — they're handled separately.
  return requested.filter((c) => !LOOP_INTERNAL_CATEGORIES.has(c) && c !== '*');
}

function renderHeader(thread: LoopThread, slotRole: string, phase: string): string {
  const lines = [
    `# ${thread.kind}_loop brief`,
    `loop: ${thread.id}`,
    `phase: ${phase}`,
    `iteration: ${thread.iteration_count}`,
    `slot: ${slotRole}`,
    `title: ${thread.title}`,
  ];
  if (thread.goal) lines.push(`goal: ${thread.goal}`);
  return lines.join('\n');
}

function normalizeScope(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Keep project-wide memories and memories whose related_paths overlap this lane. */
function scopeMemoryItems(items: BriefMemoryItem[], scopeHints: string[]): BriefMemoryItem[] {
  const scopes = scopeHints.map(normalizeScope).filter(Boolean);
  if (scopes.length === 0) return items;
  return items.filter((item) => {
    if (!item.relatedPaths || item.relatedPaths.length === 0) return true;
    return item.relatedPaths.some((related) => {
      const path = normalizeScope(related);
      return scopes.some((scope) => path.startsWith(scope) || scope.startsWith(path));
    });
  });
}

function renderProposalBlock(proposalText: string): string {
  return `## proposal\n\n${proposalText}`;
}

function renderMemoryBlock(byCategory: Map<LoopContextCategory, BriefMemoryItem[]>): string {
  if (byCategory.size === 0) return '';
  const sections: string[] = ['## memory bundle (BM25-ranked, filtered by phase context)'];
  for (const [category, items] of byCategory) {
    sections.push(`### ${category}`);
    for (const item of items) {
      sections.push(`- [${item.id}] ${item.text}`);
    }
  }
  return sections.join('\n');
}

function renderPriorArtifactsBlock(
  thread: LoopThread,
  requested: readonly LoopContextCategory[],
): string {
  // Critique history is the most useful loop-internal feed for the
  // critique phase: round 2+ critics see what was already raised so they
  // do not duplicate. revision_history gives them the proposer's response.
  const wantsCritique = requested.includes('*') || requested.includes('critique_history');
  const wantsRevision = requested.includes('*') || requested.includes('revision_history');
  const wantsSynthesis = requested.includes('*') || requested.includes('synthesis_artifact');

  const sections: string[] = [];
  if (wantsCritique) {
    const priorCritique = thread.artifacts.filter(
      (a) => a.type === 'critique' && (a.iteration ?? 0) < thread.iteration_count,
    );
    if (priorCritique.length > 0) {
      const lines = ['### critique_history (prior iterations)'];
      for (const a of priorCritique) {
        lines.push(`- [${a.artifact_id}] (iter ${a.iteration ?? 0}) ${truncateLine(a.body)}`);
      }
      sections.push(lines.join('\n'));
    }
  }
  if (wantsRevision) {
    const priorRevision = thread.artifacts.filter(
      (a) => a.phase === 'revision' && (a.iteration ?? 0) < thread.iteration_count,
    );
    if (priorRevision.length > 0) {
      const lines = ['### revision_history (prior iterations)'];
      for (const a of priorRevision) {
        lines.push(`- [${a.artifact_id}] (iter ${a.iteration ?? 0}) ${truncateLine(a.body)}`);
      }
      sections.push(lines.join('\n'));
    }
  }
  if (wantsSynthesis) {
    const synthesis = [...thread.artifacts]
      .reverse()
      .find((a) => a.phase === 'synthesis' && a.type === 'plan_draft');
    if (synthesis) {
      sections.push(
        `### synthesis_artifact\n- [${synthesis.artifact_id}] ${truncateLine(synthesis.body)}`,
      );
    }
  }
  if (sections.length === 0) return '';
  return ['## prior loop artifacts', ...sections].join('\n\n');
}

function renderClosingInstructions(slotRole: string, phase: string): string {
  return [
    `## what to produce`,
    `- Phase "${phase}" expects you to act in role "${slotRole}".`,
    `- Emit findings as LoopArtifacts via bclaw_loop intent='complete_turn' or 'add_artifact'.`,
    `- Cite the memory ids you relied on so the synthesis can audit coverage.`,
  ].join('\n');
}

function truncateLine(s: string | undefined, maxLen = 200): string {
  if (!s) return '(no body)';
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

interface TruncationResult {
  text: string;
  truncated: boolean;
  includedItems: number;
  droppedItems: number;
}

/**
 * Greedy truncation of the variable parts (memory bundle + prior artifacts)
 * to fit the remaining budget. We count items so the caller can warn about
 * dropped content.
 */
function truncateToBudget(
  blocks: string[],
  byCategory: Map<LoopContextCategory, BriefMemoryItem[]>,
  budget: number,
): TruncationResult {
  const totalItems = [...byCategory.values()].reduce((n, arr) => n + arr.length, 0);

  if (blocks.length === 0) {
    return { text: '', truncated: false, includedItems: 0, droppedItems: 0 };
  }

  const joined = blocks.join('\n\n');
  if (joined.length <= budget) {
    return { text: joined, truncated: false, includedItems: totalItems, droppedItems: 0 };
  }

  // Truncate hard at the budget boundary, append a tail noting the cut.
  const tail =
    '\n\n_(memory bundle truncated to fit the brief size cap; some items were dropped — re-run with a smaller proposal or a per-category top-K to surface the missing ones)_';
  const headRoom = Math.max(0, budget - tail.length);
  const truncatedHead = joined.slice(0, headRoom);
  const text = truncatedHead + tail;

  // Approximate dropped item count: count "- [id]" markers in the
  // dropped tail vs total.
  const droppedTail = joined.slice(headRoom);
  const droppedItems = (droppedTail.match(/^- \[/gm) ?? []).length;
  const includedItems = Math.max(0, totalItems - droppedItems);

  return { text, truncated: true, includedItems, droppedItems };
}
