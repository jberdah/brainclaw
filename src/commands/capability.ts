import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { listCapabilities, createCapability } from '../core/registries.js';

export interface CapabilityOptions {
  tag?: string[];
  author?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runCapability(subcommand: string, args: string[], options: CapabilityOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (subcommand === 'list') {
    runCapabilityList(cwd);
  } else if (subcommand === 'add') {
    const name = args[0];
    const description = args[1];
    if (!name || !description) {
      console.error('Error: capability add requires <name> <description>');
      process.exit(1);
    }
    runCapabilityAdd(name, description, options, cwd);
  } else if (subcommand === 'describe') {
    const capId = args[0];
    if (!capId) {
      console.error('Error: capability describe requires <id>');
      process.exit(1);
    }
    runCapabilityDescribe(capId, cwd);
  } else {
    console.error(`Unknown capability subcommand: ${subcommand}`);
    process.exit(1);
  }
}

function runCapabilityList(cwd: string): void {
  const capabilities = listCapabilities(cwd);

  if (capabilities.length === 0) {
    console.log('No capabilities registered yet.');
    return;
  }

  console.log(`\n${capabilities.length} capability(ies):\n`);
  capabilities.forEach((cap) => {
    console.log(`  [${cap.id}] ${cap.name}`);
    if (cap.tags.length > 0) {
      console.log(`      tags: ${cap.tags.join(', ')}`);
    }
  });
  console.log('');
}

function runCapabilityAdd(name: string, description: string, options: CapabilityOptions, cwd: string): void {
  validateCliInput(name + ' ' + description, options.tag);

  const config = loadConfig(cwd);
  const warnings = scanText(name + ': ' + description, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const cap = createCapability({
    name,
    description,
    tags: options.tag,
    author: options.author ?? resolveCurrentAgentName(cwd),
  }, cwd);

  console.log(`✔ Capability added: [${cap.id}] ${name}`);
}

function runCapabilityDescribe(capId: string, cwd: string): void {
  const capabilities = listCapabilities(cwd);
  const cap = capabilities.find((c) => c.id === capId || c.id.startsWith(capId));

  if (!cap) {
    console.error(`Error: capability '${capId}' not found`);
    process.exit(1);
  }

  console.log(`\nCapability: ${cap.name}`);
  console.log(`Description: ${cap.description}`);
  console.log(`ID: ${cap.id}`);
  console.log(`Category: ${cap.category}`);
  console.log(`Author: ${cap.author}`);
  console.log(`Created: ${cap.created_at}`);
  if (cap.tags.length > 0) {
    console.log(`Tags: ${cap.tags.join(', ')}`);
  }
  console.log('');
}
