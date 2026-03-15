import { loadState, saveState } from '../core/state.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateMarkdown } from '../core/markdown.js';
import type { HandoffStatus } from '../core/schema.js';

export interface UpdateHandoffOptions {
  status?: HandoffStatus;
  to?: string;
}

export function runUpdateHandoff(id: string, options: UpdateHandoffOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState();
  const handoff = state.open_handoffs.find((item) => item.id === id);
  if (!handoff) {
    console.error(`Error: Handoff '${id}' not found.`);
    process.exit(1);
  }

  if (options.status) handoff.status = options.status;
  if (options.to !== undefined) handoff.to = options.to;

  saveState(state);
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Handoff updated: [${handoff.id}] ${handoff.from} → ${handoff.to} (${handoff.status})`);
}
