import { execSync } from 'node:child_process';
import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { Handoff } from '../core/schema.js';

export interface HandoffOptions {
  from: string;
  to: string;
  tag?: string[];
  path?: string[];
  project?: string;
  plan?: string;
  author?: string;
  captureDiff?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

export function runHandoff(text: string, options: HandoffOptions): void {
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
  const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
  if (options.plan && !plan) {
    console.error(`Error: Plan item '${options.plan}' not found.`);
    process.exit(1);
  }
  const { id, short_label } = generateIdWithLabel('open_handoffs');

  let diff;
  if (options.captureDiff) {
    try {
      diff = execSync('git diff HEAD', { encoding: 'utf-8' });
    } catch {
      diff = "Could not capture git diff.";
    }
  }

  const entry: Handoff = {
    id,
    short_label,
    from: options.from,
    to: options.to,
    text,
    created_at: nowISO(),
    author: options.author ?? resolveCurrentAgentName(cwd),
    status: 'open',
    project: options.project ?? plan?.project,
    plan_id: options.plan,
    tags: options.tag ?? [],
    related_paths: options.path,
    snapshot: diff ? { diff } : undefined,
  };

  state.open_handoffs.push(entry);
  saveState(state, cwd);

  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));

  console.log(`✔ Handoff added: [${id}] ${options.from} → ${options.to}: ${text}`);
}


