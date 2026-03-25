import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { scanText } from '../core/security.js';
import { validateCliInput } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import { listTools, createTool } from '../core/registries.js';

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
  const tools = listTools(cwd);

  if (tools.length === 0) {
    console.log('No tools registered yet.');
    return;
  }

  console.log(`\n${tools.length} tool(s):\n`);
  tools.forEach((tool) => {
    console.log(`  [${tool.id}] ${tool.name}`);
    console.log(`      type: ${tool.type}`);
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

  const tool = createTool({
    name,
    description,
    type: options.type,
    tags: options.tag,
    author: options.author ?? resolveCurrentAgentName(cwd),
  }, cwd);

  console.log(`✔ Tool added: [${tool.id}] ${name} (${tool.type})`);
}

function runToolDescribe(toolId: string, cwd: string): void {
  const tools = listTools(cwd);
  const tool = tools.find((t) => t.id === toolId || t.id.startsWith(toolId));

  if (!tool) {
    console.error(`Error: tool '${toolId}' not found`);
    process.exit(1);
  }

  console.log(`\nTool: ${tool.name}`);
  console.log(`Description: ${tool.description}`);
  console.log(`ID: ${tool.id}`);
  console.log(`Type: ${tool.type}`);
  console.log(`Author: ${tool.author}`);
  console.log(`Created: ${tool.created_at}`);
  if (tool.tags.length > 0) {
    console.log(`Tags: ${tool.tags.join(', ')}`);
  }
  console.log('');
}

function runToolSearch(query: string, cwd: string): void {
  const tools = listTools(cwd);
  const queryLower = query.toLowerCase();

  const results = tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(queryLower) ||
      tool.description.toLowerCase().includes(queryLower) ||
      tool.tags.some((tag) => tag.toLowerCase().includes(queryLower)),
  );

  if (results.length === 0) {
    console.log(`No tools found matching '${query}'`);
    return;
  }

  console.log(`\n${results.length} tool(s) matching '${query}':\n`);
  results.forEach((tool) => {
    console.log(`  [${tool.id}] ${tool.name} (${tool.type})`);
  });
  console.log('');
}
