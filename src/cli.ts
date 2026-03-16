#!/usr/bin/env node

import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runDecision } from './commands/decision.js';
import { runConstraint } from './commands/constraint.js';
import { runTrap } from './commands/trap.js';
import { runHandoff } from './commands/handoff.js';
import { runPlan } from './commands/plan.js';
import { runListPlans } from './commands/list-plans.js';
import { runUpdatePlan } from './commands/update-plan.js';
import { runAddStep } from './commands/add-step.js';
import { runEstimationReport } from './commands/estimation-report.js';
import { runCompleteStep } from './commands/complete-step.js';
import { runUpdateHandoff } from './commands/update-handoff.js';
import { runInstruction } from './commands/instruction.js';
import { runListAgents } from './commands/list-agents.js';
import { runListInstructions } from './commands/list-instructions.js';
import { runDoctor } from './commands/doctor.js';
import { runRebuild } from './commands/rebuild.js';
import { runReflect } from './commands/reflect.js';
import { runReflectRuntimeNote } from './commands/reflect-runtime-note.js';
import { runReview } from './commands/review.js';
import { runShowCandidate } from './commands/show-candidate.js';
import { runStarCandidate } from './commands/star-candidate.js';
import { runUseCandidate } from './commands/use-candidate.js';
import { runAccept } from './commands/accept.js';
import { runReject } from './commands/reject.js';
import { runPruneCandidates } from './commands/prune-candidates.js';
import { runClaim } from './commands/claim.js';
import { runListClaims } from './commands/list-claims.js';
import { runReleaseClaim } from './commands/release-claim.js';
import { runReleaseClaims } from './commands/release-claims.js';
import { runAgentBoard } from './commands/agent-board.js';
import { runRuntimeNote } from './commands/runtime-note.js';
import { runRuntimeStatus } from './commands/runtime-status.js';
import { runSync } from './commands/sync.js';
import { runContext } from './commands/context.js';
import { runBootstrap } from './commands/bootstrap.js';
import { runEnv } from './commands/env.js';
import { runAdapterOpenclawImport } from './commands/adapter-openclaw-import.js';
import { runInstallHooks } from './commands/install-hooks.js';
import { runCheckConstraints } from './commands/check-constraints.js';
import { runRegisterAgent } from './commands/register-agent.js';
import { runEnableAgent } from './commands/enable-agent.js';
import { runVersion } from './commands/version.js';
import { runDiff } from './commands/changes.js';
import { runPrune } from './commands/prune.js';
import { runMcp } from './commands/mcp.js';
import { runSetTrust } from './commands/set-trust.js';
import { runSessionStart } from './commands/session-start.js';
import { runSessionEnd } from './commands/session-end.js';
import { runWhoami } from './commands/whoami.js';
import { runSearch } from './commands/search.js';
import { runExport } from './commands/export.js';
import { runHooks } from './commands/hooks.js';
import { runWatch } from './commands/watch.js';
import { runMetrics } from './commands/metrics.js';
import { runRollback } from './commands/rollback.js';
import { runPull } from './commands/pull.js';
import { runPush } from './commands/push.js';
import { runAuditCommand } from './commands/audit.js';
import { runHistory } from './commands/history.js';
import { runContextDiff } from './commands/context-diff.js';
import { getInstalledBrainclawVersion } from './core/brainclaw-version.js';
import { cleanOrphanFiles, memoryDir } from './core/io.js';
import { initLogLevel, logger } from './core/logger.js';

const program = new Command();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name('brainclaw')
  .description('Shared project memory for humans and coding agents.')
  .version(getInstalledBrainclawVersion())
  .option('--verbose', 'Show info-level log messages on stderr')
  .option('--debug', 'Show debug-level log messages on stderr')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const root = actionCommand.optsWithGlobals();
    initLogLevel({ verbose: root.verbose, debug: root.debug });
    const removed = cleanOrphanFiles(memoryDir());
    if (removed > 0) {
      logger.info(`Cleaned ${removed} orphan lock/tmp file(s) in ${memoryDir()}`);
    }
  });

