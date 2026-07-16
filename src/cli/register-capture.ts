import type { Command } from 'commander';
import { runDecision } from '../commands/decision.js';
import { runConstraint } from '../commands/constraint.js';
import { runTrap } from '../commands/trap.js';
import { runHandoff } from '../commands/handoff.js';
import { runUpdateHandoff } from '../commands/update-handoff.js';
import { runReflect } from '../commands/reflect.js';
import { runReflectRuntimeNote } from '../commands/reflect-runtime-note.js';
import { runInstruction } from '../commands/instruction.js';
import { runListInstructions } from '../commands/list-instructions.js';
import { runRuntimeNote } from '../commands/runtime-note.js';
import { runRuntimeStatus } from '../commands/runtime-status.js';
import { collect } from './shared.js';

export function registerCaptureCommands(program: Command): void {
  // --- decision ---
  program
    .command('decision <text>')
    .description('Add a recent decision')
    .option('--outcome <outcome>', 'Outcome: approved, rejected, deferred, pending')
    .option('--tag <tags...>', 'Tags for this decision')
    .option('--path <paths...>', 'Related file paths')
    .option('--author <author>', 'Author name')
    .option('--plan <id>', 'Optional linked plan item ID')
    .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
    .action((text, options) => {
      runDecision(text, options);
    });

  // --- constraint ---
  program
    .command('constraint <text>')
    .description('Add an active constraint')
    .option('--category <category>', 'Category: architecture, performance, security, reliability, compatibility, process, other')
    .option('--tag <tags...>', 'Tags for this constraint')
    .option('--path <paths...>', 'Related file paths')
    .option('--author <author>', 'Author name')
    .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
    .action((text, options) => {
      runConstraint(text, options);
    });

  // --- trap ---
  program
    .command('trap <text>')
    .description('Add a known trap')
    .option('--status <status>', 'Status: active, resolved, expired', 'active')
    .option('--severity <severity>', 'Severity: low, medium, high', 'medium')
    .option('--visibility <visibility>', 'Visibility: shared, machine, private', 'shared')
    .option('--host <host>', 'Optional host identifier override for machine/private traps')
    .option('--tag <tags...>', 'Tags for this trap')
    .option('--path <paths...>', 'Related file paths')
    .option('--author <author>', 'Author name')
    .option('--ttl <duration>', 'Time-to-live: 30m, 2h, 7d (trap auto-expires after this duration)')
    .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
    .action((text, options) => {
      runTrap(text, options);
    });

  // --- handoff ---
  program
    .command('handoff <text>')
    .description('Create a handoff')
    .requiredOption('--from <from>', 'Source of the handoff')
    .requiredOption('--to <to>', 'Destination of the handoff')
    .option('--tag <tags...>', 'Tags for this handoff')
    .option('--path <paths...>', 'Related file paths')
    .option('--project <project>', 'Optional project namespace')
    .option('--plan <id>', 'Optional linked plan item ID')
    .option('--author <author>', 'Author name')
    .option('--capture-diff', 'Capture current git diff into the handoff snapshot')
    .option('--files <files...>', 'Files touched in this handoff')
    .option('--pre-condition <conditions...>', 'Pre-conditions for the receiving agent')
    .option('--post-condition <conditions...>', 'Post-conditions the receiving agent must satisfy')
    .option('--test <tests...>', 'Tests the receiving agent should verify')
    .option('--linked-plan <plans...>', 'Linked plan IDs')
    .action((text, options) => {
      runHandoff(text, options);
    });

  // --- update-handoff ---
  program
    .command('update-handoff <id>')
    .description('Update the status, recipient, or review state of a handoff')
    .option('--status <status>', 'Status: open, accepted, closed')
    .option('--to <agent>', 'Change the receiving agent')
    .option('--narrative <text>', 'Update the narrative attached to the handoff')
    .option('--reviewer <agent>', 'Set or override the assigned reviewer')
    .option('--review-verdict <verdict>', 'Set review verdict: approve or request_changes')
    .option('--reviewed-by <agent>', 'Set the reviewer identity that produced the verdict')
    .option('--review-summary <text>', 'Attach a short review summary')
    .option('--blocking-issue <text>', 'Add a blocking review issue (repeatable)', collect, [])
    .option('--suggestion <text>', 'Add a non-blocking review suggestion (repeatable)', collect, [])
    .action((id, options) => {
      runUpdateHandoff(id, {
        ...options,
        review_verdict: options.reviewVerdict,
        reviewed_by: options.reviewedBy,
        review_summary: options.reviewSummary,
        blocking_issues: options.blockingIssue,
        suggestions: options.suggestion,
      });
    });

  // --- reflect ---
  program
    .command('reflect [text]')
    .description('Create a memory candidate for review')
    .option('--type <type>', 'Type: constraint, decision, trap, handoff')
    .option('--batch <file>', 'Import runtime events from JSON file')
    .option('--session <id>', 'Import runtime events by session id from .brainclaw/runtime/')
    .option('--tag <tags...>', 'Tags')
    .option('--author <author>', 'Author name')
    .option('--source <source>', 'Source context (e.g. agent name)')
    .option('--severity <severity>', 'Severity for traps: low, medium, high')
    .option('--from <from>', 'Handoff source')
    .option('--to <to>', 'Handoff destination')
    .option('--path <paths...>', 'Related file paths')
    .action((text, options) => {
      runReflect(text, options);
    });

  // --- reflect-runtime-note ---
  program
    .command('reflect-runtime-note <id> [text]')
    .description('Turn a visible runtime note into a shared review candidate')
    .option('--type <type>', 'Type: constraint, decision, trap, handoff')
    .option('--host <host>', 'Look up machine-local runtime note for a specific host')
    .option('--all-hosts', 'Look up runtime notes across all hosts')
    .option('--suggest', 'Show candidate type suggestions before or instead of creation')
    .option('--json', 'Output suggestions as JSON when used with --suggest or without --type')
    .option('--tag <tags...>', 'Additional tags to merge with the runtime note tags')
    .option('--author <author>', 'Author name for the candidate')
    .option('--source <source>', 'Source context for the candidate')
    .option('--severity <severity>', 'Severity for traps: low, medium, high')
    .option('--from <from>', 'Handoff source')
    .option('--to <to>', 'Handoff destination')
    .option('--path <paths...>', 'Related file paths')
    .action((id, text, options) => {
      runReflectRuntimeNote(id, text, options);
    });

  // --- instruction ---
  program
    .command('instruction <text>')
    .description('Add a layered shared instruction')
    .option('--layer <layer>', 'Instruction layer: global, project, agent', 'global')
    .option('--project <project>', 'Project namespace when --layer project is used')
    .option('--agent <agent>', 'Agent name when --layer agent is used')
    .option('--tag <tags...>', 'Tags for this instruction')
    .option('--author <author>', 'Author name')
    .option('--supersedes <id>', 'Supersede an older instruction entry')
    .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
    .action((text, options) => {
      runInstruction(text, options);
    });

  // --- list-instructions ---
  program
    .command('list-instructions')
    .description('List raw or resolved shared instructions')
    .option('--json', 'Output as JSON')
    .option('--layer <layer>', 'Filter by layer: global, project, agent')
    .option('--project <project>', 'Project namespace filter')
    .option('--agent <agent>', 'Agent name filter')
    .option('--active', 'Only show active entries')
    .option('--resolved', 'Resolve effective instructions for the given scope')
    .option('--for <target>', 'Infer project namespace from target path when strategy=folder')
    .action((options) => {
      runListInstructions(options);
    });

  // --- runtime-note ---
  program
    .command('runtime-note <text>')
    .description('Add a runtime note for an agent')
    .option('--agent <agent>', 'Agent name; defaults to the configured current agent')
    .option('--project <project>', 'Optional project namespace')
    .option('--plan <id>', 'Optional linked plan item ID')
    .option('--visibility <visibility>', 'Visibility: shared, machine, private', 'shared')
    .option('--host <host>', 'Optional host identifier override for machine/private runtime notes')
    .option('--tag <tags...>', 'Tags')
    .option('--ttl <duration>', 'Time-to-live: 30m, 2h, 7d (note auto-expires after this duration)')
    .option('--auto-reflect', 'Attempt to turn this runtime note into durable memory immediately')
    .action((text, options) => {
      runRuntimeNote(text, { ...options, autoReflect: options.autoReflect });
    });

  // --- note create ---
  const noteCommand = program
    .command('note')
    .description('Manage runtime notes');

  noteCommand
    .command('create <text>')
    .description('Alias for runtime-note')
    .option('--agent <agent>', 'Agent name; defaults to the configured current agent')
    .option('--project <project>', 'Optional project namespace')
    .option('--plan <id>', 'Optional linked plan item ID')
    .option('--visibility <visibility>', 'Visibility: shared, machine, private', 'shared')
    .option('--host <host>', 'Optional host identifier override for machine/private runtime notes')
    .option('--tag <tags...>', 'Tags')
    .option('--ttl <duration>', 'Time-to-live: 30m, 2h, 7d (note auto-expires after this duration)')
    .option('--auto-reflect', 'Attempt to turn this runtime note into durable memory immediately')
    .action((text, options) => {
      runRuntimeNote(text, { ...options, autoReflect: options.autoReflect });
    });

  // --- runtime-status ---
  program
    .command('runtime-status')
    .description('Show runtime notes')
    .option('--agent <agent>', 'Filter by agent')
    .option('--plan <id>', 'Filter by linked plan item')
    .option('--visibility <visibility>', 'Visibility filter: shared, machine, private, all')
    .option('--host <host>', 'Include machine-local notes for a specific host')
    .option('--all-hosts', 'Include machine-local notes from all hosts')
    .option('--json', 'Output as JSON')
    .action((options) => {
      runRuntimeStatus(options);
    });
}
