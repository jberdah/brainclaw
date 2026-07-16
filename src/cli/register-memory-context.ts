import type { Command } from 'commander';
import { getMemoryLog, rollbackMemory, hasMemoryRepo } from '../core/memory-git.js';
import { requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { runContext } from '../commands/context.js';
import { runBootstrap } from '../commands/bootstrap.js';
import { runMemoryCommand } from '../commands/memory.js';
import { runRegisterAgent, runRemoveAgent } from '../commands/register-agent.js';
import { runEnableAgent } from '../commands/enable-agent.js';
import { runListAgents } from '../commands/list-agents.js';
import { runSync } from '../commands/sync.js';
import { runDiff } from '../commands/changes.js';
import { runPrune } from '../commands/prune.js';
import { runCompact } from '../commands/compact.js';
import { runSetTrust } from '../commands/set-trust.js';
import { runSessionStart } from '../commands/session-start.js';
import { runSessionEnd } from '../commands/session-end.js';
import { runWhoami } from '../commands/whoami.js';
import { runUsage } from '../commands/usage.js';
import { runSearch } from '../commands/search.js';
import { runExport, runRefresh } from '../commands/export.js';
import { runMetrics } from '../commands/metrics.js';
import { runRollback } from '../commands/rollback.js';
import { runPull } from '../commands/pull.js';
import { runPush } from '../commands/push.js';
import { runAuditCommand } from '../commands/audit.js';
import { runHistory } from '../commands/history.js';
import { runContextDiff } from '../commands/context-diff.js';
import { runCapability } from '../commands/capability.js';
import { runLink } from '../commands/link.js';
import { runTool } from '../commands/tool.js';
import { runExplore } from '../commands/explore.js';
import { runSwitch } from '../commands/switch.js';
import { collect } from './shared.js';

export function registerMemoryContextCommands(program: Command): void {
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
    .description('Restore live project memory from a previous git snapshot without deleting audit or archive artifacts')
    .option('--actor <name>', 'Registered human identity required to authorize the rollback')
    .action((ref, options) => {
      const cwd = process.cwd();
      if (!hasMemoryRepo()) {
        console.error('Error: no memory git repo. Run `brainclaw init --force` to enable.');
        process.exit(1);
      }
      let actor;
      try {
        actor = requireRegisteredAgentIdentity({
          agentName: options.actor,
          allowCurrent: true,
          allowEnv: true,
          cwd,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      if (actor.kind !== 'human') {
        console.error(
          `Error: memory-rollback is reserved to registered human identities. Resolved actor '${actor.agent_name}' is kind='${actor.kind}'.`,
        );
        process.exit(1);
      }
      const success = rollbackMemory(ref, cwd);
      if (success) {
        console.log(`✔ Live project memory restored to ${ref} (audit, archives, backups preserved)`);
      } else {
        console.error(`Error: failed to rollback to '${ref}'. Check memory-log for valid refs.`);
        process.exit(1);
      }
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
    .option('--remove', 'Remove this identity instead of registering (guarded: debris identities only unless --force)')
    .option('--force', 'With --remove: allow removing a non-debris identity')
    .option('--json', 'Output as JSON')
    .action((name, options) => {
      if (options.remove) {
        runRemoveAgent(name, { force: options.force, json: options.json });
        return;
      }
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

  // --- compact ---
  program
    .command('compact')
    .description('LLM-driven semantic memory compaction — archive old items and get a summary template')
    .option('--assess', 'Show pressure assessment and compaction template without archiving')
    .option('--dry-run', 'Preview eligible items without archiving')
    .option('--max-items <n>', 'Maximum items to compact (default: 20)', parseInt)
    .option('--min-age <days>', 'Minimum age in days for eligibility (default: 7)', parseInt)
    .option('--no-dedup-handoffs', 'Skip deduplication of auto-generated session-end handoffs')
    .option('--no-purge-claims', 'Skip archival of released claims')
    .option('--no-purge-session-notes', 'Skip archival of session-lifecycle runtime_notes')
    .action((options) => {
      runCompact(options);
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
    .option('--maintenance-mode <mode>', 'Maintenance mode: full (default) or fast')
    .option('--include-context', 'Output full project context after starting session (replaces separate context call)')
    .option('--hook', 'Hook mode: degrade to exit 0 + ~/.brainclaw/hook.log on failure (advisory session hooks)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await runSessionStart(options);
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
    .option('--reflect-handoff', 'Materialize an open handoff from git commits since session start')
    .option('--dispatch-review', 'When used with --reflect-handoff, auto-dispatch a code review if the handoff is reviewable')
    .option('--reviewer <name>', 'Explicit reviewer to route the reflected handoff review to')
    .option('--no-reflect', 'Suppress the dogfooding reflection prompt (project + your surfaces/skills/tools), shown by default')
    .option('--hook', 'Hook mode: degrade to exit 0 + ~/.brainclaw/hook.log on failure (advisory Stop hook)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await runSessionEnd({
        ...options,
        autoReflect: options.autoReflect,
        autoRelease: options.autoRelease,
        reflectHandoff: options.reflectHandoff,
        dispatchReview: options.dispatchReview,
        reviewer: options.reviewer,
        reflect: options.reflect,
        hook: options.hook,
      });
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
    .option('--format <format>', 'Format: copilot-instructions, cursor-rules, agents-md, claude-md, gemini-md, windsurf, cline, roo, continue, openclaw, nanoclaw, nemoclaw, picoclaw, zeroclaw')
    .option('--detect', 'Auto-detect agent environment and write to its native file')
    .option('--all', 'Write all known agent instruction files at once (claude-md, agents-md, copilot-instructions, cursor-rules, etc.)')
    .option('--write', 'Write to canonical file path instead of stdout (when --format is given); local files are gitignored by default')
    .option('--include-live', 'Also write the native live companion file when the target agent supports one')
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
    .option('--hook', 'Hook mode: exit 0 silently when there is no diff baseline (advisory session hooks)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      runContextDiff({ since: options.since, session: options.session, json: options.json, hook: options.hook });
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
    .command('link <subcommand> [args...]')
    .description('Manage cross-project federation links (add, list, remove)')
    .option('--name <slug>', 'Override the auto-derived link name')
    .option('--role <role>', 'Link role: publisher (push signals out) or subscriber (default)')
    .option(
      '--channels <list>',
      'Comma-separated allow-list of channels: candidate,handoff,runtime_note',
      (val: string) => val.split(',').map((s) => s.trim()).filter(Boolean),
    )
    .option('--force', 'Replace an existing link of the same name/path')
    .option('--json', 'Output as JSON')
    .option('--store <target>', 'Store level: local (default), repo, workspace, user')
    .action((subcommand: string, args: string[], options) => {
      runLink(subcommand, args, {
        name: options.name,
        role: options.role,
        channels: options.channels,
        force: options.force,
        json: options.json,
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

  program
    .command('switch [project]')
    .description('Set the active project for subsequent commands (session-scoped by default)')
    .option('--list', 'List available projects in the workspace')
    .option('--clear', 'Clear the active project (revert to cwd)')
    .option('--global', 'Set/clear the SHARED workspace default for ALL agents (writes active-project.json). Without it, switch is session-scoped and isolated.')
    .option('--json', 'Output as JSON')
    .action((project: string | undefined, options) => {
      const globalOpts = options.parent?.parent ? program.opts() : {};
      runSwitch(project, {
        list: options.list,
        clear: options.clear,
        global: options.global,
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
    .option('--local-only', 'Read claims from local store only (skip parent stores in chain)')
    .action(async (options) => {
      const globalOpts = program.opts();
      const { runWho } = await import('../commands/who.js');
      runWho({ json: options.json, all: options.all, gc: options.gc, cwd: globalOpts.cwd, localOnly: options.localOnly });
    });
}
