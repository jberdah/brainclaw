import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import { writeProjectMdSafe } from './hooks/bootstrap-write.js';
import { notifyOperatorOnInputRequested } from './hooks/notify-operator.js';
import {
  DEFAULT_PROTOCOLS,
  LoopArtifactSchema,
  LoopEventSchema,
  LoopThreadSchema,
  type LoopArtifact,
  type LoopEvent,
  type LoopKind,
  type LoopLinks,
  type LoopPhase,
  type LoopProtocolConfig,
  type LoopSlot,
  type LoopStatus,
  type LoopThread,
  type OperatorQuestionBody,
  type ReviewMode,
  type StopCondition,
} from './types.js';

function loopsDir(cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops');
}

function threadsDir(cwd?: string): string {
  return path.join(loopsDir(cwd), 'threads');
}

function eventsDir(cwd?: string): string {
  return path.join(loopsDir(cwd), 'events');
}

export function ensureLoopsDir(cwd?: string): void {
  const dirs = [loopsDir(cwd), threadsDir(cwd), eventsDir(cwd)];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function threadPath(id: string, cwd?: string): string {
  return path.join(threadsDir(cwd), `${id}.json`);
}

function eventsPath(id: string, cwd?: string): string {
  return path.join(eventsDir(cwd), `${id}.jsonl`);
}

function writeAtomic(filePath: string, contents: string): void {
  writeFileAtomic(filePath, contents);
}

function randomIdSegment(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function generateLoopId(): `lop_${string}` {
  return `lop_${randomIdSegment()}`;
}

export function generateSlotId(): `lsl_${string}` {
  return `lsl_${randomIdSegment()}`;
}

export function generateMutationId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export interface OpenLoopInput {
  kind: LoopKind;
  title: string;
  goal?: string;
  phases?: LoopPhase[];
  slots?: Array<Partial<LoopSlot> & { role: string }>;
  linked?: LoopLinks;
  stop_condition?: StopCondition;
  mode?: ReviewMode;
  /**
   * pln#511 step 2 — explicit protocol override. When set, this is the
   * exact LoopProtocolConfig written to the thread; it bypasses the
   * kind+mode-derived default from resolveProtocol(). Callers using a
   * loop preset (e.g. bootstrap) pass the preset's `protocol` here so
   * fields like `preset`, `max_operator_questions`, `max_pause_duration`
   * land on the thread. Existing callers (review, ideation defaults)
   * keep working unchanged — leaving this undefined preserves the
   * kind-default protocol behavior.
   */
  protocol?: LoopProtocolConfig;
  created_by: string;
}

function resolveProtocol(kind: LoopKind, mode: ReviewMode | undefined): LoopProtocolConfig | undefined {
  // pln#492 phase 2.b — carry the iteration block from DEFAULT_PROTOCOLS
  // into the thread's protocol so advance() / iteration-engine see it.
  const iteration = DEFAULT_PROTOCOLS[kind].iteration;

  if (kind === 'review') {
    return { review_mode: mode ?? 'asymmetric' };
  }
  if (mode !== undefined) {
    // mode is only meaningful for review loops today; ignore otherwise.
    return iteration ? { iteration } : undefined;
  }
  return iteration ? { iteration } : undefined;
}

function buildSlot(partial: Partial<LoopSlot> & { role: string }): LoopSlot {
  return {
    slot_id: partial.slot_id ?? generateSlotId(),
    role: partial.role,
    agent: partial.agent,
    agent_id: partial.agent_id,
    assignment_id: partial.assignment_id,
    claim_id: partial.claim_id,
    phase: partial.phase,
    status: partial.status ?? 'open',
  };
}

export function appendEvent(
  loopId: string,
  event: LoopEvent,
  cwd?: string,
  /**
   * pln#513 Phase 4 codex review fix — callers can pass the in-memory next
   * thread snapshot when they're about to write it. Without this, the
   * notification hook's `getLoop(loopId)` read sees the PREVIOUS thread
   * because `appendEvent` runs before `writeThreadFile` at the verb call
   * sites — meaning the just-added operator_question artifact isn't
   * reachable, and the OS notification can't include the question text.
   * Optional + additive: existing callers (and future ones that don't
   * benefit) keep the disk-read fallback below.
   */
  threadSnapshot?: LoopThread,
): void {
  const parsed = LoopEventSchema.parse(event);
  ensureLoopsDir(cwd);
  fs.appendFileSync(eventsPath(loopId, cwd), `${JSON.stringify(parsed)}\n`);

  // pln#513 step 4 — best-effort OS notification on input_requested events.
  // Prefer the in-memory snapshot from the caller (carries the freshly-
  // added operator_question). Fall back to a disk read so any direct
  // appendEvent caller without a snapshot still gets best-effort scoping.
  if (parsed.kind === 'input_requested') {
    try {
      const loop = threadSnapshot ?? getLoop(loopId, cwd);
      if (loop) notifyOperatorOnInputRequested(parsed, loop, cwd);
    } catch {
      // hook is best-effort; never propagate.
    }
  }
}

export function writeThreadFile(thread: LoopThread, cwd?: string): void {
  const parsed = LoopThreadSchema.parse(thread);
  ensureLoopsDir(cwd);
  writeAtomic(threadPath(parsed.id, cwd), `${JSON.stringify(parsed, null, 2)}\n`);
}

export function openLoop(input: OpenLoopInput, cwd?: string): LoopThread {
  const protocolDefaults = DEFAULT_PROTOCOLS[input.kind];
  const phases = input.phases ?? protocolDefaults.phases;
  if (phases.length === 0) {
    throw new Error('openLoop: phases must be non-empty');
  }
  const phaseNames = new Set(phases.map((p) => p.name));
  if (phaseNames.size !== phases.length) {
    throw new Error('openLoop: phase names must be unique');
  }

  const now = nowISO();
  const id = generateLoopId();
  const mutation_id = generateMutationId();
  const slots: LoopSlot[] = (input.slots ?? []).map(buildSlot);
  // pln#511 step 2 — an explicit `protocol` override (carried by loop
  // presets) wins over the kind/mode-derived default. When no override
  // is supplied, fall back to the legacy resolveProtocol() path so
  // existing callers (review, default ideation) are unaffected.
  const protocol = input.protocol ?? resolveProtocol(input.kind, input.mode);

  const thread: LoopThread = {
    schema_version: 1,
    id,
    version: 1,
    mutation_id,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    protocol,
    status: 'open',
    phases,
    current_phase: phases[0].name,
    iteration_count: 0,
    slots,
    artifacts: [],
    // pln#508 step 1 — bootstrap loop primitives. Default to no open
    // questions; the request_input handler (step 2) appends/removes ids.
    open_questions: [],
    linked: input.linked,
    stop_condition: input.stop_condition ?? protocolDefaults.stop_condition,
    created_at: now,
    updated_at: now,
    created_by: input.created_by,
  };

  appendEvent(
    id,
    {
      event_id: crypto.randomUUID(),
      loop_id: id,
      seq: 1,
      at: now,
      by: input.created_by,
      mutation_id,
      kind: 'opened',
      initial_phase: thread.current_phase,
      created_by: input.created_by,
    },
    cwd,
  );
  writeThreadFile(thread, cwd);

  return thread;
}

export function getLoop(id: string, cwd?: string): LoopThread | undefined {
  const filePath = threadPath(id, cwd);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, 'utf8');
  return LoopThreadSchema.parse(JSON.parse(raw));
}

export function listLoops(
  filters: { kind?: LoopKind; status?: LoopStatus } = {},
  cwd?: string,
): LoopThread[] {
  const dir = threadsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const loops: LoopThread[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const loop = LoopThreadSchema.parse(JSON.parse(raw));
      if (filters.kind && loop.kind !== filters.kind) continue;
      if (filters.status && loop.status !== filters.status) continue;
      loops.push(loop);
    } catch {
      // Skip malformed files; the CAS/replay layer will surface diagnostics.
    }
  }
  return loops.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function listLoopEvents(id: string, cwd?: string): LoopEvent[] {
  const filePath = eventsPath(id, cwd);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => LoopEventSchema.parse(JSON.parse(line)));
}

