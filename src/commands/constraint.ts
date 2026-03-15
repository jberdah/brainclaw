import { loadState, saveState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateId, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import type { Constraint } from '../core/schema.js';

export interface ConstraintOptions {
  tag?: string[];
  path?: string[];
  author?: string;
}

export function runConstraint(text: string, options: ConstraintOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const state = loadState();
  const id = generateId('active_constraints');

  const entry: Constraint = {
    id,
    text,
    created_at: nowISO(),
    author: options.author ?? getDefaultAuthor(),
    status: 'active',
    tags: options.tag ?? [],
    related_paths: options.path,
  };

  state.active_constraints.push(entry);
  saveState(state);

  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Constraint added: [${id}] ${text}`);
}

function getDefaultAuthor(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}
