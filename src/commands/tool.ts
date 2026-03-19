import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateMarkdown } from '../core/markdown.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { ProjectTool } from '../core/schema.js';

export interface ToolOptions {
  tag?: string[];
  type?: string;
  author?: string;
  cwd?: string;
  store?: StoreTarget;
}

export function runTool(subcommand: string, args: string[], options: ToolOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (subcommand === 'list') {
    runToolList(cwd);
  } else if (subcommand === 'add') {
    const name = args[0];
    const description = args[1];
    if (!name || !description) {
      console.error('Error: tool add requires <name> <description>');
      process.exit(1);
    }
    runToolAdd(name, description, options, cwd);
  } else if (subcommand === 'describe') {
    const toolId = args[0];
    if (!toolId) {
      console.error('Error: tool describe requires <id>');
      process.exit(1);
    }
    runToolDescribe(toolId, cwd);
  } else if (subcommand === 'search') {
    const query = args[0];
    if (!query) {
      console.error('Error: tool search requires <query>');
      process.exit(1);
    }
    runToolSearch(query, cwd);
  } else {
    console.error(`Unknown tool subcommand: ${subcommand}`);
    process.exit(1);
  }
}

function runToolList(cwd: string): void {
  const state = loadState(cwd);
  const tools = state.recent_decisions
    .filter((d) => d.tags.includes('tool'))
    .map((d) => ({ id: d.id, name: d.text.split('\n')[0], type: d.tags.find((t) => t !== 'tool') }));

  if (tools.length === 0) {
    console.log('No tools registered yet.');
    return;
  }

  console.log(`\n${tools.length} tool(s):\n`);
  tools.forEach((tool) => {
    console.log(`  [${tool.id}] ${tool.name}`);
    if (tool.type) {
      console.log(`      type: ${tool.type}`);
    }
  });
  console.log('');
}

function runToolAdd(name: string, description: string, options: ToolOptions, cwd: string): void {
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

  const state = loadState(cwd);
  const { id, short_label } = generateIdWithLabel('recent_decisions');

  const toolType = options.type ?? 'utility';
  const entry: any = {
    id,
    short_label,
    text: name,
    created_at: nowISO(),
    author: options.author ?? resolveCurrentAgentName(cwd),
    tags: ['tool', toolType, ...(options.tag ?? [])],
  };

  // For now, store as decision to avoid schema migration
  // Will migrate to separate tool storage in v0.16
  state.recent_decisions.push(entry);
  saveState(state, cwd);
  writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state));

  console.log(`✔ Tool added: [${id}] ${name}`);
  console.log('  (Stored in decisions for now; will move to dedicated registry in v0.16)');
}

function runToolDescribe(toolId: string, cwd: string): void {
  const state = loadState(cwd);
  const decision = state.recent_decisions.find((d) => d.id === toolId || d.short_label === toolId);

  if (!decision) {
    console.error(`Error: tool '${toolId}' not found`);
    process.exit(1);
  }

  console.log(`\nTool: ${decision.text}`);
  console.log(`ID: ${decision.id}`);
  console.log(`Type: ${decision.tags.find((t) => t !== 'tool')}`);
  console.log(`Author: ${decision.author}`);
  console.log(`Created: ${decision.created_at}`);
  console.log('');
}

function runToolSearch(query: string, cwd: string): void {
  const state = loadState(cwd);
  const tools = state.recent_decisions.filter((d) => d.tags.includes('tool'));

  const results = tools.filter(
    (tool) =>
      tool.text.toLowerCase().includes(query.toLowerCase()) ||
      tool.tags.some((tag) => tag.toLowerCase().includes(query.toLowerCase())),
  );

  if (results.length === 0) {
    console.log(`No tools found matching '${query}'`);
    return;
  }

  console.log(`\n${results.length} tool(s) matching '${query}':\n`);
  results.forEach((result) => {
    console.log(`  [${result.id}] ${result.text.split('\n')[0]}`);
  });
  console.log('');
}