export interface CloseLoopInput {
  id: string;
  final_status: Exclude<LoopStatus, 'open' | 'paused'>;
  reason?: string;
  actor: string;
}

/**
 * pln#512 step 2 — sentinel thrown by closeLoop when the bootstrap close
 * hook intercepts an attempt to complete an overwrite of an existing
 * non-empty PROJECT.md. The thread is left in `status='paused'` with
 * `pause_reason='awaiting_file_apply'` and a fresh operator_question on
 * `open_questions`; the caller is expected to surface that question to the
 * operator, then re-attempt the close once an answer is provided (or rely on
 * the provideInput post-hook to auto-complete the close — see verbs.ts).
 *
 * Thrown with a stable `code` field so callers can `if (e.code ===
 * 'awaiting_file_apply_approval') ...` instead of string-matching the
 * message.
 */
export class AwaitingFileApplyApprovalError extends Error {
  readonly code = 'awaiting_file_apply_approval' as const;
  constructor(
    public readonly loop_id: string,
    public readonly question_id: string,
    public readonly target_path: string,
    public readonly diff_artifact_id: string,
  ) {
    super(
      `closeLoop: awaiting_file_apply_approval — loop ${loop_id} paused on question ${question_id} ` +
      `for overwrite of ${target_path}; provide_input(replies_to=${question_id}, chosen_option_id=approve|reject) to resolve`,
    );
    this.name = 'AwaitingFileApplyApprovalError';
  }
}

