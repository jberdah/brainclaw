import { buildContextDiff, resolveContextDiffSince } from '../core/context-diff.js';
import { listClaims, isClaimExpired } from '../core/claims.js';
import { loadInstructions, resolveInstructions } from '../core/instructions.js';
import { memoryExists } from '../core/io.js';
import { loadState } from '../core/state.js';
import { isTrapActive } from '../core/traps.js';
import { logHookDiagnostic } from '../core/hook-log.js';

export interface ContextDiffOptions {
  since?: string;
  session?: string;
  json?: boolean;
  /**
   * Hook mode (trp#917): running as a session hook. When there is no diff
   * baseline (e.g. the first prompt before a session marker exists) or any other
   * advisory failure, exit 0 silently instead of erroring every prompt.
   */
  hook?: boolean;
  cwd?: string;
}

/**
 * Hybrid context-diff: always includes critical anchors (active claims,
 * top traps, instructions) so the agent stays grounded, plus the memory
 * delta since last context read.
 */
export function runContextDiff(options: ContextDiffOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    if (options.hook) {
      logHookDiagnostic('context-diff skipped: .brainclaw/ not found');
      return;
    }
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const resolved = resolveContextDiffSince(options);
  if (!resolved.since) {
    if (options.hook) {
      // No diff baseline yet (e.g. first prompt before a session marker exists).
      // Nothing to surface — exit 0 silently so the hook never errors (trp#917).
      return;
    }
    if (options.session) {
      console.error(`Error: session '${options.session}' not found in session snapshots or audit log.`);
      process.exit(1);
    }
    console.error('Error: provide --since <ISO date> or --session <id>. (The per-agent "what\'s new" diff is surfaced automatically by `brainclaw context` / bclaw_work.)');
    process.exit(1);
  }

  const diff = buildContextDiff({ ...options, includeItems: true });
  if (!diff) {
    if (options.hook) {
      logHookDiagnostic('context-diff skipped: unable to build diff');
      return;
    }
    console.error('Error: unable to build context diff.');
    process.exit(1);
  }

  if (options.json) {
    const anchors = buildCriticalAnchors(options.cwd);
    console.log(JSON.stringify({ ...diff, anchors }, null, 2));
    return;
  }

  const lines: string[] = [];

  // --- Critical anchors (always present) ---
  const anchors = buildCriticalAnchors(options.cwd);

  if (anchors.claims.length > 0) {
    lines.push('Active claims:');
    for (const c of anchors.claims) {
      lines.push(`- [${c.id}] ${c.agent} → ${c.scope}: ${c.description}`);
    }
    lines.push('');
  }

  if (anchors.instructions.length > 0) {
    lines.push('Instructions:');
    for (const ins of anchors.instructions) {
      const scope = ins.scope ? `:${ins.scope}` : '';
      lines.push(`- [${ins.id}] <${ins.layer}${scope}> ${ins.text}`);
    }
    lines.push('');
  }

  if (anchors.traps.length > 0) {
    lines.push('Active traps:');
    for (const t of anchors.traps) {
      lines.push(`- [${t.id}] (${t.severity}) ${t.text}`);
    }
    lines.push('');
  }

  // --- Memory delta ---
  if (diff.counts.total === 0) {
    lines.push(`Memory: no changes since ${diff.since?.slice(0, 16).replace('T', ' ')}.`);
  } else {
    lines.push(`Memory delta (${diff.summary}):`);
    for (const item of diff.changed_items ?? []) {
      lines.push(`- [${item.section}] [${item.id}] ${item.text}`);
    }
  }

  console.log(lines.join('\n'));
}

interface CriticalAnchors {
  claims: Array<{ id: string; agent: string; scope: string; description: string }>;
  instructions: Array<{ id: string; layer: string; scope?: string; text: string }>;
  traps: Array<{ id: string; severity: string; text: string }>;
}

function buildCriticalAnchors(cwd?: string): CriticalAnchors {
  const activeClaims = listClaims(cwd)
    .filter((c) => c.status === 'active' && !isClaimExpired(c))
    .map((c) => ({ id: c.id, agent: c.agent, scope: c.scope, description: c.description }));

  const instructions = resolveInstructions(loadInstructions(cwd))
    .map((ins) => ({ id: ins.id, layer: ins.layer, scope: ins.scope, text: ins.text }));

  const state = loadState(cwd);
  const traps = state.known_traps
    .filter((t) => isTrapActive(t))
    .sort((a, b) => {
      const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (severityOrder[a.severity] ?? 1) - (severityOrder[b.severity] ?? 1);
    })
    .slice(0, 5)
    .map((t) => ({ id: t.id, severity: t.severity, text: t.text }));

  return { claims: activeClaims, instructions, traps };
}
