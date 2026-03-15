import { loadState, saveState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateId, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import type { Decision } from '../core/schema.js';

export interface DecisionOptions {
  tag?: string[];
  path?: string[];
  author?: string;
}

export function runDecision(text: string, options: DecisionOptions = {}): void {
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
  const id = generateId('recent_decisions');

  const entry: Decision = {
    id,
    text,
    created_at: nowISO(),
    author: options.author ?? getDefaultAuthor(),
    tags: options.tag ?? [],
    related_paths: options.path,
  };

  state.recent_decisions.push(entry);
  saveState(state);

  // Rebuild markdown
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Decision added: [${id}] ${text}`);
}

function getDefaultAuthor(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}
