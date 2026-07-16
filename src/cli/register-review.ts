import type { Command } from 'commander';
import { runReview } from '../commands/review.js';
import { runShowCandidate } from '../commands/show-candidate.js';
import { runStarCandidate } from '../commands/star-candidate.js';
import { runUseCandidate } from '../commands/use-candidate.js';
import { runAccept } from '../commands/accept.js';
import { runAdapterOpenclawImport } from '../commands/adapter-openclaw-import.js';
import { runReject } from '../commands/reject.js';
import { runHarvestCandidates, runHarvestLane } from '../commands/harvest.js';
import { runPruneCandidates } from '../commands/prune-candidates.js';
import { cleanupStaleCandidates } from '../core/candidates.js';
import { memoryExists } from '../core/io.js';
import { collect } from './shared.js';

export function registerReviewCommands(program: Command): void {
  // --- review ---
  program
    .command('review')
    .description('List pending memory candidates')
    .option('--json', 'Output as JSON')
    .option('--type <type>', 'Filter by type')
    .option('--prioritized', 'Sort by review priority and show SLA')
    .option('--only-overdue', 'Show only candidates overdue review SLA')
    .option('--assignee <assignee>', 'Filter by assignee tag (assignee:<name>)')
    .option('--for-curator <curator>', 'Shortcut assignee filter for curator queue')
    .option('--take <count>', 'Limit number of reviewed items', parseInt)
    .option('--claim <curator>', 'Atomically assign selected candidates to a curator')
    .option('--auto', 'Auto-promote candidates meeting the configured score threshold')
    .option('--auto-by <actor>', 'Actor identity for auto-promotion (defaults to current user)')
    .action((options) => {
      runReview({ ...options, autoBy: options.autoBy });
    });

  // --- show-candidate ---
  program
    .command('show-candidate <id>')
    .description('Show details of a memory candidate')
    .option('--related', 'Show related candidates by shared tags/paths')
    .action((id, options) => {
      runShowCandidate(id, { related: options.related });
    });

  // --- star-candidate ---
  program
    .command('star-candidate <id>')
    .description('Add an adoption star to a pending candidate')
    .option('--by <actor>', 'Agent or person adding the star')
    .action((id, options) => {
      runStarCandidate(id, options);
    });

  // --- use-candidate ---
  program
    .command('use-candidate <id>')
    .description('Record that a pending candidate was reused in a concrete work context')
    .option('--by <actor>', 'Agent or person using the candidate')
    .requiredOption('--context <context>', 'Work context where the candidate was reused')
    .action((id, options) => {
      runUseCandidate(id, options);
    });

  // --- accept ---
  program
    .command('accept <id>')
    .description('Accept a candidate into canonical memory')
    .option('--by <reviewer>', 'Reviewer identity used for governance checks')
    .action((id, options) => {
      runAccept(id, options.by);
    });

  // --- adapter-openclaw-import ---
  program
    .command('adapter-openclaw-import [file]')
    .description('Import OpenClaw runtime events file as memory candidates')
    .option('--session <id>', 'Import runtime events from a session id in .brainclaw/runtime/')
    .option('--dry-run', 'Preview import without creating candidates')
    .option('--source <source>', 'Source label for imported candidates', 'openclaw')
    .option('--author <author>', 'Author for imported candidates')
    .action((file, options) => {
      runAdapterOpenclawImport(file, options);
    });

  // --- reject ---
  program
    .command('reject <id>')
    .description('Reject a memory candidate')
    .option('--by <reviewer>', 'Reviewer identity used for rejection attribution')
    .option('--reason <reason>', 'Reason for rejection')
    .action((id, options) => {
      runReject(id, options.reason, options.by);
    });

  // --- harvest-candidates ---
  program
    .command('harvest-candidates')
    .description('Harvest candidates from worktree inboxes into the main project store (codex sandbox bridge)')
    .option('--dry-run', 'Preview what would be imported without writing anything')
    .option('--worktree <path>', 'Explicit worktree path to scan (repeatable)', collect, [])
    .option('--json', 'Output as JSON')
    .action((options) => {
      const globalOpts = program.opts();
      runHarvestCandidates({ ...options, cwd: globalOpts.cwd });
    });

  // --- harvest (lane results, pln#526) ---
  program
    .command('harvest [assignment_id]')
    .description('Harvest a worker LANE-RESULT.json from its worktree into the project (pass an assignment id, or --all)')
    .option('--all', 'Harvest every lane result found across worktrees')
    .option('--integrate', 'Worktree-as-contract (pln#534): commit the worktree diff on behalf of a sandboxed worker, lifecycle the assignment, and release the claim')
    .option('--orphaned', 'Recover a dead worker that left NO lane-result (pln#554): typecheck + commit the worktree on behalf, lifecycle, release. Never deletes or resets anything')
    .option('--base <ref>', 'Base ref for --orphaned commits-ahead comparison (default: master)')
    .option('--dry-run', 'Preview without writing events/markers')
    .option('--worktree <path>', 'Explicit worktree path to scan (repeatable)', collect, [])
    .option('--json', 'Output as JSON')
    .action((assignmentId, options) => {
      const globalOpts = program.opts();
      runHarvestLane(assignmentId, { ...options, cwd: globalOpts.cwd });
    });

  // --- prune-candidates ---
  program
    .command('prune-candidates')
    .description('Remove old rejected candidates')
    .option('--days <days>', 'Max age in days', parseInt)
    .option('--dry-run', 'Preview without deleting')
    .action((options) => {
      runPruneCandidates(options);
    });

  // --- cleanup-candidates ---
  program
    .command('cleanup-candidates')
    .description('Remove stale auto-generated pending candidates')
    .option('--max-age <days>', 'Max age in days before cleanup', parseInt)
    .option('--dry-run', 'Preview without deleting')
    .action((options) => {
      if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
      }

      const maxAgeDays = options.maxAge ?? 30;
      const result = cleanupStaleCandidates({
        maxAgeDays,
        dryRun: options.dryRun,
      });

      if (result.matched === 0) {
        console.log(`No stale auto-generated candidates older than ${maxAgeDays} days found.`);
        return;
      }

      if (options.dryRun) {
        console.log(`Would remove ${result.matched} stale auto-generated candidate(s):`);
        for (const candidate of result.candidates) {
          console.log(`  [${candidate.id}] ${candidate.text}`);
        }
        return;
      }

      console.log(`✔ Removed ${result.deleted} stale auto-generated candidate(s) older than ${maxAgeDays} days.`);
    });
}
