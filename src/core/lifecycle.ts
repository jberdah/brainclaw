import { loadState } from './state.js';
import { loadInstructions } from './instructions.js';

export type TriggeredItemType = 'trap' | 'constraint' | 'decision' | 'instruction';

export interface TriggeredItem {
  type: TriggeredItemType;
  id: string;
  text: string;
}

/**
 * Returns all memory items tagged with the given trigger tag.
 * Supports: traps, constraints, decisions, instructions.
 *
 * Convention: trigger tags take the form "trigger:<event>"
 * e.g. "trigger:post-claim", "trigger:pre-session-end", "trigger:post-session-start"
 */
export function getTriggeredItems(tag: string, cwd?: string): TriggeredItem[] {
  const items: TriggeredItem[] = [];
  const state = loadState(cwd);

  for (const trap of state.known_traps) {
    if (trap.tags.includes(tag)) {
      items.push({ type: 'trap', id: trap.id, text: trap.text });
    }
  }

  for (const constraint of state.active_constraints) {
    if (constraint.tags.includes(tag)) {
      items.push({ type: 'constraint', id: constraint.id, text: constraint.text });
    }
  }

  for (const decision of state.recent_decisions) {
    if (decision.tags.includes(tag)) {
      items.push({ type: 'decision', id: decision.id, text: decision.text });
    }
  }

  for (const instruction of loadInstructions(cwd)) {
    if (instruction.tags.includes(tag)) {
      items.push({ type: 'instruction', id: instruction.id, text: instruction.text });
    }
  }

  return items;
}

/**
 * Renders triggered items as a text block for inclusion in MCP responses.
 * Returns empty string if no items found.
 */
export function renderTriggeredItems(items: TriggeredItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((item) => `⚡ [${item.type}] ${item.text}`);
  return lines.join('\n');
}