/**
 * pln#512 step 2 — builds the operator_question artifact that asks the
 * operator whether to overwrite an existing PROJECT.md with the loop's
 * `project_md_final`. The question shape is fixed (Phase 0 spec §3-5): two
 * options `approve` / `reject`, default `reject`, pause_scope='loop',
 * on_timeout='use_default'.
 *
 * Returns the (Schema-validated) artifact + its question_id so the caller
 * can splice it onto the thread and push the id into `open_questions`.
 */
function buildFileOverwriteApprovalQuestion(args: {
  phase: string;
  slot_id: string;
  produced_by: string;
  target_path: string;
  project_md_final_id: string;
  now: string;
}): { artifact: LoopArtifact; question_id: string } {
  const question_id = `qst_${crypto.randomBytes(6).toString('hex')}`;
  const body: OperatorQuestionBody = {
    question_id,
    question_text: 'Apply the proposed PROJECT.md diff?',
    evidence: [
      `existing PROJECT.md at ${args.target_path}`,
      `project_md_final artifact ${args.project_md_final_id}`,
    ],
    suggested_default: 'reject',
    options: [
      { id: 'approve', label: 'Apply diff', tradeoff: 'overwrites current PROJECT.md' },
      { id: 'reject', label: 'Keep current', tradeoff: 'discards proposed final' },
    ],
    pause_scope: 'loop',
    on_timeout: 'use_default',
    by_slot_id: args.slot_id,
  };
  const artifact = LoopArtifactSchema.parse({
    artifact_id: `art_${crypto.randomBytes(6).toString('hex')}`,
    phase: args.phase,
    type: 'operator_question',
    body: JSON.stringify(body),
    produced_by: args.produced_by,
    produced_at: args.now,
  });
  return { artifact, question_id };
}

