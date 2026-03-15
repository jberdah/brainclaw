import { loadState } from '../core/state.js';
import { generateMarkdown } from '../core/markdown.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';

export function runRebuild(): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState();
  const md = generateMarkdown(state);
  writeFileAtomic(memoryPath('project.md'), md);

  console.log('✔ project.md rebuilt from canonical memory state');
}
