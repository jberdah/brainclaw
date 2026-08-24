import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { NextActionSchema, type NextAction } from '../facade-schema.js';
import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import { mutate } from '../mutation-pipeline.js';
import { appendAuditEntry } from '../audit.js';
import { createRuntimeEvent } from '../events.js';
import { artifactEvidenceDigest, validateArtifactEvidence } from './evidence.js';
import { getLoop, listLoops } from './store.js';
import type { LoopArtifact, LoopThread } from './types.js';

export const CONTINUATION_POLICY_VERSION = 'continuation-policy-v1' as const;

export const ContinuationDecisionSchema = z.enum(['auto', 'require_approval', 'deny']);
export type ContinuationDecision = z.infer<typeof ContinuationDecisionSchema>;

export const ContinuationStateSchema = z.enum([
  'proposed',
  'approval_required',
  'denied',
  'applying',
  'applied',
  'failed_recoverable',
]);
export type ContinuationState = z.infer<typeof ContinuationStateSchema>;

const ContinuationOwnerSchema = z.object({
  token: z.string().min(1),
  pid: z.number().int().positive(),
  host_id: z.string().min(1),
  started_at: z.string(),
});

export const ContinuationRecordSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^ctn_[a-f0-9]{24}$/),
  continuation_key: z.string().regex(/^[a-f0-9]{64}$/),
  policy_version: z.literal(CONTINUATION_POLICY_VERSION),
  source_loop_id: z.string().regex(/^lop_[0-9a-z]+$/),
  source_iteration: z.number().int().nonnegative(),
  source_artifact_id: z.string().regex(/^art_[0-9a-z]+$/),
  source_artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  action_index: z.number().int().nonnegative(),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  action: NextActionSchema,
  autonomy_mode: z.enum(['autonomous', 'require_approval', 'deny']),
  risk: z.enum(['normal', 'protected']),
  decision: ContinuationDecisionSchema,
  reason: z.array(z.string().min(1)).min(1),
  state: ContinuationStateSchema,
  downstream: z.object({ kind: z.literal('loop'), id: z.string().regex(/^lop_[0-9a-z]+$/) }).optional(),
  action_required_id: z.string().regex(/^act_[0-9a-z]+$/).optional(),
  owner: ContinuationOwnerSchema.optional(),
  last_error: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ContinuationRecord = z.infer<typeof ContinuationRecordSchema>;

function continuationsDir(cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops', 'continuations');
}

function continuationPath(key: string, cwd?: string): string {
  return path.join(continuationsDir(cwd), `${key}.json`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function writeRecord(record: ContinuationRecord, cwd?: string): void {
  const parsed = ContinuationRecordSchema.parse(record);
  fs.mkdirSync(continuationsDir(cwd), { recursive: true });
  writeFileAtomic(continuationPath(parsed.continuation_key, cwd), `${JSON.stringify(parsed, null, 2)}\n`);
}

export function loadContinuation(idOrKey: string, cwd?: string): ContinuationRecord | undefined {
  const dir = continuationsDir(cwd);
  if (!fs.existsSync(dir)) return undefined;
  if (/^[a-f0-9]{64}$/.test(idOrKey)) {
    const file = continuationPath(idOrKey, cwd);
    if (!fs.existsSync(file)) return undefined;
    return ContinuationRecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const record = ContinuationRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    if (record.id === idOrKey) return record;
  }
  return undefined;
}

export function listContinuations(cwd?: string): ContinuationRecord[] {
  const dir = continuationsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).map((entry) =>
    ContinuationRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))),
  ).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function findDownstream(key: string, cwd?: string): LoopThread | undefined {
  const matches = listLoops({}, cwd).filter((loop) => loop.linked?.continuation_key === key);
  if (matches.length > 1) {
    throw new Error(`continuation_ambiguity: ${key} is linked to ${matches.length} downstream loops`);
  }
  return matches[0];
}

function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return /<[^>]+>/.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  return Boolean(value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(containsPlaceholder));
}

export interface ContinuationProposalInput {
  source_loop: LoopThread;
  source_artifact: LoopArtifact;
  action: NextAction;
  action_index: number;
  autonomy_mode: 'autonomous' | 'require_approval' | 'deny';
  risk: 'normal' | 'protected';
}

export interface ContinuationProposal {
  continuation_key: string;
  source_artifact_digest: string;
  action_hash: string;
  decision: ContinuationDecision;
  reason: string[];
}

