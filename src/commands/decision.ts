import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { Decision } from '../core/schema.js';

export interface DecisionOptions {
  tag?: string[];
  path?: string[];
  author?: string;
  plan?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runDecision(text: string, options: DecisionOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  validateCliInput(text, options.tag);

  const config = loadConfig(cwd);
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const state = loadState(cwd);
  const { id, short_label } = generateIdWithLabel('recent_decisions');

  const entry: Decision = {
    id,
    short_label,
    text,
    created_at: nowISO(),
    author: options.author ?? resolveCurrentAgentName(),
    tags: options.tag ?? [],
    related_paths: options.path,
    plan_id: options.plan,
  };

  state.recent_decisions.push(entry);
  saveState(state, cwd);

  // Rebuild markdown
  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state));

  console.log(`✔ Decision added: [${id}] ${text}`);
}


