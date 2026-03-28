import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { requireInitialized } from '../core/guards.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { createConstraint } from '../core/operations/memory-write.js';
import type { ConstraintCategory } from '../core/schema.js';

export interface ConstraintOptions {
  tag?: string[];
  path?: string[];
  category?: ConstraintCategory;
  author?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runConstraint(text: string, options: ConstraintOptions = {}): void {
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

  const result = createConstraint({
    text,
    author: options.author ?? resolveCurrentAgentName(cwd),
    category: options.category,
    tags: options.tag,
    relatedPaths: options.path,
  }, cwd);

  console.log(`✔ Constraint added: [${result.id}] ${text}`);
}
