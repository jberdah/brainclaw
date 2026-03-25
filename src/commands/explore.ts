import { memoryExists } from '../core/io.js';
import { listCapabilities, listTools } from '../core/registries.js';

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

  const capabilities = listCapabilities(cwd);
  const tools = listTools(cwd);

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║          Project Capabilities & Tools                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  console.log(`📦 Capabilities (${capabilities.length}):\n`);
  if (capabilities.length === 0) {
    console.log('   No capabilities registered yet.\n');
  } else {
    capabilities.forEach((cap) => {
      console.log(`   [${cap.id}] ${cap.name}`);
      console.log(`       Category: ${cap.category}\n`);
    });
  }

  console.log(`🔧 Tools (${tools.length}):\n`);
  if (tools.length === 0) {
    console.log('   No tools registered yet.\n');
  } else {
    tools.forEach((tool) => {
      console.log(`   [${tool.id}] ${tool.name}`);
      console.log(`       Type: ${tool.type}\n`);
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
