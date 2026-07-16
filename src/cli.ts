#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { getInstalledBrainclawVersion } from './core/brainclaw-version.js';
import { cleanOrphanFiles, memoryDir } from './core/io.js';
import { initLogLevel, logger } from './core/logger.js';
import { resolveEffectiveCwd } from './core/store-resolution.js';
import { resolveProjectCwd } from './core/cross-project.js';
import { registerLifecycleCommands } from './cli/register-lifecycle.js';
import { registerCaptureCommands } from './cli/register-capture.js';
import { registerPlanningCommands } from './cli/register-planning.js';
import { registerCoordinationCommands } from './cli/register-coordination.js';
import { registerReviewCommands } from './cli/register-review.js';
import { registerMemoryContextCommands } from './cli/register-memory-context.js';
import { registerFederationCommands } from './cli/register-federation.js';
import { registerCodeMapCommands } from './cli/register-code-map.js';

const program = new Command();

function parseLeadingGlobalOptions(argv: string[]): {
  verbose?: boolean;
  debug?: boolean;
  cwd?: string;
  project?: string;
} {
  const result: {
    verbose?: boolean;
    debug?: boolean;
    cwd?: string;
    project?: string;
  } = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      break;
    }
    if (token === '--verbose') {
      result.verbose = true;
      continue;
    }
    if (token === '--debug') {
      result.debug = true;
      continue;
    }
    if (token === '--cwd') {
      result.cwd = argv[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      result.cwd = token.slice('--cwd='.length);
      continue;
    }
    if (token === '--project') {
      result.project = argv[i + 1];
      i++;
      continue;
    }
    if (token.startsWith('--project=')) {
      result.project = token.slice('--project='.length);
      continue;
    }
  }

  return result;
}

function trailingGlobalOptionError(argv: string[], actionCommand: Command): string | undefined {
  let firstCommandIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (!token.startsWith('-')) {
      firstCommandIndex = i;
      break;
    }
    if (token === '--cwd' || token === '--project') i++;
  }
  if (firstCommandIndex < 0) return undefined;

  for (let i = firstCommandIndex + 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const long = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!['--cwd', '--project', '--verbose', '--debug'].includes(long)) continue;
    const isLocalOption = actionCommand.options.some((option) => option.long === long);
    if (!isLocalOption) {
      const valueHint = token === long && (long === '--cwd' || long === '--project') ? ' <value>' : '';
      return `Global option ${long} must appear before the subcommand. Use: brainclaw ${long}${valueHint} <command> ...`;
    }
  }
  return undefined;
}

/**
 * Resolve the (possibly nested) subcommand named in argv without parsing.
 * Used to run the trailing-global-option guard BEFORE Commander parses:
 * with positional options enabled, Commander would otherwise reject a
 * trailing --cwd/--project as "unknown option" before any hook runs.
 */
function findCommandFromArgv(argv: string[]): Command | undefined {
  let current: Command = program;
  let found: Command | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break;
    if (token.startsWith('-')) {
      if (!found && (token === '--cwd' || token === '--project')) i++;
      continue;
    }
    const sub = current.commands.find((c) => c.name() === token || c.aliases().includes(token));
    if (!sub) break;
    found = sub;
    current = sub;
  }
  return found;
}