export function closeLoop(input: CloseLoopInput, cwd?: string): LoopThread {
  const current = getLoop(input.id, cwd);
  if (!current) {
    throw new Error(`closeLoop: unknown loop_id ${input.id}`);
  }
  if (current.status !== 'open' && current.status !== 'paused') {
    throw new Error(`closeLoop: loop ${input.id} is already ${current.status}`);
  }

  // pln#512 step 2 — bootstrap preset close pre-hook. When completing a
  // bootstrap loop, materialize PROJECT.md from the final artifact:
  //   - absent / empty target → atomic write, proceed with close.
  //   - present + non-empty target → pause the close, request operator
  //     approval for the overwrite; provideInput post-hook resumes + closes.
  //   - no project_md_final artifact → proceed (nothing to write).
  //
  // Only runs when final_status='completed' — cancel/blocked paths skip
  // the hook because the operator didn't actually converge on a PROJECT.md.
  const runBootstrapHook =
    input.final_status === 'completed' && current.protocol?.preset === 'bootstrap';

  let fileWritten = false;
  let project_md_final_id: string | undefined;

  if (runBootstrapHook) {
    const writeResult = writeProjectMdSafe(current, cwd);
    // Locate the project_md_final artifact id used by the hook (for the
    // file_apply_requested / file_apply_resolved event correlation field).
    for (let i = current.artifacts.length - 1; i >= 0; i--) {
      if (current.artifacts[i].type === 'project_md_final') {
        project_md_final_id = current.artifacts[i].artifact_id;
        break;
      }
    }

    if (writeResult.needs_approval) {
      if (!writeResult.diff_artifact) {
        throw new Error(
          `closeLoop: writeProjectMdSafe returned needs_approval without a diff_artifact — invariant violation`,
        );
      }
      if (!project_md_final_id) {
        throw new Error(
          `closeLoop: writeProjectMdSafe returned needs_approval but no project_md_final artifact found on loop ${current.id}`,
        );
      }
      const slot = current.slots[0];
      if (!slot) {
        throw new Error(
          `closeLoop: bootstrap loop ${current.id} has no slots — cannot synthesize operator_question for file_overwrite_approval`,
        );
      }

      const pauseNow = nowISO();
      const pauseMutationId = generateMutationId();
      const pauseVersion = current.version + 1;
      const eventsSoFar = listLoopEvents(input.id, cwd);
      let pauseSeq = (eventsSoFar[eventsSoFar.length - 1]?.seq ?? 0) + 1;

      const { artifact: questionArtifact, question_id } = buildFileOverwriteApprovalQuestion({
        phase: current.current_phase,
        slot_id: slot.slot_id,
        produced_by: slot.agent_id ?? slot.agent ?? input.actor,
        target_path: writeResult.target_path,
        project_md_final_id,
        now: pauseNow,
      });

      const pausedThread: LoopThread = {
        ...current,
        version: pauseVersion,
        mutation_id: pauseMutationId,
        status: 'paused',
        pause_reason: 'awaiting_file_apply',
        pending_file_apply: {
          artifact_id: project_md_final_id,
          target_path: writeResult.target_path,
          diff_artifact_id: writeResult.diff_artifact.artifact_id,
        },
        artifacts: [...current.artifacts, writeResult.diff_artifact, questionArtifact],
        open_questions: [...current.open_questions, question_id],
        updated_at: pauseNow,
      };

      appendEvent(
        current.id,
        {
          event_id: crypto.randomUUID(),
          loop_id: current.id,
          seq: pauseSeq,
          at: pauseNow,
          by: input.actor,
          mutation_id: pauseMutationId,
          kind: 'file_apply_requested',
          artifact_id: project_md_final_id,
          target_path: writeResult.target_path,
        },
        cwd,
      );
      pauseSeq += 1;
      appendEvent(
        current.id,
        {
          event_id: crypto.randomUUID(),
          loop_id: current.id,
          seq: pauseSeq,
          at: pauseNow,
          by: input.actor,
          mutation_id: pauseMutationId,
          kind: 'input_requested',
          question_id,
          pause_scope: 'loop',
          by_slot_id: slot.slot_id,
        },
        cwd,
        // pln#513 phase 4 codex review fix — pass the paused-thread snapshot
        // so the notification hook reads the freshly-added file_overwrite
        // operator_question rather than the previous on-disk thread.
        pausedThread,
      );

      writeThreadFile(pausedThread, cwd);
      throw new AwaitingFileApplyApprovalError(
        current.id,
        question_id,
        writeResult.target_path,
        writeResult.diff_artifact.artifact_id,
      );
    }

    fileWritten = writeResult.written === true;
  }

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const events = listLoopEvents(input.id, cwd);
  let seq = (events[events.length - 1]?.seq ?? 0) + 1;

  // Emit file_apply_resolved(approved=true) BEFORE the closed event when
  // the bootstrap hook wrote the file directly (absent/empty target). The
  // synthetic event documents that the close went through without operator
  // intervention so the journal reads symmetrically with the paused-then-
  // approved branch.
  if (runBootstrapHook && fileWritten && project_md_final_id) {
    appendEvent(
      current.id,
      {
        event_id: crypto.randomUUID(),
        loop_id: current.id,
        seq,
        at: now,
        by: input.actor,
        mutation_id,
        kind: 'file_apply_resolved',
        artifact_id: project_md_final_id,
        approved: true,
      },
      cwd,
    );
    seq += 1;
  }

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    status: input.final_status,
    updated_at: now,
    closed_at: now,
    // pln#508 step 3 — schema invariant requires pause_reason /
    // pending_file_apply to be absent outside status='paused'. closeLoop on
    // a paused thread must clear both, otherwise LoopThreadSchema.parse
    // rejects the write.
    pause_reason: undefined,
    pending_file_apply: undefined,
  };

  appendEvent(
    input.id,
    {
      event_id: crypto.randomUUID(),
      loop_id: input.id,
      seq,
      at: now,
      by: input.actor,
      mutation_id,
      kind: 'closed',
      final_status: input.final_status,
      reason: input.reason,
    },
    cwd,
  );
  writeThreadFile(next, cwd);

  return next;
}
