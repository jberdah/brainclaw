import { memoryExists } from '../core/io.js';
import { handleBclawLoop } from './loops-handlers.js';
import type { NextExpectedHint } from '../core/loops/index.js';

export type LoopSubcommand = 'turn' | 'complete-turn' | 'takeover' | 'advance' | 'add-artifact' | 'continue';

export interface LoopCommandArgs {
  loop_id?: string;
}

export interface LoopCommandOptions {
  slot?: string;
  input?: string;
  role?: string;
  assignmentId?: string;
  runId?: string;
  nonce?: string;
  attemptEpoch?: string | number;
  executionContractHash?: string;
  workspaceDigest?: string;
  outcome?: 'done' | 'failed' | 'cancelled';
  failureReason?: string;
  artifact?: string;
  toPhase?: string;
  force?: boolean;
  reason?: string;
  phase?: string;
  type?: string;
  body?: string;
  producedBy?: string;
  ref?: string;
  json?: boolean;
  turnId?: string;
  expectedEpoch?: string | number;
  cause?: string;
  livenessEvidence?: string;
  externalEffectPolicy?: 'none' | 'idempotent' | 'externally_fenced';
  nextWorkspacePath?: string;
  mode?: 'takeover' | 'retry';
  agent?: string;
  actionIndex?: string | number;
  autonomyMode?: 'autonomous' | 'require_approval' | 'deny';
  risk?: 'normal' | 'protected';
}

export interface LoopCommandResult {
  ok: true;
  action: LoopSubcommand;
  loop_id: string;
  current_phase?: string;
  status?: string;
  next_expected: NextExpectedHint | null;
  auto_closed?: boolean;
}

