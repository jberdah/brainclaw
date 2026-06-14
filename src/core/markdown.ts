import type { State } from './schema.js';
import { loadInstructions } from './instructions.js';
import { memoryPath, writeFileAtomic } from './io.js';
import { isTrapActive } from './traps.js';
import { logger } from './logger.js';

export function generateMarkdown(state: State, cwd?: string): string {
  const lines: string[] = [
    '# Project Memory',
    '',
    '> Legacy derived summary generated from canonical Brainclaw memory.',
    '> PROJECT.md at the workspace root is the durable project vision.',
    '> For active claims, plans, handoffs, and agent state, use `brainclaw agent-board` or MCP board context.',
    '',
  ];
  const instructions = loadInstructions(cwd).filter((entry) => entry.active);

  lines.push('## Shared instructions');
  if (instructions.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of instructions) {
      const scope = entry.scope ? `:${entry.scope}` : '';
      const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
      lines.push(`- **[${entry.id}]** <${entry.layer}${scope}> ${entry.text}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Active constraints');
  if (state.active_constraints.length === 0) {
    lines.push('- (none)');
  } else {
    for (const c of state.active_constraints) {
      const tags = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
      const paths = c.related_paths?.length ? ` → ${c.related_paths.join(', ')}` : '';
      lines.push(`- **[${c.id}]** ${c.text} _(${c.status})_${paths}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Recent decisions');
  if (state.recent_decisions.length === 0) {
    lines.push('- (none)');
  } else {
    for (const d of state.recent_decisions) {
      const tags = d.tags.length ? ` [${d.tags.join(', ')}]` : '';
      const paths = d.related_paths?.length ? ` → ${d.related_paths.join(', ')}` : '';
      lines.push(`- **[${d.id}]** ${d.text}${paths}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Known traps');
  const activeTraps = state.known_traps.filter((trap) => isTrapActive(trap));
  if (activeTraps.length === 0) {
    lines.push('- (none)');
  } else {
    for (const t of activeTraps) {
      const tags = t.tags.length ? ` [${t.tags.join(', ')}]` : '';
      const paths = t.related_paths?.length ? ` → ${t.related_paths.join(', ')}` : '';
      lines.push(`- **[${t.id}]** ${t.text} _(${t.severity})_${paths}${tags}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Rebuild `.brainclaw/project.md` from canonical state.
 *
 * This is a **derived view** — it can always be regenerated from the
 * canonical JSON files. Call this once at the end of a top-level mutation,
 * not inside every nested helper. Best-effort: failures are logged but
 * never propagate to the caller.
 */
export function rebuildProjectMd(state: State, cwd?: string): void {
  try {
    writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
  } catch (err) {
    logger.debug('Failed to rebuild project.md:', err);
  }
}