program
  .name('brainclaw')
  // Stop the program-level parser from consuming options that appear AFTER the
  // subcommand: `instruction … --project auth` must reach the subcommand's own
  // --project, not the global routing flag (which is leading-only by contract —
  // see parseLeadingGlobalOptions + trailingGlobalOptionError).
  .enablePositionalOptions()
  .description('Shared project memory for humans and coding agents.')
  .version(getInstalledBrainclawVersion())
  .option('--verbose', 'Show info-level log messages on stderr')
  .option('--debug', 'Show debug-level log messages on stderr')
  .option('--cwd <path>', 'Override working directory for this invocation')
  .option('--project <name>', 'Run the command against a linked project (cross_project_links or workspace store-chain child). Resolves via resolveProjectCwd; mutually exclusive with --cwd.')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const root = parseLeadingGlobalOptions(process.argv.slice(2));
    initLogLevel({ verbose: root.verbose, debug: root.debug });

    // Skip effective cwd resolution for commands that create the store
    const cmdName = actionCommand.name();
    const skipResolution = cmdName === 'init' || cmdName === 'setup' || cmdName === 'setup-machine';

    // pln#359 phase 1c — `--project <name>` resolves a linked project to an
    // absolute path via resolveProjectCwd, then feeds the same chdir flow
    // as --cwd. Mutually exclusive with --cwd to avoid ambiguity.
    let explicitCwd: string | undefined = root.cwd;
    if (root.project) {
      if (root.cwd) {
        console.error('Error: --project and --cwd are mutually exclusive. Use one.');
        process.exit(1);
      }
      try {
        explicitCwd = resolveProjectCwd(root.project, process.cwd());
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    if (!skipResolution) {
      // Resolve effective cwd (explicit > BRAINCLAW_PROJECT > active-project > process.cwd)
      const effectiveCwd = resolveEffectiveCwd({ explicitCwd });
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
    } else if (explicitCwd && cmdName !== 'init') {
      // For setup commands, still respect explicit --cwd / --project but nothing else.
      // init receives cwd through runInit options so scaffold writers do not
      // depend on changing process.cwd().
      process.chdir(path.resolve(explicitCwd));
    }
  });

registerLifecycleCommands(program);
registerCaptureCommands(program);
registerPlanningCommands(program);
registerCoordinationCommands(program);
registerReviewCommands(program);
registerMemoryContextCommands(program);
registerFederationCommands(program);
registerCodeMapCommands(program);