// --- init ---
program
  .command('init')
  .description('Initialize project memory in .brainclaw/ storage directory')
  .option('-y, --yes', 'Skip interactive wizard and use defaults')
  .option('--force', 'Overwrite existing project memory directory')
  .option('--compact', 'Enable compact markdown mode')
  .option('--topology <mode>', 'Topology mode: embedded, sidecar, local-only')
  .option('--project-mode <mode>', 'Project mode: single-project, multi-project, auto')
  .option('--project-strategy <strategy>', 'Project strategy for multi-project mode: manual, folder')
  .option('--no-analyze-repo', 'Skip repository analysis when suggesting a project mode')
  .action(async (options) => {
    await runInit(options);
  });

// --- decision ---
program
  .command('decision <text>')
  .description('Add a recent decision')
  .option('--tag <tags...>', 'Tags for this decision')
  .option('--path <paths...>', 'Related file paths')
  .option('--author <author>', 'Author name')
  .action((text, options) => {
    runDecision(text, options);
  });

// --- constraint ---
program
  .command('constraint <text>')
  .description('Add an active constraint')
  .option('--tag <tags...>', 'Tags for this constraint')
  .option('--path <paths...>', 'Related file paths')
  .option('--author <author>', 'Author name')
  .action((text, options) => {
    runConstraint(text, options);
  });

// --- trap ---
program
  .command('trap <text>')
  .description('Add a known trap')
  .option('--severity <severity>', 'Severity: low, medium, high', 'medium')
  .option('--visibility <visibility>', 'Visibility: shared, machine, private', 'shared')
  .option('--host <host>', 'Optional host identifier override for machine/private traps')
  .option('--tag <tags...>', 'Tags for this trap')
  .option('--path <paths...>', 'Related file paths')
  .option('--author <author>', 'Author name')
  .option('--ttl <duration>', 'Time-to-live: 30m, 2h, 7d (trap auto-expires after this duration)')
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
  .action((text, options) => {
    runHandoff(text, options);
  });

// --- status ---
program
  .command('status')
  .description('Show project memory status')
  .option('--json', 'Output as JSON')
  .option('--markdown', 'Output as Markdown')
  .action((options) => {
    runStatus(options);
  });

// --- plan ---
program
  .command('plan <text>')
  .description('Add a shared plan item')
  .option('--priority <priority>', 'Priority: low, medium, high', 'medium')
  .option('--assignee <assignee>', 'Assignee for this plan item')
  .option('--project <project>', 'Optional project namespace')
  .option('--tag <tags...>', 'Tags for this plan item')
  .option('--path <paths...>', 'Related file paths')
  .option('--depends-on <ids...>', 'Dependency IDs for this plan item')
  .option('--author <author>', 'Author name')
  .option('--estimate <effort>', 'Estimated effort (e.g. "30min", "2h", "1d")')
  .action((text, options) => {
    runPlan(text, options);
  });

// --- list-plans ---
program
  .command('list-plans')
  .description('List shared plan items')
  .option('--json', 'Output as JSON')
  .option('--status <status>', 'Status: todo, in_progress, blocked, done, dropped')
  .option('--assignee <assignee>', 'Filter by assignee')
  .option('--project <project>', 'Filter by project namespace')
  .option('--all', 'Include done and dropped plan items')
  .action((options) => {
    runListPlans(options);
  });

// --- add-step ---
program
  .command('add-step <planId> <text>')
  .description('Add an optional step to a plan item')
  .option('--assign <assignee>', 'Assign this step to an agent or person')
  .action((planId, text, options) => {
    runAddStep(planId, text, { assignee: options.assign });
  });

