import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { requireInitialized } from '../core/guards.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { createDecision } from '../core/operations/memory-write.js';
import type { DecisionOutcome } from '../core/schema.js';

export interface DecisionOptions {
  tag?: string[];
  path?: string[];
  outcome?: DecisionOutcome;
  author?: string;
  plan?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runDecision(text: string, options: DecisionOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  requireInitialized(cwd);

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

  const result = createDecision({
    text,
    author: options.author ?? resolveCurrentAgentName(cwd),
    outcome: options.outcome,
    tags: options.tag,
    relatedPaths: options.path,
    planId: options.plan,
  }, cwd);

  console.log(`✔ Decision added: [${result.id}] ${text}`);
}
