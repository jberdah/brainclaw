import type { Command } from 'commander';
import { runInit } from '../commands/init.js';
import { runSetup, runSetupMachine } from '../commands/setup.js';
import { runUpgrade } from '../commands/upgrade.js';
import { patchAllMcpConfigs } from '../core/agent-files.js';
import { runReconcile } from '../commands/reconcile.js';
import { buildMachineProfile, saveMachineProfile, loadMachineProfile, renderMachineProfileSummary } from '../core/machine-profile.js';
import { buildAgentInventory, saveAgentInventory, loadAgentInventory, renderAgentInventorySummary } from '../core/agent-inventory.js';
import { scanAndRegister, scanProject, upsertProject, loadGlobalRegistry, renderGlobalRegistrySummary } from '../core/global-registry.js';
import { runStatus } from '../commands/status.js';
import { runDoctor, runDoctorSpawnCheck } from '../commands/doctor.js';
import { runRepair } from '../commands/repair.js';
import { runStale } from '../commands/stale.js';
import { runRebuild } from '../commands/rebuild.js';
import { runVersion } from '../commands/version.js';
import { runReleaseNotes } from '../commands/release-notes.js';
import { runUninstall } from '../commands/uninstall.js';
import { runEnv } from '../commands/env.js';
import { runCheckConstraints } from '../commands/check-constraints.js';
import { runCheckPolicy } from '../commands/check-policy.js';
import { runCheckSecurity } from '../commands/check-security.js';
import { runSetupSecurity } from '../commands/setup-security.js';
import { runInstallHooks } from '../commands/install-hooks.js';
import { runMcp } from '../commands/mcp.js';
import { runHooks } from '../commands/hooks.js';
import { runDiscover } from '../commands/discover.js';
import { runMigrate } from '../commands/migrate.js';