export function evaluateContinuation(input: ContinuationProposalInput): ContinuationProposal {
  const evidence = validateArtifactEvidence(input.source_loop, input.source_artifact);
  if (!evidence.valid) throw new Error(`continuation_source_unattested: ${evidence.reasons.join(',')}`);
  if (input.source_artifact.type !== 'plan_draft') throw new Error('continuation_source_invalid: expected plan_draft');
  if (!input.source_artifact.implementation_verify) throw new Error('continuation_source_invalid: missing implementation_verify');
  if (containsPlaceholder(input.action)) throw new Error('continuation_action_placeholder: action is not executable');
  const args = input.action.args ?? {};
  if (input.action.tool !== 'bclaw_loop' || args.intent !== 'open' || args.kind !== 'implementation') {
    throw new Error('continuation_action_unsupported: only Ideation→Implementation is supported');
  }
  if (input.source_loop.kind !== 'ideation') throw new Error('continuation_source_invalid: source loop is not ideation');

  const sourceDigest = artifactEvidenceDigest(input.source_artifact);
  const actionHash = digest(input.action);
  const continuationKey = digest({
    source_loop_id: input.source_loop.id,
    source_iteration: input.source_artifact.iteration ?? input.source_loop.iteration_count,
    source_artifact_digest: sourceDigest,
    canonical_action_hash: actionHash,
    policy_version: CONTINUATION_POLICY_VERSION,
  });
  const decision: ContinuationDecision = input.autonomy_mode === 'deny'
    ? 'deny'
    : input.autonomy_mode === 'require_approval' || input.risk === 'protected'
      ? 'require_approval'
      : 'auto';
  const reason = decision === 'auto'
    ? ['attested ideation plan_draft', 'concrete implementation action', 'normal risk under autonomous mode']
    : decision === 'require_approval'
      ? [input.risk === 'protected' ? 'protected risk requires operator approval' : 'project autonomy mode requires approval']
      : ['project autonomy mode denies continuation'];
  return { continuation_key: continuationKey, source_artifact_digest: sourceDigest, action_hash: actionHash, decision, reason };
}

