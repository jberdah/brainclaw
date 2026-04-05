#!/usr/bin/env node

import path from 'node:path';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runSetup } from './commands/setup.js';
import { runUpgrade } from './commands/upgrade.js';
import { patchAllMcpConfigs } from './core/agent-files.js';
import { runReconcile } from './commands/reconcile.js';
import { getMemoryLog, rollbackMemory, hasMemoryRepo } from './core/memory-git.js';
import { buildMachineProfile, saveMachineProfile, loadMachineProfile, renderMachineProfileSummary } from './core/machine-profile.js';
import { buildAgentInventory, saveAgentInventory, loadAgentInventory, renderAgentInventorySummary } from './core/agent-inventory.js';
import { scanAndRegister, scanProject, upsertProject, loadGlobalRegistry, renderGlobalRegistrySummary } from './core/global-registry.js';
import { runStatus } from './commands/status.js';
import { runDecision } from './commands/decision.js';
import { runConstraint } from './commands/constraint.js';
import { runTrap } from './commands/trap.js';
import { runHandoff } from './commands/handoff.js';
import { runListPlans } from './commands/list-plans.js';
import { runUpdatePlan } from './commands/update-plan.js';
import { runDeletePlan } from './commands/delete-plan.js';
import { runPlanResource } from './commands/plan-resource.js';
import { runSequenceResource } from './commands/sequence.js';
import { runAddStep } from './commands/add-step.js';
import { runEstimationReport } from './commands/estimation-report.js';
import { runCompleteStep } from './commands/complete-step.js';
import { runUpdateHandoff } from './commands/update-handoff.js';
import { runInstruction } from './commands/instruction.js';
import { runListAgents } from './commands/list-agents.js';
import { runSurfaceTaskResource } from './commands/surface-task-resource.js';
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
import { runListClaims } from './commands/list-claims.js';
import { runReleaseClaim } from './commands/release-claim.js';
import { runClaimResource } from './commands/claim-resource.js';
import { runMemoryCommand } from './commands/memory.js';
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
import { runCheckPolicy } from './commands/check-policy.js';
import { runCheckSecurity } from './commands/check-security.js';
import { runSetupSecurity } from './commands/setup-security.js';
import { runRegisterAgent } from './commands/register-agent.js';
import { runEnableAgent } from './commands/enable-agent.js';
import { runVersion } from './commands/version.js';
import { runReleaseNotes } from './commands/release-notes.js';
import { runDiff } from './commands/changes.js';
import { runPrune } from './commands/prune.js';
import { runMcp } from './commands/mcp.js';
import { runSetTrust } from './commands/set-trust.js';
import { runSessionStart } from './commands/session-start.js';
import { runSessionEnd } from './commands/session-end.js';
import { runWhoami } from './commands/whoami.js';
import { runUsage } from './commands/usage.js';
import { runSearch } from './commands/search.js';
import { runExport, runRefresh } from './commands/export.js';
import { runHooks } from './commands/hooks.js';
import { runWatch } from './commands/watch.js';
import { runMetrics } from './commands/metrics.js';
import { runRollback } from './commands/rollback.js';
import { runPull } from './commands/pull.js';
import { runPush } from './commands/push.js';
import { runAuditCommand } from './commands/audit.js';
import { runHistory } from './commands/history.js';
import { runContextDiff } from './commands/context-diff.js';
import { runCapability } from './commands/capability.js';
import { runTool } from './commands/tool.js';
import { runExplore } from './commands/explore.js';
import { getInstalledBrainclawVersion } from './core/brainclaw-version.js';
import { cleanOrphanFiles, memoryDir } from './core/io.js';
import { initLogLevel, logger } from './core/logger.js';
import { resolveEffectiveCwd } from './core/store-resolution.js';
import { runSwitch } from './commands/switch.js';
import { runWorktreeCreate, runWorktreeList, runWorktreeRemove, runWorktreePrune } from './commands/worktree.js';
import { runCheckEvents } from './commands/check-events.js';
import { runDiscover } from './commands/discover.js';
import { runMigrate } from './commands/migrate.js';

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
  .option('--cwd <path>', 'Override working directory for this invocation')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const root = actionCommand.optsWithGlobals();
    initLogLevel({ verbose: root.verbose, debug: root.debug });

    // Skip effective cwd resolution for commands that create the store
    const cmdName = actionCommand.name();
    const skipResolution = cmdName === 'init' || cmdName === 'setup';

    if (!skipResolution) {
      // Resolve effective cwd (--cwd > BRAINCLAW_PROJECT > active-project > process.cwd)
      const effectiveCwd = resolveEffectiveCwd({ explicitCwd: root.cwd });
      if (effectiveCwd !== process.cwd()) {
        // Change process.cwd() so all commands resolve the correct store
        // without needing individual --cwd plumbing
        process.chdir(effectiveCwd);
        logger.info(`Resolved effective cwd: ${effectiveCwd}`);
      }

      const removed = cleanOrphanFiles(memoryDir());
      if (removed > 0) {
        logger.info(`Cleaned ${removed} orphan lock/tmp file(s) in ${memoryDir()}`);
      }
    } else if (root.cwd) {
      // For init/setup, still respect explicit --cwd but nothing else
      process.chdir(path.resolve(root.cwd));
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
  .option('--scan', 'Scan subdirectories for service boundaries and suggest init targets')
  .action(async (options) => {
    await runInit(options);
  });

// --- setup ---
program
  .command('setup')
  .description('Interactive onboarding wizard — global agent install + multi-repo init')
  .option('--roots <paths>', 'Comma-separated root directories to scan (skips interactive prompt)')
  .option('--agents <agents>', 'Agents to configure: all, detected, or comma-separated names')
  .option('--repos <mode>', 'Repo selection: all, current, or comma-separated numbers')
  .option('-y, --yes', 'Accept all defaults non-interactively')
  .action(async (options) => {
    await runSetup(options);
  });

// --- memory-log ---
program
  .command('memory-log')
  .description('Show recent memory change history (from internal git repo)')
  .option('-n, --limit <count>', 'Number of entries to show', '20')
  .action((options) => {
    const entries = getMemoryLog(parseInt(options.limit, 10));
    if (entries.length === 0) {
      console.log('No memory history available. Run `brainclaw init --force` to enable memory versioning.');
      return;
    }
    console.log(`Memory history (${entries.length} entries):\n`);
    for (const entry of entries) {
      console.log(`  ${entry}`);
    }
  });

// --- memory-rollback ---
program
  .command('memory-rollback <ref>')
  .description('Rollback entire memory to a previous git snapshot (use memory-log to find refs)')
  .action((ref) => {
    if (!hasMemoryRepo()) {
      console.error('Error: no memory git repo. Run `brainclaw init --force` to enable.');
      process.exit(1);
    }
    const success = rollbackMemory(ref);
    if (success) {
      console.log(`✔ Memory rolled back to ${ref}`);
    } else {
      console.error(`Error: failed to rollback to '${ref}'. Check memory-log for valid refs.`);
      process.exit(1);
    }
  });

// --- upgrade ---
program
  .command('upgrade')
  .description('Upgrade project memory structure and refresh managed workspace agent files without losing data')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--self-update', 'Check for a newer brainclaw package version and install it before upgrading memory')
  .action((options) => {
    runUpgrade({
      json: options.json,
      dryRun: options.dryRun,
      selfUpdate: options.selfUpdate,
    });
  });

// --- patch-configs ---
  program
    .command('patch-configs')
    .description('Patch all MCP config files to use the current brainclaw binary path')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const cwd = process.env.BRAINCLAW_CWD ?? process.cwd();
      const results = patchAllMcpConfigs(cwd);
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else if (results.length === 0) {
        console.log('✔ All MCP configs are already up to date.');
      } else {
        for (const r of results) {
          const tag = r.created ? 'created' : 'updated';
          console.log(`✔ ${r.filePath} (${tag}) — ${r.label}`);
        }
        console.log(`\n${results.length} MCP config(s) patched.`);
      }
    });

