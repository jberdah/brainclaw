import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CapabilitySnapshotSchema, type CapabilitySnapshot } from '../execution-contract.js';
import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';

/**
 * Additive AttemptAuthority v2 primitive.
 *
 * Immutable launch/close cells are authoritative. `head.json` is deliberately
 * only a rebuildable read cache. Callers may prepare generations and cells in
 * parallel, but publication is one no-clobber hard-link CAS per decision.
 */

export const ATTEMPT_AUTHORITY_VERSION = 2 as const;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const AuthorityHomeSchema = z.object({
  store_instance_id: z.string().min(1),
  device_id: z.string().min(1),
}).strict();

export type AuthorityHome = z.infer<typeof AuthorityHomeSchema>;

export const GenerationFenceSchema = z.object({
  turn_id: z.string().regex(SAFE_PATH_SEGMENT),
  assignment_id: z.string().min(1),
  attempt_epoch: z.number().int().nonnegative(),
  run_id: z.string().min(1),
  launch_nonce: z.string().min(1),
  contract_hash: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_path: z.string().min(1).refine((value) => path.isAbsolute(value), {
    message: 'workspace_path must be absolute',
  }),
  workspace_digest: z.string().min(1),
  authority_home: AuthorityHomeSchema,
}).strict();

export type GenerationFence = z.infer<typeof GenerationFenceSchema>;

export const GenerationExecutorSchema = z.object({
  agent: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  claim_id: z.string().min(1),
  capability_snapshot: CapabilitySnapshotSchema,
}).strict();
export type GenerationExecutor = z.infer<typeof GenerationExecutorSchema>;

export const AttemptGenerationSchema = GenerationFenceSchema.extend({
  schema_version: z.literal(ATTEMPT_AUTHORITY_VERSION),
  generation_kind: z.literal('attempt_generation'),
  /** Executor ownership is generation-scoped so a reroute never inherits stale provenance. */
  executor: GenerationExecutorSchema.optional(),
  created_at: z.string().min(1),
}).strict();

export type AttemptGeneration = z.infer<typeof AttemptGenerationSchema>;

export const LaunchDecisionCellSchema = z.object({
  schema_version: z.literal(ATTEMPT_AUTHORITY_VERSION),
  cell_kind: z.literal('launch_decision'),
  fence: GenerationFenceSchema,
  generation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['crossed', 'revoked']),
  actor: z.string().min(1),
  cause: z.string().min(1),
  decided_at: z.string().min(1),
}).strict();

export type LaunchDecisionCell = z.infer<typeof LaunchDecisionCellSchema>;

const CloseCellBaseSchema = z.object({
  schema_version: z.literal(ATTEMPT_AUTHORITY_VERSION),
  cell_kind: z.literal('close_decision'),
  fence: GenerationFenceSchema,
  generation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.string().min(1),
  cause: z.string().min(1),
  result_digest: z.string().min(1).optional(),
  decided_at: z.string().min(1),
});

const SettledCloseCellSchema = CloseCellBaseSchema.extend({
  decision: z.literal('settled'),
  next_generation: z.never().optional(),
}).strict();

const CancelledCloseCellSchema = CloseCellBaseSchema.extend({
  decision: z.literal('cancelled'),
  next_generation: z.never().optional(),
}).strict();

const TakeoverCloseCellSchema = CloseCellBaseSchema.extend({
  decision: z.literal('takeover'),
  next_generation: AttemptGenerationSchema,
}).strict();

const RetryCloseCellSchema = CloseCellBaseSchema.extend({
  decision: z.literal('retry'),
  next_generation: AttemptGenerationSchema,
}).strict();

export const CloseDecisionCellSchema = z.discriminatedUnion('decision', [
  SettledCloseCellSchema,
  CancelledCloseCellSchema,
  TakeoverCloseCellSchema,
  RetryCloseCellSchema,
]);

export type CloseDecisionCell = z.infer<typeof CloseDecisionCellSchema>;

/** Immutable terminal evidence published before close(epoch)=settled. */
export const AttemptResultEvidenceCellSchema = z.object({
  schema_version: z.literal(ATTEMPT_AUTHORITY_VERSION),
  cell_kind: z.literal('attempt_result_evidence'),
  fence: GenerationFenceSchema,
  result: z.record(z.string(), z.unknown()),
}).strict();
export type AttemptResultEvidenceCell = z.infer<typeof AttemptResultEvidenceCellSchema>;