function ownerAlive(owner: z.infer<typeof ContinuationOwnerSchema>): boolean {
  if (owner.host_id !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function audit(record: ContinuationRecord, before: ContinuationState | undefined, actor: string, actorId: string | undefined, cwd?: string): void {
  appendAuditEntry({
    actor, actor_id: actorId, action: before ? 'update' : 'create', item_id: record.id,
    item_type: 'state', before: before ? { state: before } : undefined,
    after: { state: record.state, decision: record.decision, continuation_key: record.continuation_key, downstream: record.downstream },
  }, cwd);
  createRuntimeEvent({
    agent: actor, agent_id: actorId, event_type: 'observation',
    text: `Continuation ${record.decision}: ${record.source_loop_id} → ${record.downstream?.id ?? record.state}`,
    tags: ['loop-engine', 'continuation', `decision:${record.decision}`, `state:${record.state}`],
    metadata: { protocol: CONTINUATION_POLICY_VERSION, continuation_id: record.id, continuation_key: record.continuation_key },
  }, cwd);
}

export interface EnsureContinuationInput extends ContinuationProposalInput {
  actor: string;
  actor_id?: string;
  execute: (record: ContinuationRecord) => Promise<{ kind: 'loop'; id: string }>;
}

export interface EnsureContinuationResult {
  record: ContinuationRecord;
  reused: boolean;
  executing_elsewhere?: boolean;
}

export async function ensureContinuation(input: EnsureContinuationInput, cwd?: string): Promise<EnsureContinuationResult> {
  const proposal = evaluateContinuation(input);
  const prepared = mutate({ cwd }, () => {
    const existing = loadContinuation(proposal.continuation_key, cwd);
    if (existing && existing.action_hash !== proposal.action_hash) {
      throw new Error(`continuation_key_conflict: stored=${existing.action_hash} submitted=${proposal.action_hash}`);
    }
    const downstream = findDownstream(proposal.continuation_key, cwd);
    if (downstream) {
      const next = existing
        ? { ...existing, state: 'applied' as const, downstream: { kind: 'loop' as const, id: downstream.id }, owner: undefined, updated_at: nowISO() }
        : undefined;
      if (!next) throw new Error('continuation_projection_missing: downstream exists without a continuation record');
      writeRecord(next, cwd);
      return { record: next, shouldExecute: false, reused: true };
    }
    if (existing?.state === 'applied' && existing.downstream) return { record: existing, shouldExecute: false, reused: true };
    if (existing?.state === 'denied' || existing?.state === 'approval_required') {
      return { record: existing, shouldExecute: false, reused: true };
    }
    if (existing?.state === 'applying' && existing.owner && ownerAlive(existing.owner)) {
      return { record: existing, shouldExecute: false, reused: true, executingElsewhere: true };
    }
    const now = nowISO();
    const owner = { token: crypto.randomUUID(), pid: process.pid, host_id: os.hostname(), started_at: now };
    const base: ContinuationRecord = existing ?? {
      schema_version: 1,
      id: `ctn_${proposal.continuation_key.slice(0, 24)}`,
      continuation_key: proposal.continuation_key,
      policy_version: CONTINUATION_POLICY_VERSION,
      source_loop_id: input.source_loop.id,
      source_iteration: input.source_artifact.iteration ?? input.source_loop.iteration_count,
      source_artifact_id: input.source_artifact.artifact_id,
      source_artifact_digest: proposal.source_artifact_digest,
      action_index: input.action_index,
      action_hash: proposal.action_hash,
      action: input.action,
      autonomy_mode: input.autonomy_mode,
      risk: input.risk,
      decision: proposal.decision,
      reason: proposal.reason,
      state: 'proposed',
      created_at: now,
      updated_at: now,
    };
    const state: ContinuationState = proposal.decision === 'deny' ? 'denied' : proposal.decision === 'require_approval' ? 'approval_required' : 'applying';
    const record: ContinuationRecord = {
      ...base,
      decision: proposal.decision,
      reason: existing?.reason ?? proposal.reason,
      state,
      owner: state === 'applying' ? owner : undefined,
      updated_at: now,
    };
    writeRecord(record, cwd);
    audit(record, existing?.state, input.actor, input.actor_id, cwd);
    return { record, shouldExecute: state === 'applying', reused: Boolean(existing) };
  });
  if (!prepared.shouldExecute) {
    return { record: prepared.record, reused: prepared.reused, executing_elsewhere: prepared.executingElsewhere };
  }
  try {
    const downstream = await input.execute(prepared.record);
    const committed = mutate({ cwd }, () => {
      const current = loadContinuation(prepared.record.continuation_key, cwd);
      if (!current) throw new Error('continuation_record_disappeared');
      if (current.owner?.token !== prepared.record.owner?.token) throw new Error('continuation_owner_fenced');
      const record: ContinuationRecord = { ...current, state: 'applied', downstream, owner: undefined, updated_at: nowISO() };
      writeRecord(record, cwd);
      audit(record, current.state, input.actor, input.actor_id, cwd);
      return record;
    });
    return { record: committed, reused: prepared.reused };
  } catch (error) {
    mutate({ cwd }, () => {
      const current = loadContinuation(prepared.record.continuation_key, cwd);
      if (!current || current.owner?.token !== prepared.record.owner?.token) return;
      const record: ContinuationRecord = { ...current, state: 'failed_recoverable', owner: undefined, last_error: error instanceof Error ? error.message : String(error), updated_at: nowISO() };
      writeRecord(record, cwd);
      audit(record, current.state, input.actor, input.actor_id, cwd);
    });
    throw error;
  }
}

export function attachContinuationActionRequired(continuationId: string, actionId: string, actor: string, actorId?: string, cwd?: string): ContinuationRecord {
  return mutate({ cwd }, () => {
    const current = loadContinuation(continuationId, cwd);
    if (!current) throw new Error(`unknown continuation ${continuationId}`);
    if (current.state !== 'approval_required') throw new Error(`continuation ${continuationId} is ${current.state}, not approval_required`);
    if (current.action_required_id && current.action_required_id !== actionId) throw new Error('continuation_action_required_conflict');
    const record = { ...current, action_required_id: actionId, updated_at: nowISO() };
    writeRecord(record, cwd);
    audit(record, current.state, actor, actorId, cwd);
    return record;
  });
}

export function denyContinuation(continuationId: string, reason: string, actor: string, actorId?: string, cwd?: string): ContinuationRecord {
  return mutate({ cwd }, () => {
    const current = loadContinuation(continuationId, cwd);
    if (!current) throw new Error(`unknown continuation ${continuationId}`);
    if (current.state === 'applied') throw new Error(`continuation ${continuationId} is already applied`);
    if (current.state === 'denied') return current;
    const record: ContinuationRecord = {
      ...current,
      decision: 'deny',
      state: 'denied',
      owner: undefined,
      reason: [...current.reason, reason],
      updated_at: nowISO(),
    };
    writeRecord(record, cwd);
    audit(record, current.state, actor, actorId, cwd);
    return record;
  });
}

export async function resumeApprovedContinuation(
  continuationId: string,
  actionId: string,
  actor: string,
  actorId: string | undefined,
  execute: (record: ContinuationRecord) => Promise<{ kind: 'loop'; id: string }>,
  cwd?: string,
): Promise<EnsureContinuationResult> {
  const record = loadContinuation(continuationId, cwd);
  if (!record) throw new Error(`unknown continuation ${continuationId}`);
  if (record.action_required_id !== actionId) throw new Error('continuation_approval_mismatch');
  const source = getLoop(record.source_loop_id, cwd);
  const artifact = source?.artifacts.find((item) => item.artifact_id === record.source_artifact_id);
  if (!source || !artifact) throw new Error('continuation_source_missing');
  mutate({ cwd }, () => {
    const fresh = loadContinuation(continuationId, cwd)!;
    if (fresh.state === 'applied') return;
    if (fresh.state !== 'approval_required' && fresh.state !== 'failed_recoverable') throw new Error(`continuation ${continuationId} is ${fresh.state}`);
    writeRecord({ ...fresh, state: 'failed_recoverable', autonomy_mode: 'autonomous', decision: 'auto', reason: [...fresh.reason, `approved by ${actor}`], updated_at: nowISO() }, cwd);
  });
  return ensureContinuation({
    source_loop: source, source_artifact: artifact, action: record.action, action_index: record.action_index,
    autonomy_mode: 'autonomous', risk: 'normal', actor, actor_id: actorId, execute,
  }, cwd);
}