// --- complete-step ---
program
  .command('complete-step <planId> <stepId>')
  .description('Mark a plan step as done')
  .action((planId, stepId) => {
    runCompleteStep(planId, stepId);
  });

// --- estimation-report ---
program
  .command('estimation-report')
  .description('Show estimation accuracy report for completed plans')
  .option('--agent <name>', 'Filter by agent/author name')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runEstimationReport(options);
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

// --- update-handoff ---
program
  .command('update-handoff <id>')
  .description('Update the status of a handoff')
  .option('--status <status>', 'Status: open, accepted, closed')
  .option('--to <agent>', 'Change the receiving agent')
  .action((id, options) => {
    runUpdateHandoff(id, options);
  });

// --- doctor ---
program
  .command('doctor')
  .description('Check memory health and security')
  .option('--json', 'Output as JSON dashboard')
  .option('--migration-check', 'Report versioned documents that need schema migration')
  .action((options) => {
    runDoctor(options);
  });

// --- version ---
program
  .command('version')
  .description('Show the installed brainclaw version and the project version policy')
  .option('--check', 'Check the configured installable update source')
  .option('--publish-local', 'Create/update the local installable .releases channel via npm pack')
  .option('--release-notes <text>', 'Attach release notes to the generated local-pack manifest')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runVersion(options);
  });

// --- rebuild ---
program
  .command('rebuild')
  .description('Rebuild project.md from canonical memory state')
  .action(() => {
    runRebuild();
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

// --- context ---
program
  .command('context')
  .description('Generate compact context for agents')
  .option('--for <target>', 'Task/path/goal to prioritize')
  .option('--project <project>', 'Explicit project namespace for layered instructions')
  .option('--agent <agent>', 'Agent name for agent-layer instructions')
  .option('--host <host>', 'Include machine-local runtime notes for a specific host')
  .option('--all-hosts', 'Include machine-local runtime notes from all hosts')
  .option('--profile <profile>', 'Profile: dev, openclaw, ops, research')
  .option('--include-pending', 'Include pending candidates')
  .option('--max-items <count>', 'Limit number of items', parseInt)
  .option('--max-chars <count>', 'Approximate output budget for selected item content', parseInt)
  .option('--digest', 'Include a short deterministic digest ahead of the detailed context')
  .option('--since-session <id>', 'Include a compact memory diff since the given session started')
  .option('--no-bootstrap', 'Disable brownfield bootstrap fallback when canonical memory is sparse')
  .option('--refresh-bootstrap', 'Refresh brownfield bootstrap profile before building context')
  .option('--template', 'Output prompt-ready context template')
  .option('--compact-template', 'Use compact template format (default for openclaw profile)')
  .option('--explain', 'Show ranking reasons in human-readable output')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runContext(options);
  });

// --- bootstrap ---
program
  .command('bootstrap')
  .description('Derive brownfield bootstrap signals from the current repository')
  .option('--for <target>', 'Target path or scope to tailor the bootstrap')
  .option('--json', 'Output as JSON')
  .option('--refresh', 'Force a fresh bootstrap scan instead of reusing the current profile')
  .action((options) => {
    runBootstrap(options);
  });