export const AttemptGenerationHeadSchema = z.object({
  schema_version: z.literal(ATTEMPT_AUTHORITY_VERSION),
  projection_kind: z.literal('attempt_generation_head'),
  authoritative: z.literal(false),
  turn_id: z.string().regex(SAFE_PATH_SEGMENT),
  status: z.enum(['active', 'settled', 'cancelled']),
  latest_epoch: z.number().int().nonnegative(),
  latest_run_id: z.string().min(1),
  active_run_id: z.string().min(1).nullable(),
  latest_generation_digest: z.string().regex(/^[a-f0-9]{64}$/),
  rebuilt_at: z.string().min(1),
}).strict();

export type AttemptGenerationHead = z.infer<typeof AttemptGenerationHeadSchema>;

export class AttemptGenerationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_transition'
      | 'fenced'
      | 'authority_home_mismatch'
      | 'generation_chain_too_deep',
    message: string,
  ) {
    super(message);
    this.name = 'AttemptGenerationError';
  }
}

export class ImmutableCellPublishError extends Error {
  constructor(
    public readonly code: 'hardlink_unsupported' | 'publish_failed' | 'simulated_crash',
    public readonly cell_path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImmutableCellPublishError';
  }
}

export class CorruptAttemptCellError extends Error {
  constructor(public readonly cell_path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CorruptAttemptCellError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function generationDigest(generation: AttemptGeneration): string {
  const parsed = AttemptGenerationSchema.parse(generation);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(parsed))).digest('hex');
}

export function attemptResultEvidenceDigest(cell: AttemptResultEvidenceCell): string {
  const parsed = AttemptResultEvidenceCellSchema.parse(cell);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(parsed))).digest('hex');
}

