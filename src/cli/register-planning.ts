import type { Command } from 'commander';
import { runPlanResource } from '../commands/plan-resource.js';
import { runMove } from '../commands/move.js';
import { runListPlans } from '../commands/list-plans.js';
import { runSequenceResource } from '../commands/sequence.js';
import { runAddStep } from '../commands/add-step.js';
import { runCompleteStep } from '../commands/complete-step.js';
import { runUpdateStep } from '../commands/update-step.js';
import { runDeleteStep } from '../commands/delete-step.js';
import { runEstimationReport } from '../commands/estimation-report.js';
import { runUpdatePlan } from '../commands/update-plan.js';
import { runSurfaceTaskResource } from '../commands/surface-task-resource.js';
import { runDeletePlan } from '../commands/delete-plan.js';

export function registerPlanningCommands(program: Command): void {
  // --- plan ---
  program
    .command('plan <subcommand> [args...]')
    .description('Manage shared plan items (create, list, update, delete)')
    .option('--json', 'Output as JSON for list')
    .option('--all', 'Include done and dropped plan items in list')
    .option('--type <type>', 'Plan type or filter: feat, fix, chore, spike, doc')
    .option('--status <status>', 'Status filter/update: todo, in_progress, blocked, done, dropped')
    .option('--priority <priority>', 'Priority: low, medium, high', 'medium')
    .option('--assignee <assignee>', 'Assignee for this plan item')
    .option('--project <project>', 'Optional project namespace')
    .option('--tag <tags...>', 'Tags for this plan item')
    .option('--path <paths...>', 'Related file paths')
    .option('--depends-on <ids...>', 'Dependency IDs for this plan item')
    .option('--author <author>', 'Author name')
    .option('--estimate <minutes>', 'Estimated effort in minutes (positive integer, e.g. --estimate 30)')
    .option('--actual-effort <effort>', 'Actual effort spent (e.g. "20min", "1h30m")')
    .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
    .option('--recursive', 'Include plans from descendant brainclaw projects (for list)')
    .option('--local-only', 'Read from local store only for list (skip parent stores in chain)')
    .action((subcommand, args, options) => {
      runPlanResource(subcommand, args, { ...options, actualEffort: options.actualEffort, localOnly: options.localOnly });
    });

  // --- move (cross-project relocation, pln#595) ---
  program
    .command('move <entity> <id>')
    .description('Relocate a brainclaw item to another project, id-preserving (multi-project workspaces). Relocatable: plan, decision, constraint, trap, handoff, sequence.')
    .requiredOption('--to <project>', 'Target project (name, path, or basename)')
    .option('--from <project>', 'Source project (defaults to the current project)')
    .option('--force', 'Move even if an active claim references the item')
    .option('--json', 'Output as JSON')
    .action((entity, id, options) => runMove(entity, id, options));

  // --- list-plans ---
  program
    .command('list-plans')
    .description('List shared plan items')
    .option('--json', 'Output as JSON')
    .option('--status <status>', 'Status: todo, in_progress, blocked, done, dropped')
    .option('--type <type>', 'Filter by type: feat, fix, chore, spike, doc')
    .option('--assignee <assignee>', 'Filter by assignee')
    .option('--project <project>', 'Filter by project namespace')
    .option('--all', 'Include done and dropped plan items')
    .option('--recursive', 'Include plans from descendant brainclaw projects')
    .option('--local-only', 'Read from local store only (skip parent stores in chain)')
    .action((options) => {
      runListPlans({ ...options, localOnly: options.localOnly });
    });

  program
    .command('sequence <subcommand> [args...]')
    .description('Manage coordination sequences (create, list, show, update)')
    .option('--json', 'Output as JSON')
    .option('--description <text>', 'Optional sequence description')
    .option('--status <status>', 'Sequence status: draft, active, archived')
    .option('--owner <owner>', 'Optional sequence owner')
    .option('--items <json>', 'Sequence items JSON array')
    .option('--name <name>', 'Optional sequence name for update')
    .option('--tag <tags...>', 'Tags for this sequence')
    .option('--author <author>', 'Author name')
    .action((subcommand, args, options) => {
      runSequenceResource(subcommand, args, options);
    });

  // --- add-step ---
  program
    .command('add-step <planId> <text>')
    .description('Add an optional step to a plan item')
    .option('--assign <assignee>', 'Assign this step to an agent or person')
    .option('--estimate <minutes>', 'Step-level estimate (minutes, or a duration like "2h"/"30m")')
    .option('--actual-effort <effort>', 'Step-level actual effort (e.g. "45m", "2h")')
    .action((planId, text, options) => {
      runAddStep(planId, text, { assignee: options.assign, estimatedEffort: options.estimate, actualEffort: options.actualEffort });
    });

  // --- complete-step ---
  program
    .command('complete-step <planId> <stepId>')
    .description('Mark a plan step as done')
    .action((planId, stepId) => {
      runCompleteStep(planId, stepId);
    });

  // --- update-step ---
  program
    .command('update-step <planId> <stepId>')
    .description('Update a plan step (status, text, assignee, effort)')
    .option('--status <status>', 'New status: todo, in_progress, testing, done, blocked')
    .option('--text <text>', 'Replace step description')
    .option('--assign <assignee>', 'Assign the step (empty string to unassign)')
    .option('--estimate <minutes>', 'Step-level estimate (minutes, or a duration like "2h"/"30m")')
    .option('--actual-effort <effort>', 'Step-level actual effort (e.g. "45m", "2h")')
    .action((planId, stepId, options) => {
      runUpdateStep(planId, stepId, options);
    });

  // --- delete-step ---
  program
    .command('delete-step <planId> <stepId>')
    .description('Remove a step from a plan')
    .action((planId, stepId) => {
      runDeleteStep(planId, stepId);
    });

  // --- estimation-report ---
  program
    .command('estimation-report')
    .description('Show estimation accuracy report for completed plans')
    .option('--agent <name>', 'Filter by agent/author name')
    .option('--json', 'Output as JSON')
    .option('--outlier-threshold <minutes>', 'Drop plan-wallclock actuals over N minutes from the stats (default 1440 = 24h; 0 disables)')
    .action((options) => {
      runEstimationReport({
        agent: options.agent,
        json: options.json,
        outlierThresholdMinutes: options.outlierThreshold !== undefined ? Number(options.outlierThreshold) : undefined,
      });
    });

  // --- update-plan ---
    program
      .command('update-plan <id>')
    .description('Update a shared plan item')
    .option('--status <status>', 'Status: todo, in_progress, blocked, done, dropped')
    .option('--assignee <assignee>', 'Assign a user or agent to this plan item')
    .option('--project <project>', 'Set or change project namespace')
    .option('--priority <priority>', 'Priority: low, medium, high')
    .option('--actual-effort <effort>', 'Actual effort spent (e.g. "20min", "1h30m")')
      .action((id, options) => {
        runUpdatePlan(id, { ...options, actualEffort: options.actualEffort });
      });

    // --- surface-task ---
    program
      .command('surface-task <subcommand> [args...]')
      .description('Manage queued tasks for desktop AI surfaces such as ChatGPT Desktop or Claude Desktop')
      .option('--json', 'Output as JSON for list')
      .option('--all', 'Include completed, cancelled, and failed tasks in list')
      .option('--status <status>', 'Status filter/update: queued, in_progress, completed, cancelled, failed')
      .option('--target <surface>', 'Target surface, e.g. chatgpt, claude, gemini')
      .option('--kind <kind>', 'Task kind: visual_asset, draft, summary, analysis, research, custom')
      .option('--instructions <text>', 'Detailed instructions for the target surface')
      .option('--output <paths...>', 'Expected output paths')
      .option('--result <text>', 'Optional result note when updating a task')
      .option('--tag <tags...>', 'Tags for this task')
      .option('--path <paths...>', 'Related file paths')
      .option('--agent <agent>', 'Author agent name')
      .option('--agent-id <agentId>', 'Author agent id')
      .action((subcommand, args, options) => {
        runSurfaceTaskResource(subcommand, args, {
          ...options,
          agentId: options.agentId,
        });
      });

  // --- delete-plan ---
  program
    .command('delete-plan <id>')
    .description('Delete a shared plan item')
    .action((id) => {
      runDeletePlan(id);
    });
}