// --- env ---
program
  .command('env')
  .description('Show the local execution context and optionally detected agent tooling')
  .option('--json', 'Output as JSON')
  .option('--agent-tooling', 'Include AGENTS.md, local skills, and local MCP inventory')
  .action((options) => {
    runEnv({ ...options, agentTooling: options.agentTooling });
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

// --- register-agent ---
program
  .command('register-agent <name>')
  .description('Register an agent or human identity in project memory')
  .option('--kind <kind>', 'Identity kind: agent, human, unknown', 'unknown')
  .option('--capability <value>', 'Declare a capability on the agent profile (repeatable)', collect, [])
  .option('--replace-capabilities', 'Replace existing capabilities instead of merging')
  .option('--generate-fingerprint', 'Generate or rotate a local public identity fingerprint for this agent')
  .option('--set-current', 'Set this identity as the current agent in config')
  .option('--json', 'Output as JSON')
  .action((name, options) => {
    runRegisterAgent(name, options);
  });

// --- enable-agent ---
program
  .command('enable-agent <name>')
  .description('Activate a supported coding agent on an already initialized project')
  .option('--kind <kind>', 'Identity kind: agent, human, unknown', 'agent')
  .option('--capability <value>', 'Declare a capability on the agent profile (repeatable)', collect, [])
  .option('--replace-capabilities', 'Replace existing capabilities instead of merging')
  .option('--generate-fingerprint', 'Generate or rotate a local public identity fingerprint for this agent')
  .option('--set-current', 'Set this identity as the current agent in config')
  .option('--json', 'Output as JSON')
  .action((name, options) => {
    runEnableAgent(name, options);
  });

// --- list-agents ---
program
  .command('list-agents')
  .description('List registered agent identities')
  .option('--json', 'Output as JSON')
  .option('--with-reputation', 'Include bounded reputation summaries when available')
  .action((options) => {
    runListAgents(options);
  });

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

// --- prune-candidates ---
program
  .command('prune-candidates')
  .description('Remove old rejected candidates')
  .option('--days <days>', 'Max age in days', parseInt)
  .option('--dry-run', 'Preview without deleting')
  .action((options) => {
    runPruneCandidates(options);
  });

// --- claim ---
program
  .command('claim <description>')
  .description('Claim a work scope (advisory)')
  .option('--agent <agent>', 'Agent or person name; defaults to the configured current agent')
  .requiredOption('--scope <scope>', 'Scope being claimed (e.g. file path, module)')
  .option('--project <project>', 'Optional project namespace for this claim')
  .option('--plan <id>', 'Optional linked plan item ID')
  .option('--ttl <duration>', 'Auto-expire after duration: 30m, 2h, 8h, 1d')
  .action((description, options) => {
    runClaim(description, options);
  });

// --- list-claims ---
program
  .command('list-claims')
  .description('List work claims')
  .option('--json', 'Output as JSON')
  .option('--all', 'Include released claims')
  .option('--project <project>', 'Filter by project namespace')
  .option('--plan <id>', 'Filter by linked plan item')
  .option('--agent <agent>', 'Filter by agent name')
  .action((options) => {
    runListClaims(options);
  });

// --- release-claim ---
program
  .command('release-claim <id>')
  .description('Release a work claim')
  .option('--plan-status <status>', 'Optional linked plan status: todo, in_progress, blocked, done, dropped')
  .action((id, options) => {
    runReleaseClaim(id, options);
  });

// --- release-claims ---
program
  .command('release-claims')
  .description('Bulk-release claims whose scope overlaps with git-changed files')
  .option('--from-git-diff', 'Use ORIG_HEAD..HEAD diff to detect changed files (post-merge)')
  .option('--ref1 <ref>', 'First git ref (default: ORIG_HEAD)')
  .option('--ref2 <ref>', 'Second git ref (default: HEAD)')
  .action((options) => {
    runReleaseClaims({ fromGitDiff: options.fromGitDiff, ref1: options.ref1, ref2: options.ref2 });
  });

// --- agent-board ---
program
  .command('agent-board')
  .description('Show a coordination board for agents, plans, claims, handoffs, and instructions')
  .option('--agent <agent>', 'Filter by agent name')
  .option('--project <project>', 'Filter by project namespace')
  .option('--for <target>', 'Infer project from target path')
  .option('--host <host>', 'Include machine-local runtime notes for a specific host')
  .option('--all-hosts', 'Include machine-local runtime notes from all hosts')
  .option('--json', 'Output as JSON')
  .option('--with-reputation', 'Include bounded reputation summaries when available')
  .option('--capabilities', 'List all registered agents with their declared capabilities')
  .option('--suggest <query>', 'Suggest agents whose capabilities match a query string')
  .action((options) => {
    runAgentBoard(options);
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

// --- sync ---
program
  .command('sync')
  .description('Summarize memory changes and optionally commit')
  .option('--commit', 'Create a local git commit')
  .option('--message <message>', 'Custom commit message')
  .option('--summary-only', 'Print summary only; skip git status and commit checks')
  .option('--scope <scope>', 'Scope: all, state, config, project, inbox, archive, claims, runtime, runtime-local, trap-local')
  .option('--include-machine-runtime', 'Include machine-local runtime memory in sync scope for all')
  .option('--remote', 'Pull + push from/to remote memory repo in one step')
  .action((options) => {
    runSync({ ...options, remote: options.remote });
  });

// --- check-constraints ---
program
  .command('check-constraints')
  .description('Check if staged files (or given files) violate active constraints')
  .option('--staged', 'Check git staged files (git diff --cached --name-only)')
  .option('--files <files...>', 'Explicit list of files to check')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runCheckConstraints({ staged: options.staged, files: options.files, json: options.json });
  });

// --- install-hooks ---
program
  .command('install-hooks')
  .description('Install a Git pre-commit hook that blocks sensitive content in .brainclaw/ and checks active constraints')
  .option('--force', 'Overwrite existing pre-commit hook')
  .action((options) => {
    runInstallHooks(options);
  });

// --- diff ---
program
  .command('diff')
  .description('Show what changed in .brainclaw/ since a timestamp or last context read')
  .option('--since <timestamp>', 'ISO 8601 timestamp to diff from')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runDiff(options);
  });

