import { loadState, saveState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateId, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import type { PlanItem, Priority } from '../core/schema.js';

export interface PlanOptions {
  priority?: Priority;
  assignee?: string;
  project?: string;
  tag?: string[];
  path?: string[];
  author?: string;
  dependsOn?: string[];
}

export function runPlan(text: string, options: PlanOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  validateCliInput(text, options.tag);

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
  const id = generateId('plan_items');
  const timestamp = nowISO();

  const entry: PlanItem = {
    id,
    text,
    created_at: timestamp,
    updated_at: timestamp,
    author: options.author ?? getDefaultAuthor(),
    status: 'todo',
    priority: options.priority ?? 'medium',
    assignee: options.assignee,
    project: options.project,
    tags: options.tag ?? [],
    related_paths: options.path,
    depends_on: options.dependsOn ?? [],
  };

  state.plan_items.push(entry);
  saveState(state);
  writeFileAtomic(memoryPath('project.md'), generateMarkdown(state));

  console.log(`✔ Plan item added: [${id}] ${text}`);
}

function getDefaultAuthor(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}