function fail(message: string, exitCode: 1 | 2, opts: LoopCommandOptions): never {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function requireLoopId(args: LoopCommandArgs, opts: LoopCommandOptions): string {
  const loopId = args.loop_id;
  if (!loopId || !/^lop_[0-9a-z]+$/.test(loopId)) {
    fail(`invalid loop_id "${loopId ?? ''}" — expected format lop_<hex>`, 1, opts);
  }
  return loopId;
}

function requireOption(value: string | undefined, flag: string, opts: LoopCommandOptions): string {
  if (value === undefined || value === '') {
    fail(`${flag} is required`, 1, opts);
  }
  return value;
}

function parseJsonObject(raw: string, flag: string, opts: LoopCommandOptions): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`${flag} must be valid JSON object syntax: ${message}`, 1, opts);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${flag} must be a JSON object`, 1, opts);
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalRef(raw: string | undefined, opts: LoopCommandOptions): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseJsonObject(raw, '--ref', opts);
  if (typeof parsed.kind !== 'string' || typeof parsed.id !== 'string') {
    fail('--ref must be a JSON object with string fields { "kind", "id" }', 1, opts);
  }
  return { kind: parsed.kind, id: parsed.id };
}

function parseBody(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function parseOutcome(opts: LoopCommandOptions): 'done' | 'failed' | 'cancelled' {
  const outcome = opts.outcome;
  if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'cancelled') {
    fail(`--outcome must be one of done|failed|cancelled (got "${outcome ?? ''}")`, 1, opts);
  }
  return outcome;
}

function parseOptionalEpoch(value: string | number | undefined, opts: LoopCommandOptions): number | undefined {
  if (value === undefined) return undefined;
  const epoch = Number(value);
  if (!Number.isInteger(epoch) || epoch < 0) fail('--attempt-epoch must be a non-negative integer', 1, opts);
  return epoch;
}

function formatNextExpected(hint: NextExpectedHint | null): string {
  if (!hint) return '  (loop has no further expected action)';
  const bits: string[] = [`  next: ${hint.action} (${hint.intent})`];
  if (hint.phase) bits.push(`  phase: ${hint.phase}`);
  if (hint.slot_id) bits.push(`  slot: ${hint.slot_id}${hint.role ? ` [${hint.role}]` : ''}`);
  if (hint.from_phase && hint.to_phase) bits.push(`  ${hint.from_phase} -> ${hint.to_phase}`);
  if (hint.blocking_on.length) bits.push(`  blocking_on: ${hint.blocking_on.join(', ')}`);
  if (hint.reason) bits.push(`  reason: ${hint.reason}`);
  return bits.join('\n');
}

function buildRequest(
  subcommand: LoopSubcommand,
  loopId: string,
  opts: LoopCommandOptions,
): Record<string, unknown> {
  switch (subcommand) {
    case 'turn':
      return {
        intent: 'turn',
        loop_id: loopId,
        slot_id: requireOption(opts.slot, '--slot <slot_id>', opts),
        input: requireOption(opts.input, '--input <text>', opts),
        role: opts.role,
        assignment_id: opts.assignmentId,
      };

    case 'complete-turn': {
      const artifact = opts.artifact
        ? parseJsonObject(opts.artifact, '--artifact', opts)
        : undefined;
      return {
        intent: 'complete_turn',
        loop_id: loopId,
        slot_id: requireOption(opts.slot, '--slot <slot_id>', opts),
        assignment_id: opts.assignmentId,
        turn_id: opts.turnId,
        run_id: opts.runId,
        nonce: opts.nonce,
        attempt_epoch: parseOptionalEpoch(opts.attemptEpoch, opts),
        execution_contract_hash: opts.executionContractHash,
        workspace_digest: opts.workspaceDigest,
        outcome: parseOutcome(opts),
        failure_reason: opts.failureReason,
        artifact,
      };
    }

    case 'takeover': {
      const epoch = Number(opts.expectedEpoch);
      if (!Number.isInteger(epoch) || epoch < 0) fail('--expected-epoch must be a non-negative integer', 1, opts);
      return {
        intent: 'takeover',
        loop_id: loopId,
        slot_id: requireOption(opts.slot, '--slot <slot_id>', opts),
        turn_id: requireOption(opts.turnId, '--turn-id <turn_id>', opts),
        expected_epoch: epoch,
        cause: requireOption(opts.cause, '--cause <text>', opts),
        liveness_evidence: requireOption(opts.livenessEvidence, '--liveness-evidence <text>', opts),
        external_effect_policy: requireOption(opts.externalEffectPolicy, '--external-effect-policy <policy>', opts),
        next_workspace_path: requireOption(opts.nextWorkspacePath, '--next-workspace-path <path>', opts),
        takeover_mode: opts.mode,
        agent: opts.agent,
        agentId: opts.agent,
      };
    }

    case 'advance':
      return {
        intent: 'advance',
        loop_id: loopId,
        to_phase: opts.toPhase,
        force: opts.force,
        reason: opts.reason,
      };

    case 'add-artifact':
      return {
        intent: 'add_artifact',
        loop_id: loopId,
        artifact: {
          phase: requireOption(opts.phase, '--phase <phase>', opts),
          type: requireOption(opts.type, '--type <type>', opts),
          body: parseBody(requireOption(opts.body, '--body <json-or-text>', opts)),
          produced_by: opts.producedBy,
          ref: parseOptionalRef(opts.ref, opts),
        },
      };

    case 'continue': {
      const actionIndex = opts.actionIndex === undefined ? 0 : Number(opts.actionIndex);
      if (!Number.isInteger(actionIndex) || actionIndex < 0) fail('--action-index must be a non-negative integer', 1, opts);
      return {
        intent: 'continue',
        loop_id: loopId,
        action_index: actionIndex,
        autonomy_mode: opts.autonomyMode ?? 'autonomous',
        risk: opts.risk ?? 'normal',
      };
    }
  }
}

export async function runLoopCommand(
  subcommand: LoopSubcommand,
  args: LoopCommandArgs,
  options: LoopCommandOptions = {},
  cwd?: string,
): Promise<LoopCommandResult> {
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const loopId = requireLoopId(args, options);
  const request = buildRequest(subcommand, loopId, options);
  const handled = await handleBclawLoop({ args: request, cwd });
  if (handled.response.status !== 'ok') {
    const message = handled.response.error ?? handled.summary;
    fail(`bclaw_loop.${String(request.intent)} rejected the call: ${message}`, 2, options);
  }

  const result = handled.response.result as {
    loop?: { id: string; current_phase?: string; status?: string };
    next_expected?: NextExpectedHint | null;
    auto_closed?: boolean;
  };
  const loop = result.loop;
  const out: LoopCommandResult = {
    ok: true,
    action: subcommand,
    loop_id: loop?.id ?? loopId,
    current_phase: loop?.current_phase,
    status: loop?.status,
    next_expected: result.next_expected ?? null,
    auto_closed: result.auto_closed || undefined,
  };

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
    return out;
  }

  console.log(`OK loop ${subcommand} ${out.loop_id}${out.current_phase ? ` phase=${out.current_phase}` : ''}${out.status ? ` status=${out.status}` : ''}`);
  console.log(formatNextExpected(out.next_expected));
  return out;
}
