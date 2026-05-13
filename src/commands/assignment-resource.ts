import { memoryExists } from '../core/io.js';
import { listAssignments, loadAssignment, transitionAssignment } from '../core/assignments.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { AssignmentStatusSchema, type Assignment, type AssignmentStatus } from '../core/schema.js';

export interface AssignmentResourceOptions {
  json?: boolean;
  all?: boolean;
  status?: string;
  agent?: string;
  claim?: string;
  plan?: string;
  sequence?: string;
  reason?: string;
  cwd?: string;
}

const TERMINAL_STATUSES = new Set<AssignmentStatus>(['completed', 'cancelled', 'expired', 'rerouted']);
const KNOWN_SUBCOMMANDS = new Set(['list', 'ls', 'show', 'get', 'update', 'cancel']);

export function runAssignmentResource(subcommand: string, args: string[], options: AssignmentResourceOptions = {}): void {
  const normalized = subcommand.trim().toLowerCase();

  if (normalized === 'list' || normalized === 'ls') {
    runListAssignmentsCommand(options);
    return;
  }

  if (normalized === 'show' || normalized === 'get') {
    const id = args[0];
    if (!id) {
      console.error(`Error: assignment ${normalized} requires <id>.`);
      process.exit(1);
    }
    runShowAssignmentCommand(id, options);
    return;
  }

  if (normalized === 'update') {
    const id = args[0];
    if (!id) {
      console.error('Error: assignment update requires <id>.');
      process.exit(1);
    }
    const status = options.status;
    if (!status) {
      console.error('Error: assignment update requires --status <status>.');
      process.exit(1);
    }
    runTransitionAssignmentCommand(id, status, options);
    return;
  }

  if (normalized === 'cancel') {
    const id = args[0];
    if (!id) {
      console.error('Error: assignment cancel requires <id>.');
      process.exit(1);
    }
    runTransitionAssignmentCommand(id, 'cancelled', options);
    return;
  }

  if (normalized.startsWith('asgn_') || KNOWN_SUBCOMMANDS.has(normalized)) {
    console.error(`Error: unknown assignment subcommand "${subcommand}".`);
    console.error('  Available: list, show, get, update, cancel');
    process.exit(1);
  }

  console.error('Error: missing assignment subcommand.');
  console.error('  Available: list, show, get, update, cancel');
  process.exit(1);
}

function runListAssignmentsCommand(options: AssignmentResourceOptions): void {
  ensureInitialized(options.cwd);

  const requestedStatus = parseAssignmentStatus(options.status);
  let assignments = listAssignments(options.cwd, {
    status: requestedStatus,
    agent: options.agent,
    claim_id: options.claim,
    plan_id: options.plan,
    sequence_id: options.sequence,
  });
  if (!options.all && !requestedStatus) {
    assignments = assignments.filter((assignment) => !TERMINAL_STATUSES.has(assignment.status));
  }

  if (options.json) {
    console.log(JSON.stringify(assignments, null, 2));
    return;
  }

  if (assignments.length === 0) {
    console.log(options.all ? 'No assignments.' : 'No active assignments.');
    return;
  }

  console.log(`${assignments.length} ${options.all ? 'assignment(s)' : 'active assignment(s)'}:`);
  console.log('');
  for (const assignment of assignments) {
    const extras: string[] = [];
    if (assignment.plan_id) extras.push(`plan ${assignment.plan_id}`);
    if (assignment.claim_id) extras.push(`claim ${assignment.claim_id}`);
    if (assignment.sequence_id) extras.push(`sequence ${assignment.sequence_id}`);
    if (assignment.worktree_path) extras.push(`worktree ${assignment.worktree_path}`);
    const suffix = extras.length > 0 ? ` [${extras.join(', ')}]` : '';
    console.log(`  [${assignment.id}] ${assignment.agent} (${assignment.status}) -> ${assignment.scope}: ${assignment.description}${suffix}`);
  }
}

function runShowAssignmentCommand(id: string, options: AssignmentResourceOptions): void {
  ensureInitialized(options.cwd);
  const assignment = requireAssignment(id, options.cwd);

  if (options.json) {
    console.log(JSON.stringify(assignment, null, 2));
    return;
  }

  console.log(`Assignment: ${assignment.id}`);
  console.log(`  Agent:        ${assignment.agent}`);
  console.log(`  Status:       ${assignment.status}`);
  console.log(`  Scope:        ${assignment.scope}`);
  console.log(`  Description:  ${assignment.description}`);
  console.log(`  Claim:        ${assignment.claim_id}`);
  if (assignment.message_id) console.log(`  Message:      ${assignment.message_id}`);
  if (assignment.plan_id) console.log(`  Plan:         ${assignment.plan_id}`);
  if (assignment.sequence_id) console.log(`  Sequence:     ${assignment.sequence_id}`);
  if (assignment.session_id) console.log(`  Session:      ${assignment.session_id}`);
  if (assignment.status_reason) console.log(`  Reason:       ${assignment.status_reason}`);
  if (assignment.worktree_path) console.log(`  Worktree:     ${assignment.worktree_path}`);
  console.log(`  Created:      ${assignment.created_at}`);
  if (assignment.updated_at) console.log(`  Updated:      ${assignment.updated_at}`);
  if (assignment.offered_at) console.log(`  Offered:      ${assignment.offered_at}`);
  if (assignment.accepted_at) console.log(`  Accepted:     ${assignment.accepted_at}`);
  if (assignment.started_at) console.log(`  Started:      ${assignment.started_at}`);
  if (assignment.completed_at) console.log(`  Completed:    ${assignment.completed_at}`);
  if (assignment.cancelled_at) console.log(`  Cancelled:    ${assignment.cancelled_at}`);
  if (assignment.failed_at) console.log(`  Failed:       ${assignment.failed_at}`);
  if (assignment.blocked_at) console.log(`  Blocked:      ${assignment.blocked_at}`);
  if (assignment.timed_out_at) console.log(`  Timed out:    ${assignment.timed_out_at}`);
  if (assignment.expired_at) console.log(`  Expired:      ${assignment.expired_at}`);
  if (assignment.rerouted_at) console.log(`  Rerouted:     ${assignment.rerouted_at}`);
}

function runTransitionAssignmentCommand(id: string, statusInput: string, options: AssignmentResourceOptions): void {
  ensureInitialized(options.cwd);
  const nextStatus = parseAssignmentStatus(statusInput, 'status')!;
  const actor = resolveCurrentAgentName(options.cwd);

  try {
    const result = transitionAssignment(id, nextStatus, {
      actor,
      status_reason: options.reason,
    }, options.cwd);
    const verb = nextStatus === 'cancelled' ? 'cancelled' : 'updated';
    console.log(`✔ Assignment ${verb}: [${result.assignment.id}] ${result.previous_status} -> ${result.assignment.status}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

function ensureInitialized(cwd?: string): void {
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
}

function requireAssignment(id: string, cwd?: string): Assignment {
  const assignment = loadAssignment(id, cwd);
  if (!assignment) {
    console.error(`Error: assignment not found: ${id}`);
    process.exit(1);
  }
  return assignment;
}

function parseAssignmentStatus(value: string | undefined, label: string = 'filter'): AssignmentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = AssignmentStatusSchema.safeParse(value);
  if (!parsed.success) {
    console.error(`Error: invalid ${label} '${value}'. Expected one of: ${AssignmentStatusSchema.options.join(', ')}`);
    process.exit(1);
  }
  return parsed.data;
}