// ─── Command-order shim (pln#622 PR5) ────────────────────────────────────────
// Commander renders `--help` in registration order. The per-family register
// modules above would otherwise reorder the help output relative to the
// pre-split monolithic cli.ts — a visible surface change for a pure refactor.
// This manifest freezes the pre-split order (git show of the monolith); the
// stable sort below restores it on the live registry. Any NEW registration not
// listed here is appended at the end in its relative registration order —
// changing that (or editing this manifest) is an explicit product decision,
// not a refactor side effect.
const ORIGINAL_COMMAND_ORDER: string[] = [
  'init',
  'setup',
  'setup-machine',
  'memory-log',
  'memory-rollback',
  'upgrade',
  'patch-configs',
  'machine-profile',
  'agent-inventory',
  'projects',
  'decision',
  'constraint',
  'trap',
  'handoff',
  'status',
  'plan',
  'code-map',
  'move',
  'list-plans',
  'sequence',
  'add-step',
  'complete-step',
  'update-step',
  'delete-step',
  'estimation-report',
  'update-plan',
  'surface-task',
  'delete-plan',
  'update-handoff',
  'doctor',
  'repair',
  'stale',
  'version',
  'release-notes',
  'uninstall',
  'rebuild',
  'reflect',
  'reflect-runtime-note',
  'context',
  'bootstrap',
  'env',
  'memory',
  'instruction',
  'list-instructions',
  'register-agent',
  'enable-agent',
  'list-agents',
  'review',
  'show-candidate',
  'star-candidate',
  'use-candidate',
  'accept',
  'adapter-openclaw-import',
  'reject',
  'harvest-candidates',
  'harvest',
  'prune-candidates',
  'cleanup-candidates',
  'claim',
  'assignment',
  'list-claims',
  'release-claim',
  'release-claims',
  'agent-board',
  'runtime-note',
  'note',
  'runtime-status',
  'sync',
  'check-constraints',
  'check-policy',
  'check-security',
  'setup-security',
  'install-hooks',
  'diff',
  'prune',
  'compact',
  'mcp',
  'set-trust',
  'session-start',
  'session-end',
  'whoami',
  'usage',
  'search',
  'export',
  'refresh',
  'reconcile',
  'hooks',
  'watch',
  'dispatch',
  'inbox',
  'check-events',
  'metrics',
  'rollback',
  'pull',
  'push',
  'audit',
  'history',
  'context-diff',
  'capability',
  'link',
  'tool',
  'explore',
  'discover',
  'migrate',
  'switch',
  'who',
  'worktree',
  'federation',
  // Gated by BRAINCLAW_ENABLE_CODEV: listed here so the order is right in both
  // modes — when not registered they are simply absent from the live array and
  // the sort skips them naturally.
  'codev',
  'codev-metrics',
  'questions',
  'bootstrap-loop',
  'loop',
  'reply',
  'run',
];
{
  const rank = new Map(ORIGINAL_COMMAND_ORDER.map((name, index) => [name, index]));
  // Localized cast: Commander types `commands` as readonly, but reordering the
  // live array is exactly the point of this shim. Array.prototype.sort is
  // stable (ES2019+), so unlisted commands keep their relative registration
  // order after every listed one.
  (program as unknown as { commands: Command[] }).commands.sort(
    (a, b) =>
      (rank.get(a.name()) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.name()) ?? Number.MAX_SAFE_INTEGER),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN SCAFFOLDING (pln#622 PR0c) — TEMPORARY, removed at end of campaign.
// When BRAINCLAW_DUMP_REGISTRY is set, emit a normalized JSON snapshot of
// the fully-built Commander registry and exit BEFORE parsing: value '1'
// prints to stdout (manual debugging); any other value is a FILE PATH the
// JSON is written to — module side effects can interleave writes on stdout
// (observed on Linux CI: corrupted JSON mid-stream), a file write is not
// subject to that race. This
// adds zero visible CLI surface: no new command, option, or help text — it is
// reachable only through an env var that regular users never set. It exists
// solely so tests/unit/cli-registry-snapshot.test.ts can freeze the command
// surface while cli.ts is decomposed (PR1→PR5); the branch goes away in PR6.
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.BRAINCLAW_DUMP_REGISTRY) {
  interface RegistryCommand {
    aliases: string[];
    arguments: { name: string; required: boolean; variadic: boolean }[];
    options: {
      defaultValue?: unknown;
      flags: string;
      long: string | null;
      mandatory: boolean;
      negate: boolean;
      short: string | null;
      valueOptional: boolean;
      valueRequired: boolean;
      variadic: boolean;
    }[];
    path: string;
  }
  // Codepoint comparison (NOT localeCompare) so the committed snapshot is
  // byte-identical across machines/locales.
  const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const commands: RegistryCommand[] = [];
  const walk = (cmd: Command, prefix: string[]): void => {
    const pathTokens = [...prefix, cmd.name()];
    commands.push({
      aliases: [...cmd.aliases()].sort(byCodepoint),
      arguments: cmd.registeredArguments.map((arg) => ({
        name: arg.name(),
        required: arg.required,
        variadic: arg.variadic,
      })),
      options: cmd.options
        .map((opt) => ({
          ...(opt.defaultValue !== undefined ? { defaultValue: opt.defaultValue as unknown } : {}),
          flags: opt.flags,
          long: opt.long ?? null,
          mandatory: opt.mandatory,
          negate: opt.negate,
          short: opt.short ?? null,
          valueOptional: opt.optional,
          valueRequired: opt.required,
          variadic: opt.variadic,
        }))
        .sort((a, b) => byCodepoint(a.flags, b.flags)),
      path: pathTokens.join(' '),
    });
    for (const sub of cmd.commands) walk(sub, pathTokens);
  };
  walk(program, []);
  // topLevelOrder captures the LIVE registration order (what `--help` renders,
  // after the command-order shim above) before the path sort below erases it.
  // The snapshot test asserts it still matches the pre-split monolith order.
  const topLevelOrder = program.commands.map((cmd) => cmd.name());
  commands.sort((a, b) => byCodepoint(a.path, b.path));
  const dump = { commands, topLevelOrder };
  const dumpTarget = process.env.BRAINCLAW_DUMP_REGISTRY!;
  if (dumpTarget === '1') {
    console.log(JSON.stringify(dump, null, 2));
  } else {
    fs.writeFileSync(dumpTarget, JSON.stringify(dump, null, 2), 'utf-8');
  }
  process.exit(0);
}

{
  // Friendly trailing-global-option error must run before Commander parses:
  // with positional options enabled, Commander itself would reject a trailing
  // --cwd/--project as a bare "unknown option" otherwise.
  const argvTail = process.argv.slice(2);
  const guardCommand = findCommandFromArgv(argvTail);
  if (guardCommand) {
    const trailingError = trailingGlobalOptionError(argvTail, guardCommand);
    if (trailingError) {
      console.error(`Error: ${trailingError}`);
      process.exit(1);
    }
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