// --- machine-profile ---
  program
    .command('machine-profile')
    .description('Detect and persist machine capabilities (OS, shells, git users, SSH keys, toolchains, WSL, AI surfaces)')
    .option('--refresh', 'Force regeneration even if profile exists')
    .option('--json', 'Output as JSON')
  .action(async (options) => {
    const existing = loadMachineProfile();
    if (existing && !options.refresh) {
      if (options.json) {
        console.log(JSON.stringify(existing, null, 2));
      } else {
        console.log(renderMachineProfileSummary(existing));
        console.log('\nUse --refresh to regenerate.');
      }
      return;
    }
    console.log('Detecting machine capabilities...');
    const profile = buildMachineProfile();
    const filePath = saveMachineProfile(profile);
    if (options.json) {
      console.log(JSON.stringify(profile, null, 2));
    } else {
      console.log(renderMachineProfileSummary(profile));
      console.log(`\n✔ Profile saved to ${filePath}`);
    }
  });

// --- agent-inventory ---
program
  .command('agent-inventory')
  .description('Detect all installed AI coding agents and their capabilities')
  .option('--refresh', 'Force regeneration even if inventory exists')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const existing = loadAgentInventory();
    if (existing && !options.refresh) {
      if (options.json) {
        console.log(JSON.stringify(existing, null, 2));
      } else {
        console.log(renderAgentInventorySummary(existing));
        console.log('\nUse --refresh to regenerate.');
      }
      return;
    }
    console.log('Detecting installed agents...');
    const inventory = buildAgentInventory();
    const filePath = saveAgentInventory(inventory);
    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
    } else {
      console.log(renderAgentInventorySummary(inventory));
      console.log(`\n✔ Inventory saved to ${filePath}`);
    }
  });