export function registerLifecycleCommands(program: Command): void {
  // --- init ---
  program
    .command('init')
    .description('Initialize or refresh project memory in .brainclaw/ storage directory')
    .option('-y, --yes', 'Skip interactive wizard and use defaults')
    .option('--force', 'Rebuild managed Brainclaw config and generated files from defaults')
    .option('--compact', 'Enable compact markdown mode')
    .option('--topology <mode>', 'Topology mode: embedded, sidecar, local-only')
    .option('--project-mode <mode>', 'Project mode: single-project, multi-project, auto')
    .option('--project-strategy <strategy>', 'Project strategy for multi-project mode: manual, folder')
    .option('--no-analyze-repo', 'Skip repository analysis when suggesting a project mode')
    .option('--no-ai-scan', 'Skip AI surface scan during init')
    .option('--scan', 'Scan subdirectories for service boundaries and suggest init targets')
    .option('--cwd <path>', 'Override working directory for init scaffolding (parity with other CLI commands)')
    .action(async (options) => {
      // pln#515 step 1: commander binds --cwd to the program-level option even
      // when it appears after `init`, so resolve via program.opts() and feed
      // runInit's existing options.cwd plumb.
      const programCwd = program.opts().cwd;
      await runInit({ ...options, cwd: options.cwd ?? programCwd });
    });

  // --- setup ---
  program
    .command('setup')
    .description('Interactive onboarding wizard — machine bootstrap plus multi-repo init')
    .option('--roots <paths>', 'Comma-separated root directories to scan (skips interactive prompt)')
    .option('--agents <agents>', 'Agents to configure: all, detected, or comma-separated names')
    .option('--repos <mode>', 'Repo selection: all, current, or comma-separated numbers')
    .option('-y, --yes', 'Accept all defaults non-interactively')
    .action(async (options) => {
      await runSetup(options);
    });

  // --- setup-machine ---
  program
    .command('setup-machine')
    .description('Machine-only onboarding — detect/configure agents and MCP without scanning or initializing repositories')
    .option('--agents <agents>', 'Agents to configure: all, detected, or comma-separated names')
    .option('-y, --yes', 'Accept all defaults non-interactively')
    .action(async (options) => {
      await runSetupMachine(options);
    });

  // --- upgrade ---
  program
    .command('upgrade')
    .description('Upgrade project memory structure and refresh managed workspace agent files without losing data')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--self-update', 'Check for a newer brainclaw package version and install it before upgrading memory')
    .option('--to <version>', 'One-shot target schema version (e.g. --to=1.0). Real runs require a backup.')
    .option('--backup', 'Create a timestamped backup of .brainclaw/ before any write (always on for --to runs)')
    .option('--no-backup', 'Disable the automatic backup for housekeeping-only upgrade runs')
    .option('--rollback', 'Restore the most recent backup, park the current live store, exit')
    .option('--yes', 'Skip interactive confirmations (reserved for later prompt additions)')
    .action((options) => {
      runUpgrade({
        json: options.json,
        dryRun: options.dryRun,
        selfUpdate: options.selfUpdate,
        to: options.to,
        backup: options.backup,
        rollback: options.rollback,
        yes: options.yes,
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

  // --- status ---
  program
    .command('status')
    .description('Show project memory status')
    .option('--json', 'Output as JSON')
    .option('--markdown', 'Output as Markdown')
    .action((options) => {
      runStatus(options);
    });

  // --- doctor ---
  program
    .command('doctor')
    .description('Check memory health and security')
    .option('--json', 'Output as JSON dashboard')
    .option('--migration-check', 'Report versioned documents that need schema migration')
    .option('--fix-agent-ignore', 'Add missing .gitignore entries for generated local Brainclaw agent files')
    .option('--fix-hooks', 'Purge stale/broken/duplicate brainclaw session hooks across all Claude Code settings scopes (user + cwd) and rewrite the canonical ones')
    .option('--fix', 'Fix auto-resolvable issues (e.g. drifting MCP configs)')
    .option('--repair', 'Rebuild dist/ when the MCP runtime is missing or stale')
    .option('--after-migration', 'Run the v1.0 post-migration health check only (exits non-zero on any failure)')
    .option('--dispatch', 'Run dispatch-health diagnostic only: reconcile open agent_runs and report stuck/unverified/silent failures (pln#496 step stp_8c072d75)')
    .option('--verify-journal', 'Phase-2 cutover gate (pln#565): rebuild state from the event journal and diff vs live projections; exits non-zero on any drift')
    .option('--spawn-check', 'Real spawn round-trip per installed agent before dispatch (pln#520 step 2): validates delivery + handshake on this host, exits non-zero on any installed-agent failure')
    .option('--spawn-check-timeout <ms>', 'Per-agent timeout for --spawn-check (default 15000)', parseInt)
    .option('--hygiene', 'Coordination-hygiene snapshot (pln#602): counts per family, park candidates, serve-count aging stats. Read-only.')
    .action(async (options) => {
      if (options.spawnCheck) {
        await runDoctorSpawnCheck({ cwd: options.cwd, json: options.json, timeoutMs: options.spawnCheckTimeout });
        return;
      }
      runDoctor({ ...options, afterMigration: options.afterMigration, dispatch: options.dispatch, verifyJournal: options.verifyJournal, hygiene: options.hygiene });
    });

  // --- repair (Phase 4 Sprint 2 Lane C / pln#397) ---
  program
    .command('repair')
    .description('Apply safe, non-destructive fixes for the repair candidates surfaced by doctor')
    .option('--dry-run', 'Print the plan without executing anything')
    .option('--include-unsafe', 'Also apply candidates flagged unsafe (preserves data but requires confirmation)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      runRepair({
        dryRun: options.dryRun,
        includeUnsafe: options.includeUnsafe,
        json: options.json,
      });
    });

  // --- stale (Phase 4 Sprint 1 Lane A / pln#390) ---
  program
    .command('stale [subcommand] [id]')
    .description('List or resolve stale memory items (plans, traps, handoffs, candidates, runtime notes). Subcommands: list (default), resolve <id>.')
    .option('--json', 'Output as JSON')
    .action((subcommand: string | undefined, id: string | undefined, options) => {
      runStale(subcommand, id, { json: options.json });
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

  // --- env ---
  program
    .command('env')
    .description('Show the local execution context and optionally detected agent tooling')
    .option('--json', 'Output as JSON')
    .option('--agent-tooling', 'Include AGENTS.md, local skills, and local MCP inventory')
    .action((options) => {
      runEnv({ ...options, agentTooling: options.agentTooling });
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
    .option('--packages <names>', 'Comma-separated package names (e.g. "axios,express" or "axios@1.14.1")')
    .option('--requirements <file>', 'Path to a pip-style requirements.txt to scan')
    .option('--lockfile <file>', 'Path to a package-lock.json (npm) to scan top-level deps')
    .option('--ecosystem <type>', 'Package ecosystem: npm or pypi', 'npm')
    .option('--mode <mode>', 'Override security mode: advisory or enforced (defaults to config)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await runCheckSecurity({
        packages: options.packages,
        requirements: options.requirements,
        lockfile: options.lockfile,
        ecosystem: options.ecosystem,
        mode: options.mode,
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

  // --- mcp ---
  program
    .command('mcp')
    .description('Start the standalone MCP server over stdio')
    .action(() => {
      runMcp();
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
    .option('--enable-journal', 'Turn on the event journal (mode=dual) for this existing store and backfill it (pln#567)')
    .option('--dry-run', 'Show what would be done without writing')
    .action((options) => {
      runMigrate({ promoteMachineItems: options.promoteMachineItems, enableJournal: options.enableJournal, dryRun: options.dryRun });
    });
}
