import type { Command } from 'commander';
import { runCodeMap } from '../commands/code-map.js';

export function registerCodeMapCommands(program: Command): void {
  // --- code-map ---
  program
    .command('code-map <subcommand> [args...]')
    .description('Query the per-project Code Map (status, refresh, find, brief, outline)')
    .option('--json', 'Output as JSON')
    .option('--all', 'For refresh: enumerate all supported files (full refresh)')
    .option('--changed', 'For refresh: only changed files (default)')
    .option('--cascade', 'For refresh/status in a multi-project workspace: cascade across every nested project (each gets its own store; the root store is scoped to files no child owns)')
    .option('--limit <n>', 'Max results for find/brief/outline', (v) => parseInt(v, 10))
    .action((subcommand, args, options) => {
      void runCodeMap(subcommand, args, options).catch((err: unknown) => {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });
}