// --- projects ---
program
  .command('projects')
  .description('List all brainclaw-initialized projects on this machine')
  .option('--scan <roots>', 'Comma-separated directories to scan for projects')
  .option('--register', 'Register the current project in the global registry')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    if (options.register) {
      const entry = scanProject(process.cwd());
      if (!entry) {
        console.error('No brainclaw project found in current directory. Run brainclaw init first.');
        process.exit(1);
      }
      upsertProject(entry);
      console.log(`✔ Registered ${entry.project_name} (${entry.project_id})`);
      return;
    }
    if (options.scan) {
      const roots = (options.scan as string).split(',').map((r: string) => r.trim());
      console.log(`Scanning ${roots.join(', ')}...`);
      const registry = scanAndRegister(roots);
      if (options.json) {
        console.log(JSON.stringify(registry, null, 2));
      } else {
        console.log(renderGlobalRegistrySummary(registry));
      }
      return;
    }
    // Default: show existing registry
    const registry = loadGlobalRegistry();
    if (!registry || registry.projects.length === 0) {
      console.log('No projects registered. Use --scan <roots> or --register to add projects.');
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(registry, null, 2));
    } else {
      console.log(renderGlobalRegistrySummary(registry));
    }
  });

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
  .action((subcommand, args, options) => {
    runPlanResource(subcommand, args, { ...options, actualEffort: options.actualEffort });
  });

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
  .action((options) => {
    runListPlans(options);
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
  .option('--fix-agent-ignore', 'Add missing .gitignore entries for generated local Brainclaw agent files')
  .option('--fix', 'Fix auto-resolvable issues (e.g. drifting MCP configs)')
  .action((options) => {
    runDoctor(options);
  });

// --- version ---
program
  .command('version')
  .description('Show the installed brainclaw version and the project version policy')
  .option('--check', 'Check the configured installable update source')
  .option('--publish-local', 'Create/update the local installable .releases channel via npm pack')
  .option('--release-notes <text>', 'Attach plain-text release notes to the generated local-pack manifest')
  .option('--agent-release-notes <json>', 'Attach structured agent-first release notes (JSON) to the generated local-pack manifest')
  .option('--auto-release-notes', 'Auto-generate agent-first release notes from git log (use with --publish-local)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runVersion(options);
  });

// --- release-notes ---
program
  .command('release-notes')
  .description('Show or generate agent-first release notes')
  .option('--generate', 'Generate release notes from git log instead of showing configured ones')
  .option('--since <ref>', 'Git ref to generate from (default: last version tag)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runReleaseNotes(options);
  });