function stableId(prefix: string, material: string): string {
  const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

/** Compatible with the existing logical Assignment derivation. */
export function deriveGenerationAssignmentId(turnId: string, attemptEpoch = 0): string {
  const salt = attemptEpoch === 0 ? 'assignment' : `assignment:${attemptEpoch}`;
  return stableId('asgn', `${turnId}:${salt}`);
}

/** Epoch zero preserves the existing run id; every later epoch is fresh. */
export function deriveGenerationRunId(turnId: string, attemptEpoch: number): string {
  const salt = attemptEpoch === 0 ? 'run' : `run:${attemptEpoch}`;
  return stableId('run', `${turnId}:${salt}`);
}

export function deriveGenerationWorkspaceId(turnId: string, attemptEpoch: number): string {
  return stableId('wsp', `${turnId}:workspace:${attemptEpoch}`);
}

export interface PrepareInitialGenerationInput {
  turn_id: string;
  authority_home: AuthorityHome;
  contract_hash: string;
  workspace_path: string;
  workspace_digest: string;
  executor?: { agent: string; agent_id?: string; claim_id: string; capability_snapshot: CapabilitySnapshot };
  launch_nonce?: string;
  created_at?: string;
}

export function prepareInitialGeneration(input: PrepareInitialGenerationInput): AttemptGeneration {
  return AttemptGenerationSchema.parse({
    schema_version: ATTEMPT_AUTHORITY_VERSION,
    generation_kind: 'attempt_generation',
    turn_id: input.turn_id,
    assignment_id: deriveGenerationAssignmentId(input.turn_id, 0),
    attempt_epoch: 0,
    run_id: deriveGenerationRunId(input.turn_id, 0),
    launch_nonce: input.launch_nonce ?? crypto.randomUUID(),
    contract_hash: input.contract_hash,
    workspace_id: deriveGenerationWorkspaceId(input.turn_id, 0),
    workspace_path: input.workspace_path,
    workspace_digest: input.workspace_digest,
    authority_home: AuthorityHomeSchema.parse(input.authority_home),
    executor: input.executor,
    created_at: input.created_at ?? nowISO(),
  });
}

export interface PrepareNextGenerationInput {
  contract_hash: string;
  workspace_path: string;
  workspace_digest: string;
  executor?: GenerationExecutor;
  launch_nonce?: string;
  created_at?: string;
}

export function prepareNextGeneration(
  current: AttemptGeneration,
  input: PrepareNextGenerationInput,
): AttemptGeneration {
  const parsed = AttemptGenerationSchema.parse(current);
  const attemptEpoch = parsed.attempt_epoch + 1;
  return AttemptGenerationSchema.parse({
    ...parsed,
    assignment_id: deriveGenerationAssignmentId(parsed.turn_id, attemptEpoch),
    attempt_epoch: attemptEpoch,
    run_id: deriveGenerationRunId(parsed.turn_id, attemptEpoch),
    launch_nonce: input.launch_nonce ?? crypto.randomUUID(),
    contract_hash: input.contract_hash,
    workspace_id: deriveGenerationWorkspaceId(parsed.turn_id, attemptEpoch),
    workspace_path: input.workspace_path,
    workspace_digest: input.workspace_digest,
    executor: input.executor ?? parsed.executor,
    created_at: input.created_at ?? nowISO(),
  });
}

export function fenceForGeneration(generation: AttemptGeneration): GenerationFence {
  const parsed = AttemptGenerationSchema.parse(generation);
  return GenerationFenceSchema.parse({
    turn_id: parsed.turn_id,
    assignment_id: parsed.assignment_id,
    attempt_epoch: parsed.attempt_epoch,
    run_id: parsed.run_id,
    launch_nonce: parsed.launch_nonce,
    contract_hash: parsed.contract_hash,
    workspace_id: parsed.workspace_id,
    workspace_path: parsed.workspace_path,
    workspace_digest: parsed.workspace_digest,
    authority_home: parsed.authority_home,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalWorkspacePath(workspacePath: string): string {
  const absolute = path.resolve(workspacePath);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(absolute);
  } catch {
    canonical = absolute;
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function fenceMatchesGeneration(generation: AttemptGeneration, fence: GenerationFence): boolean {
  return sameJson(fenceForGeneration(generation), GenerationFenceSchema.parse(fence));
}

export function assertFenceMatchesGeneration(generation: AttemptGeneration, fence: GenerationFence): void {
  if (!fenceMatchesGeneration(generation, fence)) {
    throw new AttemptGenerationError('fenced', 'generation fence tuple does not match the active generation');
  }
}

function assertValidSuccessor(current: AttemptGeneration, next: AttemptGeneration): void {
  if (!sameJson(current.authority_home, next.authority_home)) {
    throw new AttemptGenerationError('authority_home_mismatch', 'next generation changes authority_home');
  }
  const invalid = [
    current.turn_id !== next.turn_id && 'turn_id',
    next.assignment_id === current.assignment_id && 'assignment_id',
    next.attempt_epoch !== current.attempt_epoch + 1 && 'attempt_epoch',
    next.run_id === current.run_id && 'run_id',
    next.launch_nonce === current.launch_nonce && 'launch_nonce',
    next.workspace_id === current.workspace_id && 'workspace_id',
    canonicalWorkspacePath(next.workspace_path) === canonicalWorkspacePath(current.workspace_path)
      && 'workspace_path',
  ].find(Boolean);
  if (invalid) {
    throw new AttemptGenerationError('invalid_transition', `invalid generation successor: ${invalid}`);
  }
}

export interface PrepareLaunchDecisionInput {
  decision: 'crossed' | 'revoked';
  actor: string;
  cause: string;
  decided_at?: string;
}

export function prepareLaunchDecision(
  generation: AttemptGeneration,
  input: PrepareLaunchDecisionInput,
): LaunchDecisionCell {
  return LaunchDecisionCellSchema.parse({
    schema_version: ATTEMPT_AUTHORITY_VERSION,
    cell_kind: 'launch_decision',
    fence: fenceForGeneration(generation),
    generation_digest: generationDigest(generation),
    decision: input.decision,
    actor: input.actor,
    cause: input.cause,
    decided_at: input.decided_at ?? nowISO(),
  });
}

export type PrepareCloseDecisionInput =
  | {
      decision: 'settled' | 'cancelled';
      actor: string;
      cause: string;
      result_digest?: string;
      decided_at?: string;
    }
  | {
      decision: 'takeover' | 'retry';
      actor: string;
      cause: string;
      result_digest?: string;
      next_generation: AttemptGeneration;
      decided_at?: string;
    };

export function prepareCloseDecision(
  generation: AttemptGeneration,
  input: PrepareCloseDecisionInput,
): CloseDecisionCell {
  if (input.decision === 'takeover' || input.decision === 'retry') {
    assertValidSuccessor(generation, input.next_generation);
  }
  return CloseDecisionCellSchema.parse({
    schema_version: ATTEMPT_AUTHORITY_VERSION,
    cell_kind: 'close_decision',
    fence: fenceForGeneration(generation),
    generation_digest: generationDigest(generation),
    decision: input.decision,
    actor: input.actor,
    cause: input.cause,
    result_digest: input.result_digest,
    ...((input.decision === 'takeover' || input.decision === 'retry')
      ? { next_generation: input.next_generation }
      : {}),
    decided_at: input.decided_at ?? nowISO(),
  });
}

function attemptDir(cwd: string, turnId: string): string {
  if (!SAFE_PATH_SEGMENT.test(turnId)) throw new Error(`unsafe turn_id path segment: ${turnId}`);
  return path.join(memoryDir(cwd), 'loops', 'attempt-generations', turnId);
}

export function launchDecisionCellPath(cwd: string, turnId: string, attemptEpoch: number): string {
  return path.join(attemptDir(cwd, turnId), `launch-${attemptEpoch}.decision.json`);
}

export function initialGenerationCellPath(cwd: string, turnId: string): string {
  return path.join(attemptDir(cwd, turnId), 'generation-0.json');
}

export function closeDecisionCellPath(cwd: string, turnId: string, attemptEpoch: number): string {
  return path.join(attemptDir(cwd, turnId), `close-${attemptEpoch}.decision.json`);
}

export function attemptResultEvidenceCellPath(cwd: string, turnId: string, attemptEpoch: number, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`unsafe result evidence digest: ${digest}`);
  return path.join(attemptDir(cwd, turnId), `result-${attemptEpoch}-${digest}.json`);
}

export function attemptGenerationHeadPath(cwd: string, turnId: string): string {
  return path.join(attemptDir(cwd, turnId), 'head.json');
}

export interface ImmutablePublishOptions {
  /** Dependency seam used to prove unsupported hard-links fail closed. */
  linkSync?: (existingPath: fs.PathLike, newPath: fs.PathLike) => void;
  /** Fault-injection seam. The fully-fsynced temp is deliberately left behind. */
  simulateCrashAfterTempFsync?: boolean;
}

export interface ImmutablePublishResult<T> {
  won: boolean;
  cell: T;
}

const HARDLINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EPERM', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function readImmutableCell<T>(filePath: string, schema: z.ZodType<T>): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return schema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new CorruptAttemptCellError(filePath, `immutable attempt cell is corrupt: ${filePath}`, { cause: error });
  }
}

function publishImmutableCell<T>(
  finalPath: string,
  cell: T,
  schema: z.ZodType<T>,
  options: ImmutablePublishOptions = {},
): ImmutablePublishResult<T> {
  const parsed = schema.parse(cell);
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(finalPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const fd = fs.openSync(tempPath, 'wx');
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (options.simulateCrashAfterTempFsync) {
    throw new ImmutableCellPublishError(
      'simulated_crash',
      finalPath,
      `simulated crash after temp fsync for ${finalPath}`,
    );
  }

  try {
    (options.linkSync ?? fs.linkSync)(tempPath, finalPath);
    try { fs.unlinkSync(tempPath); } catch { /* orphan cleanup is best-effort */ }
    return { won: true, cell: parsed };
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best-effort */ }
    const code = errorCode(error);
    if (code === 'EEXIST') {
      const incumbent = readImmutableCell(finalPath, schema);
      if (!incumbent) {
        throw new CorruptAttemptCellError(finalPath, `exclusive-create lost but incumbent is absent: ${finalPath}`);
      }
      return { won: false, cell: incumbent };
    }
    if (code && HARDLINK_UNSUPPORTED.has(code)) {
      throw new ImmutableCellPublishError(
        'hardlink_unsupported',
        finalPath,
        `filesystem cannot atomically publish immutable attempt cells via hard-link (${code})`,
        { cause: error },
      );
    }
    throw new ImmutableCellPublishError(
      'publish_failed',
      finalPath,
      `failed to publish immutable attempt cell: ${finalPath}`,
      { cause: error },
    );
  }
}

function validateLaunchCellForGeneration(cell: LaunchDecisionCell, generation: AttemptGeneration): void {
  assertFenceMatchesGeneration(generation, cell.fence);
  if (cell.generation_digest !== generationDigest(generation)) {
    throw new CorruptAttemptCellError('launch decision', 'launch decision generation digest mismatch');
  }
}

function validateCloseCellForGeneration(cell: CloseDecisionCell, generation: AttemptGeneration): void {
  assertFenceMatchesGeneration(generation, cell.fence);
  if (cell.generation_digest !== generationDigest(generation)) {
    throw new CorruptAttemptCellError('close decision', 'close decision generation digest mismatch');
  }
  if (cell.decision === 'takeover' || cell.decision === 'retry') {
    assertValidSuccessor(generation, cell.next_generation);
  }
}

export function publishPreparedLaunchDecision(
  cwd: string,
  generation: AttemptGeneration,
  cell: LaunchDecisionCell,
  options?: ImmutablePublishOptions,
): ImmutablePublishResult<LaunchDecisionCell> {
  const parsedGeneration = AttemptGenerationSchema.parse(generation);
  const parsedCell = LaunchDecisionCellSchema.parse(cell);
  validateLaunchCellForGeneration(parsedCell, parsedGeneration);
  const result = publishImmutableCell(
    launchDecisionCellPath(cwd, parsedGeneration.turn_id, parsedGeneration.attempt_epoch),
    parsedCell,
    LaunchDecisionCellSchema,
    options,
  );
  validateLaunchCellForGeneration(result.cell, parsedGeneration);
  return result;
}

/**
 * Publish the immutable generation-zero anchor. A copied/mutable reservation
 * record is never used as the v2 chain root; every takeover resolves from this
 * no-clobber cell and then follows close(epoch) successors.
 */
export function publishInitialGeneration(
  cwd: string,
  generation: AttemptGeneration,
  options?: ImmutablePublishOptions,
): ImmutablePublishResult<AttemptGeneration> {
  const parsed = AttemptGenerationSchema.parse(generation);
  if (parsed.attempt_epoch !== 0) {
    throw new AttemptGenerationError('invalid_transition', 'initial generation must have attempt_epoch 0');
  }
  const result = publishImmutableCell(
    initialGenerationCellPath(cwd, parsed.turn_id),
    parsed,
    AttemptGenerationSchema,
    options,
  );
  if (!sameJson(result.cell, parsed)) {
    throw new AttemptGenerationError('invalid_transition', `a different generation-zero anchor already exists for ${parsed.turn_id}`);
  }
  return result;
}

export function readInitialGeneration(cwd: string, turnId: string): AttemptGeneration | undefined {
  return readImmutableCell(initialGenerationCellPath(cwd, turnId), AttemptGenerationSchema);
}

export function publishAttemptResultEvidence(
  cwd: string,
  generation: AttemptGeneration,
  result: Record<string, unknown>,
  options?: ImmutablePublishOptions,
): ImmutablePublishResult<AttemptResultEvidenceCell> & { digest: string } {
  const cell = AttemptResultEvidenceCellSchema.parse({
    schema_version: ATTEMPT_AUTHORITY_VERSION,
    cell_kind: 'attempt_result_evidence',
    fence: fenceForGeneration(generation),
    result,
  });
  const digest = attemptResultEvidenceDigest(cell);
  const published = publishImmutableCell(
    attemptResultEvidenceCellPath(cwd, generation.turn_id, generation.attempt_epoch, digest),
    cell,
    AttemptResultEvidenceCellSchema,
    options,
  );
  if (attemptResultEvidenceDigest(published.cell) !== digest) {
    throw new CorruptAttemptCellError('result evidence', 'result evidence digest mismatch');
  }
  return { ...published, digest };
}

export function readAttemptResultEvidence(
  cwd: string,
  turnId: string,
  attemptEpoch: number,
  digest: string,
): AttemptResultEvidenceCell | undefined {
  const cell = readImmutableCell(
    attemptResultEvidenceCellPath(cwd, turnId, attemptEpoch, digest),
    AttemptResultEvidenceCellSchema,
  );
  if (cell && attemptResultEvidenceDigest(cell) !== digest) {
    throw new CorruptAttemptCellError('result evidence', 'result evidence path digest mismatch');
  }
  return cell;
}

export function publishPreparedCloseDecision(
  cwd: string,
  generation: AttemptGeneration,
  cell: CloseDecisionCell,
  options?: ImmutablePublishOptions,
): ImmutablePublishResult<CloseDecisionCell> {
  const parsedGeneration = AttemptGenerationSchema.parse(generation);
  const parsedCell = CloseDecisionCellSchema.parse(cell);
  validateCloseCellForGeneration(parsedCell, parsedGeneration);
  const result = publishImmutableCell(
    closeDecisionCellPath(cwd, parsedGeneration.turn_id, parsedGeneration.attempt_epoch),
    parsedCell,
    CloseDecisionCellSchema,
    options,
  );
  validateCloseCellForGeneration(result.cell, parsedGeneration);
  return result;
}

export function readLaunchDecision(
  cwd: string,
  turnId: string,
  attemptEpoch: number,
): LaunchDecisionCell | undefined {
  return readImmutableCell(
    launchDecisionCellPath(cwd, turnId, attemptEpoch),
    LaunchDecisionCellSchema,
  );
}

export function readCloseDecision(
  cwd: string,
  turnId: string,
  attemptEpoch: number,
): CloseDecisionCell | undefined {
  return readImmutableCell(
    closeDecisionCellPath(cwd, turnId, attemptEpoch),
    CloseDecisionCellSchema,
  );
}

export interface ResolvedGenerationChain {
  latest_generation: AttemptGeneration;
  status: 'active' | 'settled' | 'cancelled';
  terminal_cell?: CloseDecisionCell;
}

export function listAttemptGenerations(cwd: string, initialGeneration: AttemptGeneration): AttemptGeneration[] {
  const generations: AttemptGeneration[] = [];
  let current = AttemptGenerationSchema.parse(initialGeneration);
  for (let depth = 0; depth < 10_000; depth++) {
    generations.push(current);
    const close = readCloseDecision(cwd, current.turn_id, current.attempt_epoch);
    if (!close || (close.decision !== 'takeover' && close.decision !== 'retry')) return generations;
    validateCloseCellForGeneration(close, current);
    current = close.next_generation;
  }
  throw new AttemptGenerationError('generation_chain_too_deep', `attempt generation chain exceeds safety bound for ${initialGeneration.turn_id}`);
}

/** Reconstruct authority exclusively from immutable close cells; head is ignored. */
export function resolveGenerationChain(
  cwd: string,
  initialGeneration: AttemptGeneration,
): ResolvedGenerationChain {
  let current = AttemptGenerationSchema.parse(initialGeneration);
  for (let depth = 0; depth < 10_000; depth++) {
    const close = readCloseDecision(cwd, current.turn_id, current.attempt_epoch);
    if (!close) return { latest_generation: current, status: 'active' };
    validateCloseCellForGeneration(close, current);
    if (close.decision === 'takeover' || close.decision === 'retry') {
      current = close.next_generation;
      continue;
    }
    return {
      latest_generation: current,
      status: close.decision,
      terminal_cell: close,
    };
  }
  throw new AttemptGenerationError(
    'generation_chain_too_deep',
    `attempt generation chain exceeds safety bound for ${initialGeneration.turn_id}`,
  );
}

export function resolveTurnGenerationChain(cwd: string, turnId: string): ResolvedGenerationChain | undefined {
  const initial = readInitialGeneration(cwd, turnId);
  return initial ? resolveGenerationChain(cwd, initial) : undefined;
}

/**
 * Replace the non-authoritative head cache from immutable cells. Failure or
 * corruption of head.json never changes the reconstructed authority.
 */
export function rebuildAttemptGenerationHead(
  cwd: string,
  initialGeneration: AttemptGeneration,
): AttemptGenerationHead {
  const resolved = resolveGenerationChain(cwd, initialGeneration);
  const latest = resolved.latest_generation;
  const head = AttemptGenerationHeadSchema.parse({
    schema_version: ATTEMPT_AUTHORITY_VERSION,
    projection_kind: 'attempt_generation_head',
    authoritative: false,
    turn_id: latest.turn_id,
    status: resolved.status,
    latest_epoch: latest.attempt_epoch,
    latest_run_id: latest.run_id,
    active_run_id: resolved.status === 'active' ? latest.run_id : null,
    latest_generation_digest: generationDigest(latest),
    rebuilt_at: nowISO(),
  });
  writeFileAtomic(attemptGenerationHeadPath(cwd, latest.turn_id), `${JSON.stringify(head, null, 2)}\n`);
  return head;
}

/** Invalid or absent head caches are ignored; callers rebuild from cells. */
export function readAttemptGenerationHead(cwd: string, turnId: string): AttemptGenerationHead | undefined {
  const filePath = attemptGenerationHeadPath(cwd, turnId);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return AttemptGenerationHeadSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}