// --- prune ---
program
  .command('prune')
  .description('Prune expired constraints and stale memory')
  .option('--expired', 'Also prune expired runtime notes and traps')
  .action((options) => {
    runPrune(options);
  });

// --- mcp ---
program
  .command('mcp')
  .description('Start the standalone MCP server over stdio')
  .action(() => {
    runMcp();
  });

// --- set-trust ---
program
  .command('set-trust <agent>')
  .description('Set the trust level for a registered agent or manage circuit-breaker state')
  .option('--level <level>', 'Trust level: observer, contributor, trusted, curator')
  .option('--reset-breaker', 'Reset circuit-breaker suspension for the agent (restores auto-promote)')
  .option('--json', 'Output as JSON')
  .action((agent, options) => {
    runSetTrust(agent, { level: options.level, resetBreaker: options.resetBreaker, json: options.json });
  });

// --- session-start ---
program
  .command('session-start')
  .description('Start a memory session and capture initial context')
  .option('--agent <agent>', 'Agent name (defaults to current configured agent)')
  .option('--context <path>', 'Context target path for initial hash capture')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runSessionStart(options);
  });

// --- session-end ---
program
  .command('session-end')
  .description('End a memory session and optionally auto-reflect observations')
  .option('--session <id>', 'Session ID (defaults to BRAINCLAW_SESSION_ID env var)')
  .option('--agent <agent>', 'Agent name')
  .option('--summary <text>', 'Session summary text')
  .option('--auto-reflect', 'Auto-reflect session notes as pending candidates')
  .option('--auto-release', 'Auto-release any active claims at session end')
  .option('--reflect-handoff', 'Generate a handoff candidate from git commits since session start')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runSessionEnd({ ...options, autoReflect: options.autoReflect, autoRelease: options.autoRelease, reflectHandoff: options.reflectHandoff });
  });

// --- whoami ---
program
  .command('whoami')
  .description('Show the current resolved agent identity and trust level')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runWhoami(options);
  });

// --- search ---
program
  .command('search <query>')
  .description('Full-text search across project memory')
  .option('--section <section>', 'Filter by section: constraints, decisions, traps, handoffs, plans')
  .option('--since <timestamp>', 'ISO timestamp filter')
  .option('--tag <tags...>', 'Filter by tags')
  .option('--pending', 'Include pending candidates')
  .option('--max-results <count>', 'Maximum results to return', parseInt)
  .option('--json', 'Output as JSON')
  .action((query, options) => {
    runSearch(query, options);
  });

