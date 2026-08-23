import type { Command } from 'commander';
import { runClaimResource } from '../commands/claim-resource.js';
import { runAssignmentResource } from '../commands/assignment-resource.js';
import { runListClaims } from '../commands/list-claims.js';
import { runReleaseClaim } from '../commands/release-claim.js';
import { runReleaseClaims } from '../commands/release-claims.js';
import { runAgentBoard } from '../commands/agent-board.js';
import { runWatch } from '../commands/watch.js';
import { runDispatchAnalysis, runDispatch, runDispatchReview } from '../commands/dispatch.js';
import { runDispatchWatch } from '../commands/dispatch-watch.js';
import { runInboxList, runInboxAck, runInboxArchive, runInboxSend, runInboxThread } from '../commands/inbox.js';
import { runCheckEvents } from '../commands/check-events.js';
import { runWorktreeCreate, runWorktreeList, runWorktreeRemove, runWorktreePrune, runWorktreeClean, runWorktreeMerge, runWorktreeCheck } from '../commands/worktree.js';
import { runQuestionsCommand, type QuestionStatus } from '../commands/questions.js';
import { runReplyCommand } from '../commands/reply.js';
import { runRunProfile } from '../commands/run-profile.js';

function isCodevEnabled(): boolean {
  return process.env.BRAINCLAW_ENABLE_CODEV === '1';
}

