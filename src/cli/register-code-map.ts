import type { Command } from 'commander';
import { runCodeMap } from '../commands/code-map.js';

export function registerCodeMapCommands(program: Command): void {
  // --- code-map ---
  program
    .command('code-map <subcommand> [args...]')
    .description('Query the per-project Code Map (status, refresh, find, brief, impact, export, outline)')
    .option('--json', 'Output as JSON')
    .option('--all', 'For refresh: enumerate all supported files (full refresh)')
    .option('--changed', 'For refresh: only changed files (default)')
    .option('--scope <scope>', 'For refresh: changed or all (same selector as MCP)')
    .option('--cascade', 'For refresh/status in a multi-project workspace: cascade across every nested project (each gets its own store; the root store is scoped to files no child owns)')
    .option('--limit <n>', 'Max results for find/brief/impact/outline', (v) => parseInt(v, 10))
    .option('--depth <n>', 'For impact/export: maximum graph depth (export is hard-capped at 4)', (v) => parseInt(v, 10))
    .option('--direction <direction>', 'For export: outgoing, incoming, or both')
    .option('--format <format>', 'For export: json (default) or mermaid')
    .option('--max-nodes <n>', 'For export: maximum nodes (hard-capped at 100)', (v) => parseInt(v, 10))
    .option('--max-edges <n>', 'For export: maximum edges (hard-capped at 200)', (v) => parseInt(v, 10))
    .option('--min-confidence <n>', 'For export: persisted confidence floor (minimum 0.5)', (v) => parseFloat(v))
    .option('--target-kind <kind>', 'For export: symbol or file (auto-detected by default)')
    .action((subcommand, args, options) => {
      void runCodeMap(subcommand, args, options).catch((err: unknown) => {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    });
}