// --- export ---
program
  .command('export')
  .description('Export memory as instructions for IDE/AI tools')
  .option('--format <format>', 'Format: copilot-instructions, cursor-rules, agents-md, claude-md, windsurf, cline, roo, continue')
  .option('--detect', 'Auto-detect agent environment and write to its native file')
  .option('--write', 'Write to canonical file path instead of stdout (when --format is given)')
  .option('--output <file>', 'Write to a specific file path instead of stdout')
  .option('--project <project>', 'Project namespace filter')
  .option('--agent <agent>', 'Agent name for agent-layer instructions')
  .action((options) => {
    runExport(options);
  });

// --- hooks ---
program
  .command('hooks')
  .description('Write deterministic session-trigger hooks for Cursor (.cursor/rules/brainclaw-session.mdc) and Windsurf (.windsurfrules)')
  .option('--target <target>', 'Which hooks to write: cursor, windsurf, all (default: all)')
  .action((options) => {
    runHooks(options);
  });

// --- watch ---
program
  .command('watch')
  .description('Watch for memory changes and emit NDJSON events on stdout')
  .option('--interval <seconds>', 'Poll interval in seconds', parseInt)
  .option('--auto-claim', 'Auto-create advisory claims on first write to workspace files')
  .option('--agent <name>', 'Agent name for auto-claim')
  .action((options) => {
    runWatch({ ...options, autoClaim: options.autoClaim });
  });

// --- metrics ---
program
  .command('metrics')
  .description('Show memory health metrics dashboard')
  .option('--json', 'Output as JSON')
  .option('--since <timestamp>', 'Filter audit log stats from this ISO timestamp')
  .action((options) => {
    runMetrics(options);
  });

// --- rollback ---
program
  .command('rollback')
  .description('Restore a memory item to a previous state from audit log')
  .option('--audit-id <timestamp>', 'Audit log entry timestamp to roll back')
  .option('--item-id <id>', 'Memory item ID to roll back (uses most recent audit entry with before-state)')
  .option('--dry-run', 'Preview rollback without applying changes')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runRollback({ auditId: options.auditId, itemId: options.itemId, dryRun: options.dryRun, json: options.json });
  });

// --- pull ---
program
  .command('pull')
  .description('Pull memory updates from a git remote')
  .option('--remote <remote>', 'Remote name (defaults to origin)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runPull(options);
  });

// --- push ---
program
  .command('push')
  .description('Push memory updates to a git remote')
  .option('--remote <remote>', 'Remote name (defaults to origin)')
  .option('--message <message>', 'Custom commit message')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runPush(options);
  });

// --- audit ---
program
  .command('audit')
  .description('View the append-only audit log of all memory mutations')
  .option('--since <date>', 'Show entries since this ISO date')
  .option('--actor <agent>', 'Filter by actor name or agent ID')
  .option('--action <action>', 'Filter by action type (create, accept, reject, etc.)')
  .option('--limit <n>', 'Show last N entries', parseInt)
  .option('--json', 'Output as JSON')
  .action((options) => {
    runAuditCommand({ since: options.since, actor: options.actor, action: options.action, limit: options.limit, json: options.json });
  });

// --- history ---
program
  .command('history <id>')
  .description('Show full mutation history of a memory item from the audit log')
  .action((id) => {
    runHistory(id);
  });

// --- context-diff ---
program
  .command('context-diff')
  .description('Show what changed in memory since last context read, a session start, or a given timestamp')
  .option('--since <date>', 'Show changes since this ISO date')
  .option('--session <id>', 'Show changes since the start of this session')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runContextDiff({ since: options.since, session: options.session, json: options.json });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