export function registerCoordinationCommands(program: Command): void {
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
    .option('--coordinator-override', 'Trusted+ only: release a claim owned by another agent')
    .option('--store <target>', 'Target store level: local (default), repo, workspace')
    .option('--local-only', 'Read from local store only for list (skip parent stores in chain)')
    .action((subcommand, args, options) => {
      runClaimResource(subcommand, args, {
        ...options,
        planStatus: options.planStatus,
        coordinatorOverride: options.coordinatorOverride,
        localOnly: options.localOnly,
      });
    });

  // --- assignment ---
  program
    .command('assignment <subcommand> [args...]')
    .description('Manage work assignments (list, show, update, cancel)')
    .option('--json', 'Output as JSON for list/show')
    .option('--all', 'Include terminal assignments in list')
    .option('--status <status>', 'Status filter for list or target status for update')
    .option('--agent <agent>', 'Filter by agent name')
    .option('--claim <id>', 'Filter by linked claim ID')
    .option('--plan <id>', 'Filter by linked plan ID')
    .option('--sequence <id>', 'Filter by linked sequence ID')
    .option('--reason <text>', 'Optional status reason for update/cancel')
    .action((subcommand, args, options) => {
      runAssignmentResource(subcommand, args, {
        ...options,
        claim: options.claim,
        plan: options.plan,
        sequence: options.sequence,
      });
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
    .option('--local-only', 'Read from local store only (skip parent stores in chain)')
    .action((options) => {
      runListClaims({ ...options, localOnly: options.localOnly });
    });

  // --- release-claim ---
  program
    .command('release-claim <id>')
    .description('Release a work claim')
    .option('--plan-status <status>', 'Optional linked plan status: todo, in_progress, blocked, done, dropped')
    .option('--coordinator-override', 'Trusted+ only: release a claim owned by another agent')
    .action((id, options) => {
      runReleaseClaim(id, { ...options, coordinatorOverride: options.coordinatorOverride });
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
    .option('--all-agents', 'Show unfiltered board (supervisor mode — all claims, all agents)')
    .action((options) => {
      runAgentBoard(options);
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

  // --- dispatch ---
  const dispatchCmd = program
    .command('dispatch')
    .description('Local agent dispatcher — analyze lanes and assign work');

  dispatchCmd
    .command('analysis')
    .description('Analyze the active sequence: show ready, active, blocked, and done lanes')
    .option('--json', 'Output as JSON')
    .action((options) => {
      runDispatchAnalysis({ json: options.json });
    });

  dispatchCmd
    .command('run')
    .description('Run a dispatch cycle: assign ready lanes to available agents')
    .option('--agents <names>', 'Comma-separated list of agents to dispatch to')
    .option('--lanes <names>', 'Comma-separated list of lanes to dispatch')
    .option('--max <n>', 'Maximum assignments', parseInt)
    .option('--max-concurrency <n>', 'Opt-in cap on concurrent instances per host-binary (default: unlimited)', parseInt)
    .option('--model <name>', 'Model to run, decoupled from agent identity (e.g. --model sonnet)')
    .option('--dry', 'Preview assignments without sending messages')
    .option('--spawn', 'Autonomously launch CLI agents with invoke templates')
    .option('--agent <name>', 'Dispatcher agent name')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await runDispatch({
        agents: options.agents,
        lanes: options.lanes,
        max: options.max,
        maxConcurrency: options.maxConcurrency,
        model: options.model,
        dry: options.dry,
        spawn: options.spawn,
        agent: options.agent,
        json: options.json,
      });
    });

  dispatchCmd
    .command('watch <target>')
    .description('Block until a dispatched worker reaches a terminal state (asgn_/clm_/run_ id) — sentinels, lane-result, committed-clean and worker-process-gone heuristics')
    .option('--interval <seconds>', 'Poll interval in seconds (default 60)', parseInt)
    .option('--timeout <minutes>', 'Give up after N minutes (default 90, exit code 2)', parseInt)
    .option('--base <ref>', 'Base ref for commits-ahead evidence (default master)')
    .option('--json', 'One JSON object per poll line')
    .action(async (target, options) => {
      await runDispatchWatch(target, {
        intervalSeconds: options.interval,
        timeoutMinutes: options.timeout,
        base: options.base,
        json: options.json,
      });
    });

  dispatchCmd
    .command('review')
    .description('Dispatch code reviews for completed handoffs')
    .option('--handoff <id>', 'Specific handoff ID to review')
    .option('--reviewer <name>', 'Specific reviewer agent')
    .option('--spawn', 'Launch the reviewer CLI agent')
    .option('--dry', 'Preview without sending')
    .option('--agent <name>', 'Dispatcher agent name')
    .option('--json', 'Output as JSON')
    .action((options) => {
      runDispatchReview({
        handoff: options.handoff,
        reviewer: options.reviewer,
        spawn: options.spawn,
        dry: options.dry,
        agent: options.agent,
        json: options.json,
      });
    });

  // --- inbox ---
  const inboxCmd = program
    .command('inbox')
    .description('Inter-agent messaging inbox');

  inboxCmd
    .command('list')
    .description('List inbox messages (default: pending only)')
    .option('--agent <name>', 'Agent name')
    .option('--status <status>', 'Filter by status: pending, read, acknowledged, archived')
    .option('--type <type>', 'Filter by type: assign, review, rfc, info, reply')
    .option('--thread <id>', 'Filter by thread ID')
    .option('--all', 'Show all messages, not just pending')
    .option('--json', 'Output as JSON')
    .option('--local-only', 'Read from local store only (skip parent stores in chain)')
    .action((options) => {
      runInboxList({ ...options, localOnly: options.localOnly });
    });

  inboxCmd
    .command('ack <id>')
    .description('Acknowledge a message')
    .option('--agent <name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action((id, options) => {
      runInboxAck(id, options);
    });

  inboxCmd
    .command('archive <id>')
    .description('Archive a message')
    .option('--agent <name>', 'Agent name')
    .option('--json', 'Output as JSON')
    .action((id, options) => {
      runInboxArchive(id, options);
    });

  inboxCmd
    .command('send <to> <text>')
    .description('Send a message to another agent')
    .option('--type <type>', 'Message type: assign, review, rfc, info, reply (default: info)')
    .option('--ref <id>', 'Reference to a plan, sequence, or other entity')
    .option('--scope <path>', 'File scope')
    .option('--thread <id>', 'Thread ID for conversations')
    .option('--ack', 'Require acknowledgment')
    .option('--agent <name>', 'Sender agent name')
    .option('--json', 'Output as JSON')
    .action((to, text, options) => {
      runInboxSend(to, text, options);
    });

  inboxCmd
    .command('thread <id>')
    .description('Show all messages in a thread')
    .option('--json', 'Output as JSON')
    .action((id, options) => {
      runInboxThread(id, options);
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

  worktreeCmd
    .command('clean')
    .description('Remove worktrees whose branch is fully merged and orphan worktree directories')
    .option('--force', 'Force removal even with uncommitted changes')
    .option('--dry-run', 'Show what would be removed without actually removing')
    .action((options) => {
      const globalOpts = program.opts();
      runWorktreeClean({ force: options.force, dryRun: options.dryRun, cwd: globalOpts.cwd });
    });

  worktreeCmd
    .command('merge <branch>')
    .description('Merge a worktree branch with auto-restoration of parasitic deletions')
    .option('-m, --message <message>', 'Merge commit message')
    .option('--dry-run', 'Show what would be merged without committing')
    .action((branch: string, options) => {
      const globalOpts = program.opts();
      runWorktreeMerge({ branch, message: options.message, dryRun: options.dryRun, cwd: globalOpts.cwd });
    });

  worktreeCmd
    .command('check')
    .description('Pre-merge conflict detection: which parallel lanes touch overlapping files, and who owns them (exit 3 if overlaps found)')
    .option('--base <ref>', 'Base ref each lane is diffed against (default: current branch)')
    .option('--json', 'Emit the full risk report as JSON')
    .action((options) => {
      const globalOpts = program.opts();
      runWorktreeCheck({ baseRef: options.base, json: options.json, cwd: globalOpts.cwd });
    });

  // --- codev (legacy experimental) ---
  if (isCodevEnabled()) {
    program
      .command('codev [topic]')
      .description('Experimental legacy ideation session using persona-based consultation')
      .option('--personas <tier>', 'Persona tier: tier1 (default), tier2, or list', 'tier1')
      .option('--checkpoint', 'Pause after clarification for human input')
      .option('--spawn', 'Spawn each consultant as an agent CLI instance')
      .option('--fresh', 'Clear cached responses before starting a new run')
      .option('--agents <list>', 'Comma-separated agent names for spawn (e.g. claude-code,codex,antigravity). Default: auto-detect')
      .option('--rounds <N>', 'Number of discussion rounds in spawn mode (default 3, min 2)', '3')
      .option('--target-duration <seconds>', 'Target duration per round indicated to agents (default 120)', '120')
      .option('--quorum <N>', 'Advance to next round after N agent responses (default: all)')
      .option('--model-map <map>', 'Per-persona model overrides, e.g. simplificateur:sonnet,stratege:opus')
      .option('--metrics', 'Display response timing metrics at end of session')
      .option('--json', 'Output as JSON')
      .action(async (topic, options) => {
        const globalOpts = program.opts();
        const { runCodev } = await import('../commands/codev.js');
        runCodev(topic, {
          ...options,
          rounds: parseInt(options.rounds, 10),
          targetDuration: parseInt(options.targetDuration, 10),
          quorum: options.quorum != null ? parseInt(options.quorum, 10) : undefined,
          cwd: globalOpts.cwd,
        });
      });

    program
      .command('codev-metrics <thread>')
      .description('Show per-agent avg/p95 response metrics for an experimental CoDev thread')
      .option('--json', 'Output as JSON')
      .action(async (thread, options) => {
        const globalOpts = program.opts();
        const { runCodevMetrics } = await import('../commands/codev.js');
        runCodevMetrics(thread, { ...options, cwd: globalOpts.cwd });
      });
  }

  // --- questions (operator-question artifacts across loops; pln#508 step 4) ---
  program
    .command('questions')
    .description('List pending operator_question artifacts across loops in the current project')
    .option('--loop <loop_id>', 'Filter to a single loop')
    .option('--status <status>', 'Filter by status: awaiting (default), answered, timed_out', 'awaiting')
    .option('--mine', 'Filter to questions targeted at the current agent (v1 heuristic: humans see all awaiting)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const globalOpts = program.opts();
      const status = options.status as QuestionStatus;
      if (!['awaiting', 'answered', 'timed_out'].includes(status)) {
        console.error(`Error: --status must be one of awaiting|answered|timed_out (got "${options.status}")`);
        process.exit(1);
      }
      runQuestionsCommand(
        {
          loop: options.loop,
          status,
          mine: options.mine,
          json: options.json,
        },
        globalOpts.cwd,
      );
    });

  // --- bootstrap-loop (open/join/status/cancel a bootstrap loop; pln#513 step 3) ---
  program
    .command('bootstrap-loop')
    .description('Open or join a bootstrap loop on the current project, or query its status')
    .option('--status', 'Report current state')
    .option('--cancel', 'Cancel the active bootstrap loop')
    .option('--yes', 'Skip confirmation prompts')
    .option('--json', 'Machine-readable output')
    .action(async (options) => {
      const globalOpts = program.opts();
      const { runBootstrapLoopCommand } = await import('../commands/bootstrap-loop.js');
      await runBootstrapLoopCommand(options, globalOpts.cwd);
    });

  // --- loop (drive loop turn verbs; pln#517 step 2) ---
  const loopCmd = program
    .command('loop')
    .description('Drive loop turns, fenced takeovers, phase advances, and artifacts');

  loopCmd
    .command('turn <loop_id>')
    .description('Issue a turn assignment on a slot')
    .requiredOption('--slot <slot_id>', 'Target slot id (lsl_...)')
    .option('--input <text>', 'Free-form input passed to the slot')
    .option('--role <role>', 'Slot role (resolves the first non-done slot with that role)')
    .option('--assignment-id <id>', 'Dispatcher-provided assignment id to record on the slot')
    .option('--json', 'Machine-readable output')
    .action(async (loop_id, options) => {
      const globalOpts = program.opts();
      const { runLoopCommand } = await import('../commands/loop.js');
      await runLoopCommand('turn', { loop_id }, options, globalOpts.cwd);
    });

  loopCmd
    .command('complete-turn <loop_id>')
    .description('Complete a slot turn')
    .requiredOption('--slot <slot_id>', 'Target slot id (lsl_...)')
    .requiredOption('--outcome <outcome>', 'Turn outcome: done, failed, or cancelled')
    .option('--failure-reason <text>', 'Reason when outcome is failed')
    .option('--artifact <json>', 'JSON object payload for an artifact to attach')
    .option('--json', 'Machine-readable output')
    .action(async (loop_id, options) => {
      const globalOpts = program.opts();
      const { runLoopCommand } = await import('../commands/loop.js');
      await runLoopCommand('complete-turn', { loop_id }, options, globalOpts.cwd);
    });

  loopCmd
    .command('takeover <loop_id>')
    .description('Fence the active physical run and arm a fresh generation')
    .requiredOption('--slot <slot_id>', 'Target slot id (lsl_...)')
    .requiredOption('--turn-id <turn_id>', 'Stable logical turn id')
    .requiredOption('--expected-epoch <n>', 'Currently active generation epoch')
    .requiredOption('--cause <text>', 'Audited takeover cause')
    .requiredOption('--liveness-evidence <text>', 'Evidence that the prior producer cannot safely continue')
    .requiredOption('--external-effect-policy <policy>', 'none, idempotent, or externally_fenced')
    .requiredOption('--next-workspace-path <path>', 'Existing isolated workspace for the new generation')
    .requiredOption('--agent <agent>', 'Loop coordinator identity')
    .option('--mode <mode>', 'takeover or retry', 'takeover')
    .option('--json', 'Machine-readable output')
    .action(async (loop_id, options) => {
      const globalOpts = program.opts();
      const { runLoopCommand } = await import('../commands/loop.js');
      await runLoopCommand('takeover', { loop_id }, options, globalOpts.cwd);
    });

  loopCmd
    .command('advance <loop_id>')
    .description('Advance a loop to its next phase')
    .option('--to-phase <name>', 'Explicit target phase')
    .option('--force', 'Bypass phase gate checks')
    .option('--reason <text>', 'Reason to record on the phase advance event')
    .option('--json', 'Machine-readable output')
    .action(async (loop_id, options) => {
      const globalOpts = program.opts();
      const { runLoopCommand } = await import('../commands/loop.js');
      await runLoopCommand('advance', { loop_id }, options, globalOpts.cwd);
    });

  loopCmd
    .command('add-artifact <loop_id>')
    .description('Attach an artifact to a loop')
    .requiredOption('--phase <phase>', 'Artifact phase')
    .requiredOption('--type <type>', 'Artifact type')
    .requiredOption('--body <json-or-text>', 'Artifact body as JSON or text')
    .option('--produced-by <agent>', 'Agent that produced the artifact')
    .option('--ref <ref>', 'JSON ref object, e.g. {"kind":"plan","id":"pln_..."}')
    .option('--json', 'Machine-readable output')
    .action(async (loop_id, options) => {
      const globalOpts = program.opts();
      const { runLoopCommand } = await import('../commands/loop.js');
      await runLoopCommand('add-artifact', { loop_id }, options, globalOpts.cwd);
    });

  // --- attempt-authority (two-release writer guard; P4) ---
  const attemptAuthorityCmd = program
    .command('attempt-authority')
    .description('Prepare, acknowledge and activate AttemptAuthority v2 writer compatibility');

  attemptAuthorityCmd
    .command('status')
    .option('--json', 'Machine-readable output')
    .action((options) => {
      const globalOpts = program.opts();
      return import('../commands/attempt-authority.js').then(({ runAttemptAuthorityCommand }) =>
        runAttemptAuthorityCommand('status', { ...options, cwd: globalOpts.cwd }));
    });

  attemptAuthorityCmd
    .command('prepare')
    .requiredOption('--writers <agent_ids...>', 'Complete Release-A writer membership (registered agent ids)')
    .option('--membership-epoch <n>', 'Membership epoch; defaults to active+1')
    .option('--prepared-by <actor>', 'Audited operator/coordinator identity', 'operator')
    .option('--json', 'Machine-readable output')
    .action((options) => {
      const globalOpts = program.opts();
      return import('../commands/attempt-authority.js').then(({ runAttemptAuthorityCommand }) =>
        runAttemptAuthorityCommand('prepare', { ...options, cwd: globalOpts.cwd }));
    });

  attemptAuthorityCmd
    .command('ack')
    .requiredOption('--membership-epoch <n>', 'Prepared membership epoch')
    .requiredOption('--agent-id <agent_id>', 'Writer signing this ACK')
    .option('--json', 'Machine-readable output')
    .action((options) => {
      const globalOpts = program.opts();
      return import('../commands/attempt-authority.js').then(({ runAttemptAuthorityCommand }) =>
        runAttemptAuthorityCommand('ack', { ...options, cwd: globalOpts.cwd }));
    });

  attemptAuthorityCmd
    .command('activate')
    .requiredOption('--membership-epoch <n>', 'Fully acknowledged membership epoch')
    .option('--activated-by <actor>', 'Audited operator/coordinator identity', 'operator')
    .option('--json', 'Machine-readable output')
    .action((options) => {
      const globalOpts = program.opts();
      return import('../commands/attempt-authority.js').then(({ runAttemptAuthorityCommand }) =>
        runAttemptAuthorityCommand('activate', { ...options, cwd: globalOpts.cwd }));
    });

  // --- reply (provide_input to an operator_question; pln#508 step 4) ---
  program
    .command('reply <qst_id>')
    .description('Resolve an operator_question artifact (wraps bclaw_loop.provide_input)')
    .option('--answer <text>', 'Free-form answer text')
    .option('--choose <option_id>', 'Pick one of the question\'s structured options[].id')
    .option('--skip', 'Materialize the question\'s suggested_default')
    .option('--json', 'Output as JSON')
    .action((qstId, options) => {
      const globalOpts = program.opts();
      runReplyCommand(
        qstId,
        {
          answer: options.answer,
          choose: options.choose,
          skip: options.skip,
          json: options.json,
        },
        globalOpts.cwd,
      );
    });

  // --- run (agent profiles) ---
  program
    .command('run [profile-name]')
    .description('Run an agent profile (list profiles if no name given)')
    .option('--dry', 'Print the resolved command without executing')
    .option('--agent <agent>', 'Override the invoke template with a known agent')
    .action((profileName, options) => {
      const globalOpts = program.opts();
      runRunProfile(profileName, { ...options, cwd: globalOpts.cwd });
    });
}
