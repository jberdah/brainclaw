import { resolveAgentScope, resolveCurrentAgentName } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { createInstruction } from '../core/instructions.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadState } from '../core/state.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { InstructionLayer } from '../core/schema.js';

export interface InstructionOptions {
  layer?: InstructionLayer;
  project?: string;
  agent?: string;
  tag?: string[];
  author?: string;
  supersedes?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runInstruction(text: string, options: InstructionOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  validateCliInput(text, options.tag);

  const layer = options.layer ?? 'global';
  const scope = resolveScope(layer, options);
  const config = loadConfig(cwd);
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const entry = createInstruction(text, {
    layer,
    scope,
    tags: options.tag,
    author: options.author ?? resolveCurrentAgentName(),
    supersedes: options.supersedes,
  }, cwd);

  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(loadState(cwd)));
  console.log(`✔ Instruction added: [${entry.id}] <${entry.layer}${entry.scope ? `:${entry.scope}` : ''}> ${entry.text}`);
}

function resolveScope(layer: InstructionLayer, options: InstructionOptions): string | undefined {
  if (layer === 'global') {
    return undefined;
  }
  if (layer === 'project') {
    if (!options.project) {
      console.error('Error: --project is required when --layer project is used.');
      process.exit(1);
    }
    return options.project;
  }
  const agentScope = resolveAgentScope(options.agent);
  if (!agentScope) {
    console.error('Error: no agent scope available. Use --agent or configure a current agent with `brainclaw register-agent <name> --set-current`.');
    process.exit(1);
  }
  return agentScope;
}

