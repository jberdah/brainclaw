import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';

export interface ExploreOptions {
  cwd?: string;
  query?: string;
}

export function runExplore(options: ExploreOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState(cwd);
  const capabilities = state.recent_decisions.filter((d) => d.tags.includes('capability'));
  const tools = state.recent_decisions.filter((d) => d.tags.includes('tool'));

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║          Project Capabilities & Tools                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log(`📦 Capabilities (${capabilities.length}):\n`);
  if (capabilities.length === 0) {
    console.log('   No capabilities registered yet.\n');
  } else {
    capabilities.forEach((cap) => {
      const category = cap.tags.find((t) => t !== 'capability') || 'general';
      console.log(`   [${cap.id}] ${cap.text.split('\n')[0]}`);
      console.log(`       Category: ${category}\n`);
    });
  }

  console.log(`🔧 Tools (${tools.length}):\n`);
  if (tools.length === 0) {
    console.log('   No tools registered yet.\n');
  } else {
    tools.forEach((tool) => {
      const type = tool.tags.find((t) => t !== 'tool') || 'utility';
      console.log(`   [${tool.id}] ${tool.text.split('\n')[0]}`);
      console.log(`       Type: ${type}\n`);
    });
  }

  if (capabilities.length === 0 && tools.length === 0) {
    console.log('💡 Tip: Register your first capability or tool with:');
    console.log('   brainclaw capability add <name> <description>');
    console.log('   brainclaw tool add <name> <description>\n');
  } else {
    console.log('💡 Tip: Use `brainclaw capability describe <id>` or `brainclaw tool describe <id>` for details');
    console.log('   Use `brainclaw tool search <query>` to find tools\n');
  }
}
