import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { memoryDir } from '../io.js';
import { nowISO } from '../ids.js';
import {
  DEFAULT_PROTOCOLS,
  LoopEventSchema,
  LoopThreadSchema,
  type LoopEvent,
  type LoopKind,
  type LoopLinks,
  type LoopPhase,
  type LoopProtocolConfig,
  type LoopSlot,
  type LoopStatus,
  type LoopThread,
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
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
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
  created_by: string;
}

function resolveProtocol(kind: LoopKind, mode: ReviewMode | undefined): LoopProtocolConfig | undefined {
  if (kind === 'review') {
    return { review_mode: mode ?? 'asymmetric' };
  }
  if (mode !== undefined) {
    // mode is only meaningful for review loops today; ignore otherwise.
    return undefined;
  }
  return undefined;
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

function appendEvent(loopId: string, event: LoopEvent, cwd?: string): void {
  const parsed = LoopEventSchema.parse(event);
  ensureLoopsDir(cwd);
  fs.appendFileSync(eventsPath(loopId, cwd), `${JSON.stringify(parsed)}\n`);
}

function writeThread(thread: LoopThread, cwd?: string): void {
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
  const protocol = resolveProtocol(input.kind, input.mode);

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
  writeThread(thread, cwd);

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

export function closeLoop(input: CloseLoopInput, cwd?: string): LoopThread {
  const current = getLoop(input.id, cwd);
  if (!current) {
    throw new Error(`closeLoop: unknown loop_id ${input.id}`);
  }
  if (current.status !== 'open' && current.status !== 'paused') {
    throw new Error(`closeLoop: loop ${input.id} is already ${current.status}`);
  }

  const now = nowISO();
  const mutation_id = generateMutationId();
  const version = current.version + 1;
  const events = listLoopEvents(input.id, cwd);
  const seq = (events[events.length - 1]?.seq ?? 0) + 1;

  const next: LoopThread = {
    ...current,
    version,
    mutation_id,
    status: input.final_status,
    updated_at: now,
    closed_at: now,
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
  writeThread(next, cwd);

  return next;
}