// --- uninstall ---
import { runUninstall } from './commands/uninstall.js';
program
  .command('uninstall')
  .description('Remove brainclaw from a project and/or machine')
  .option('--project', 'Remove brainclaw from the current project (.brainclaw/, agent files, configs)')
  .option('--machine', 'Remove brainclaw global config (~/.brainclaw/)')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (options) => {
    await runUninstall(options);
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
  .description('Derive brownfield bootstrap signals and optionally import them into canonical memory')
  .option('--for <target>', 'Target path or scope to tailor the bootstrap')
  .option('--json', 'Output as JSON')
  .option('--refresh', 'Force a fresh bootstrap scan instead of reusing the current profile')
  .option('--interview', 'Render the adaptive interview prompts instead of the bootstrap summary')
  .option('--audience <audience>', 'Target interview prompts for cli, ide_chat, or any')
  .option('--answers-file <path>', 'Load structured bootstrap interview answers from a JSON file')
  .option('--apply', 'Import the current bootstrap proposal into canonical memory')
  .option('--uninstall', 'Deactivate the last bootstrap import managed by this workspace')
  .option('-y, --yes', 'Skip confirmation prompts for apply/uninstall')
  .action(async (options) => {
    await runBootstrap(options);
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

// --- memory ---
program
  .command('memory <subcommand> [args...]')
  .description('Manage canonical memory items (create, list, update, delete)')
  .option('--json', 'Output as JSON for list')
  .option('--type <type>', 'Memory type/filter: decision, constraint, trap, handoff')
  .option('--text <text>', 'Replacement text for memory update')
  .option('--tag <tags...>', 'Tags')
  .option('--path <paths...>', 'Related file paths')
  .option('--author <author>', 'Author name')
  .option('--outcome <outcome>', 'Decision outcome: approved, rejected, deferred, pending')
  .option('--category <category>', 'Constraint category: architecture, performance, security, reliability, compatibility, process, other')
  .option('--status <status>', 'Constraint, trap, or handoff status')
  .option('--severity <severity>', 'Trap severity: low, medium, high')
  .option('--project <project>', 'Optional project namespace')
  .option('--plan <id>', 'Optional linked plan item ID')
  .option('--from <from>', 'Handoff source')
  .option('--to <to>', 'Handoff destination')
  .option('--visibility <visibility>', 'Trap visibility: shared, machine, private', 'shared')
  .option('--host <host>', 'Optional host identifier override for machine/private traps')
  .option('--ttl <duration>', 'Time-to-live: 30m, 2h, 7d')
  .option('--store <target>', 'Target store level: local (default), repo, workspace, user')
  .action((subcommand, args, options) => {
    runMemoryCommand(subcommand, args, options);
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

// --- register-agent ---
program
  .command('register-agent <name>')
  .description('Register an agent or human identity in project memory')
  .option('--kind <kind>', 'Identity kind: agent, human, unknown', 'unknown')
  .option('--capability <value>', 'Declare a capability on the agent profile (repeatable)', collect, [])
  .option('--replace-capabilities', 'Replace existing capabilities instead of merging')
  .option('--generate-fingerprint', 'Generate or rotate a local public identity fingerprint for this agent')
  .option('--set-current', 'Set this identity as the current agent in config')
  .option('--curator', 'Register this agent as a curator (project owner with direct-write access)')
  .option('--json', 'Output as JSON')
  .action((name, options) => {
    runRegisterAgent(name, options);
  });

// --- enable-agent ---
program
  .command('enable-agent <name>')
  .description('Activate a supported coding agent on an already initialized project')
  .option('--kind <kind>', 'Identity kind: agent, human, unknown', 'agent')
  .option('--context-profile <profile>', 'Default context profile: dev, dense, compact, copilot, quick, openclaw, ops, research')
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
  .command('claim <subcommand> [args...]')
  .description('Manage work claims (create, list, release)')
  .option('--agent <agent>', 'Agent or person name; defaults to the configured current agent')
  .option('--scope <scope>', 'Scope being claimed (e.g. file path, module)')
  .option('--project <project>', 'Optional project namespace for this claim')
  .option('--plan <id>', 'Optional linked plan item ID')
  .option('--ttl <duration>', 'Auto-expire after duration: 30m, 2h, 8h, 1d')
  .option('--all', 'Include released claims in list')
  .option('--json', 'Output as JSON for list')
  .option('--plan-status <status>', 'Optional linked plan status when releasing: todo, in_progress, blocked, done, dropped')
  .option('--store <target>', 'Target store level: local (default), repo, workspace')
  .action((subcommand, args, options) => {
    runClaimResource(subcommand, args, { ...options, planStatus: options.planStatus });
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
  .option('--include-session-meta', 'Include session_start/session_end runtime notes (hidden by default)')
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

// --- check-policy ---
program
  .command('check-policy')
  .description('Pre-execution policy check: verify claims, constraints, traps and instructions for a scope')
  .requiredOption('--scope <path>', 'File or directory scope to check')
  .option('--agent <name>', 'Agent name to check claims for')
  .option('--agent-id <id>', 'Agent id to check claims for')
  .option('--action <action>', 'Intended action: edit, create, delete')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runCheckPolicy({
      scope: options.scope,
      agent: options.agent,
      agentId: options.agentId,
      action: options.action,
      json: options.json,
    });
  });

// --- check-security ---
program
  .command('check-security')
  .description('Check supply chain security scores for packages via Socket.dev')
  .requiredOption('--packages <names>', 'Comma-separated package names (e.g. "axios,express" or "axios@1.14.1")')
  .option('--ecosystem <type>', 'Package ecosystem: npm or pypi', 'npm')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await runCheckSecurity({
      packages: options.packages,
      ecosystem: options.ecosystem,
      json: options.json,
    });
  });

// --- setup-security ---
program
  .command('setup-security')
  .description('Enable supply chain security gate: generate wrapper scripts and configure preinstall checks')
  .option('--mode <mode>', 'Security mode: advisory (default) or enforced', 'advisory')
  .action((options) => {
    runSetupSecurity({ mode: options.mode });
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
  .option('--archive', 'Archive done plans and closed handoffs (>30 days) to cold storage JSONL')
  .option('--semantic', 'Detect near-duplicate clusters and stale items via semantic analysis')
  .option('--dry-run', 'Preview compaction without applying (use with --semantic)')
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
  .option('--model <id>', 'Model identifier (e.g. claude-sonnet-4-6)')
  .option('--include-context', 'Output full project context after starting session (replaces separate context call)')
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
  .option('--reflect', 'Include structured reflection questions for the agent to answer')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runSessionEnd({ ...options, autoReflect: options.autoReflect, autoRelease: options.autoRelease, reflectHandoff: options.reflectHandoff, reflect: options.reflect });
  });

// --- whoami ---
program
  .command('whoami')
  .description('Show the current resolved agent identity and trust level')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runWhoami(options);
  });

// --- usage ---
program
  .command('usage')
  .description('Show brainclaw context volume stats (tokens injected per agent/tool)')
  .option('--agent <name>', 'Filter by agent name')
  .option('--tool <name>', 'Filter by tool name')
  .option('--days <n>', 'Limit to last N days', parseInt)
  .option('--json', 'Output as JSON')
  .action((options) => {
    runUsage(options);
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
  .option('--format <format>', 'Format: copilot-instructions, cursor-rules, agents-md, claude-md, gemini-md, windsurf, cline, roo, continue')
  .option('--detect', 'Auto-detect agent environment and write to its native file')
  .option('--all', 'Write all known agent instruction files at once (claude-md, agents-md, copilot-instructions, cursor-rules, etc.)')
  .option('--write', 'Write to canonical file path instead of stdout (when --format is given); local files are gitignored by default')
  .option('--shared', 'Keep the main exported instruction file versionable instead of auto-ignoring it (companions remain local)')
  .option('--output <file>', 'Write to a specific file path instead of stdout')
  .option('--project <project>', 'Project namespace filter')
  .option('--agent <agent>', 'Agent name for agent-layer instructions')
  .action((options) => {
    runExport(options);
  });

program
  .command('refresh')
  .description('Refresh live companion files with current state (plans, claims, traps, sequences). Gitignored, safe to run frequently.')
  .action(() => {
    runRefresh();
  });

program
  .command('reconcile')
  .description('Refresh machine and workspace bootstrap state after updates or onboarding on complex installs')
  .option('--json', 'Output as JSON')
  .option('--dry-run', 'Preview the reconciliation plan without writing machine or bootstrap state')
  .option('--apply-bootstrap', 'Apply bootstrap suggestions across all selected stores after refresh')
  .option('-y, --yes', 'Skip confirmation prompts for multi-store bootstrap apply')
  .option('--skip-machine-profile', 'Skip machine-profile refresh')
  .option('--skip-agent-inventory', 'Skip agent-inventory refresh')
  .action(async (options) => {
    await runReconcile({
      json: options.json,
      dryRun: options.dryRun,
      applyBootstrap: options.applyBootstrap,
      yes: options.yes,
      skipMachineProfile: options.skipMachineProfile,
      skipAgentInventory: options.skipAgentInventory,
    });
  });

// --- hooks ---
program
  .command('hooks')
  .description('Write deterministic session-trigger hooks for Cursor, Windsurf, and Claude Code (PostToolUse event check)')
  .option('--target <target>', 'Which hooks to write: cursor, windsurf, claude-code, all (default: all)')
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

// --- check-events ---
program
  .command('check-events')
  .description('Show unseen events from the event bus (events.jsonl) for the current agent')
  .option('--agent <name>', 'Agent name for cursor lookup (default: auto-detected)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    runCheckEvents(options);
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
  .description('View the append-only audit log, or generate a governance posture report with --governance')
  .option('--since <date>', 'Show entries since this ISO date')
  .option('--actor <agent>', 'Filter by actor name or agent ID')
  .option('--action <action>', 'Filter by action type (create, accept, reject, etc.)')
  .option('--limit <n>', 'Show last N entries', parseInt)
  .option('--json', 'Output as JSON')
  .option('--governance', 'Generate a governance posture report (aggregated view of claims, constraints, traps, instructions)')
  .option('--scope <path>', 'Filter governance report by scope (used with --governance)')
  .action((options) => {
    runAuditCommand({ since: options.since, actor: options.actor, action: options.action, limit: options.limit, json: options.json, governance: options.governance, scope: options.scope });
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

program
  .command('capability <subcommand> [args...]')
  .description('Manage project capabilities (list, add, describe)')
  .option('--tag <tag>', 'Tag for categorization (repeatable)', (val: string, prev: string[]) => [...(prev || []), val])
  .option('--author <name>', 'Author name')
  .option('--store <target>', 'Store level: local (default), repo, workspace, user')
  .action((subcommand: string, args: string[], options) => {
    runCapability(subcommand, args, {
      tag: options.tag,
      author: options.author,
      store: options.store,
    });
  });

program
  .command('tool <subcommand> [args...]')
  .description('Manage project tools (list, add, describe, search)')
  .option('--tag <tag>', 'Tag for categorization (repeatable)', (val: string, prev: string[]) => [...(prev || []), val])
  .option('--type <type>', 'Tool type: workflow, validator, generator, utility, explorer')
  .option('--author <name>', 'Author name')
  .option('--store <target>', 'Store level: local (default), repo, workspace, user')
  .action((subcommand: string, args: string[], options) => {
    runTool(subcommand, args, {
      tag: options.tag,
      type: options.type,
      author: options.author,
      store: options.store,
    });
  });

program
  .command('explore')
  .description('Explore project capabilities and available tools')
  .option('--query <q>', 'Search for specific capability or tool')
  .action((options) => {
    runExplore({ query: options.query });
  });

// --- discover ---
program
  .command('discover')
  .description('Scan workspace for MCP configs, instruction files, skills, hooks, and agent integrations')
  .option('--json', 'Output as JSON')
  .option('--no-save', 'Do not persist discovery profile to .brainclaw/discovery/')
  .action((options) => {
    runDiscover({ json: options.json, save: options.save });
  });

// --- migrate ---
program
  .command('migrate')
  .description('Migrate memory items between stores (e.g. promote machine-scoped items to user store)')
  .option('--promote-machine-items', 'Move items with scope:machine from project store to user store (~/.brainclaw/)')
  .option('--dry-run', 'Show what would be moved without actually moving')
  .action((options) => {
    runMigrate({ promoteMachineItems: options.promoteMachineItems, dryRun: options.dryRun });
  });

program
  .command('switch [project]')
  .description('Set the active project for subsequent commands')
  .option('--list', 'List available projects in the workspace')
  .option('--clear', 'Clear the active project (revert to cwd)')
  .option('--json', 'Output as JSON')
  .action((project: string | undefined, options) => {
    const globalOpts = options.parent?.parent ? program.opts() : {};
    runSwitch(project, {
      list: options.list,
      clear: options.clear,
      json: options.json,
      cwd: globalOpts.cwd,
    });
  });

program
  .command('who')
  .description('Show active agent sessions on this workspace')
  .option('--json', 'Output as JSON')
  .option('--all', 'Include stale sessions')
  .option('--gc', 'Remove stale sessions')
  .action(async (options) => {
    const globalOpts = program.opts();
    const { runWho } = await import('./commands/who.js');
    runWho({ json: options.json, all: options.all, gc: options.gc, cwd: globalOpts.cwd });
  });

const worktreeCmd = program
  .command('worktree')
  .description('Manage git worktrees for parallel agent isolation');

worktreeCmd
  .command('create <branch>')
  .description('Create a linked git worktree for a given branch')
  .option('--session-id <id>', 'Associate this worktree with a brainclaw session')
  .option('--agent <name>', 'Associate this worktree with an agent name')
  .action((branch: string, options) => {
    const globalOpts = program.opts();
    runWorktreeCreate({ branch, sessionId: options.sessionId, agent: options.agent, cwd: globalOpts.cwd });
  });

worktreeCmd
  .command('list')
  .description('List all git worktrees for this project')
  .action(() => {
    const globalOpts = program.opts();
    runWorktreeList({ cwd: globalOpts.cwd });
  });

worktreeCmd
  .command('remove <path>')
  .description('Remove a linked git worktree')
  .option('--force', 'Force removal even with uncommitted changes')
  .action((worktreePath: string, options) => {
    const globalOpts = program.opts();
    runWorktreeRemove({ path: worktreePath, force: options.force, cwd: globalOpts.cwd });
  });

worktreeCmd
  .command('prune')
  .description('Prune stale worktree administrative files')
  .action(() => {
    const globalOpts = program.opts();
    runWorktreePrune({ cwd: globalOpts.cwd });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
