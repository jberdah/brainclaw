import { resolveAgentScope } from '../core/agent-registry.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from '../core/instructions.js';
import { loadConfig } from '../core/config.js';
import { memoryExists } from '../core/io.js';
import type { InstructionLayer } from '../core/schema.js';

export interface ListInstructionsOptions {
  json?: boolean;
  layer?: InstructionLayer;
  project?: string;
  agent?: string;
  active?: boolean;
  resolved?: boolean;
  for?: string;
}

export function runListInstructions(options: ListInstructionsOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const inferredProject = options.project ?? inferProjectFromTarget(options.for, config);
  const resolvedAgent = options.resolved ? resolveAgentScope(options.agent) : options.agent;
  const source = options.resolved
    ? resolveInstructions(loadInstructions(), { project: inferredProject, agent: resolvedAgent })
    : loadInstructions();

  let entries = source;
  if (options.active) {
    entries = entries.filter((entry) => entry.active);
  }
  if (options.layer) {
    entries = entries.filter((entry) => entry.layer === options.layer);
  }
  if (inferredProject) {
    entries = entries.filter((entry) => entry.layer !== 'project' || entry.scope === inferredProject);
  }
  if (options.agent) {
    entries = entries.filter((entry) => entry.layer !== 'agent' || entry.scope === options.agent);
  }

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No instructions found.');
    return;
  }

  console.log(`${entries.length} instruction(s):`);
  console.log('');
  for (const entry of entries) {
    const scope = entry.scope ? `:${entry.scope}` : '';
    const flags: string[] = [entry.layer];
    if (!entry.active) flags.push('inactive');
    if (entry.supersedes) flags.push(`supersedes ${entry.supersedes}`);
    const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
    console.log(`  [${entry.id}] <${entry.layer}${scope}> ${entry.text} (${flags.join(' · ')})${tags}`);
  }
}