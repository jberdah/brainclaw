/**
 * Federation outbox — durable queue for signed edge → cloud runtime writes
 * (pln#101 Phase 2, increment 1: CLAIM). Design of record: decision dec#123.
 *
 * Layout under `.brainclaw/coordination/federation/`:
 *   outbox/<id>@r<rev>.json   — pending, awaiting push
 *   sent/<id>@r<rev>.json     — archived after a successful/superseded push (the marker)
 *   parked/<id>@r<rev>.json   — dead-letter (conflict / persistent 4xx)
 *
 * Enqueue is DIFF-BASED at the claim persistence chokepoint (saveClaimUnlocked),
 * which runs under the store mutation mutex, so per-claim rev reservation is
 * serialized for free (no separate lock). Only lifecycle transitions enqueue;
 * mid-life saves (same status) and cloud-origin materialization (suppressEnqueue)
 * do not. All work here is local file I/O — never network.
 *
 * @module
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowISO } from './ids.js';
import { resolveEntityDir } from './io.js';
import { isCloudSyncEnabled } from './federation-cloud.js';
import { logger } from './logger.js';
import type { Claim, ClaimStatus } from './schema.js';

export interface ClaimCloudPayload {
  id: string;
  rev: number;
  // NOTE: agent_id is intentionally omitted — the cloud binds it to the signed
  // agent's identity (signature.agentId = the CLOUD agent id), which differs
  // from the local identity id. Sending the local id would trip the cloud's
  // AGENT_ID_MISMATCH guard. agent_name is a free label and is kept.
  agent_name: string;
  scope: string;
  description: string;
  status: ClaimStatus;
  plan_id: string | null;
  host_id: string | null;
  session_id: string | null;
  expires_at: string | null;
  worktree_path: string | null;
  created_at: string;
  released_at: string | null;
  content_hash: string;
}

export interface OutboxRecord {
  op: 'upsert_claim';
  entity_type: 'claim';
  entity_id: string;
  rev: number;
  from_status: ClaimStatus | null;
  to_status: ClaimStatus;
  content_hash: string;
  payload: ClaimCloudPayload;
  enqueued_at: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
}

export interface LoadedRecord {
  record: OutboxRecord;
  filepath: string;
}

// ── Directories ─────────────────────────────────────────────────────────────

function federationSubdir(sub: 'outbox' | 'sent' | 'parked', cwd: string | undefined, mode: 'read' | 'write'): string {
  return resolveEntityDir(`federation/${sub}`, cwd ?? process.cwd(), mode);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Canonical content hash (edge is the sole computer; cloud stores+compares) ──

/** Deterministic JSON with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Canonical content hash of a claim's SEMANTIC body — excludes the rev, all
 * volatile/local-only fields (user, model, adopted_at, enqueue metadata), and
 * the signature timestamp. Same-rev + different hash ⇒ genuinely divergent
 * bodies (a conflict the cloud must not silently absorb).
 */
export function claimContentHash(claim: Claim): string {
  // Identity fields (agent_id/agent_name) are excluded: they are constant over a
  // claim's life and the local↔cloud agent-id mapping is a transport concern,
  // not claim content. What matters for divergence detection is the lifecycle body.
  const body = {
    id: claim.id,
    status: claim.status,
    scope: claim.scope,
    description: claim.description,
    plan_id: claim.plan_id ?? null,
    host_id: claim.host_id ?? null,
    session_id: claim.session_id ?? null,
    expires_at: claim.expires_at ?? null,
    worktree_path: claim.worktree_path ?? null,
    created_at: claim.created_at,
    released_at: claim.released_at ?? null,
  };
  return crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
}

function buildClaimPayload(claim: Claim, rev: number, contentHash: string): ClaimCloudPayload {
  return {
    id: claim.id,
    rev,
    agent_name: claim.agent,
    scope: claim.scope,
    description: claim.description,
    status: claim.status,
    plan_id: claim.plan_id ?? null,
    host_id: claim.host_id ?? null,
    session_id: claim.session_id ?? null,
    expires_at: claim.expires_at ?? null,
    worktree_path: claim.worktree_path ?? null,
    created_at: claim.created_at,
    released_at: claim.released_at ?? null,
    content_hash: contentHash,
  };
}

// ── Rev reservation (serialized by the caller's store mutex) ───────────────────

const REV_RE = /@r(\d+)\.json$/;

function revsForId(id: string, dir: string): number[] {
  if (!fs.existsSync(dir)) return [];
  const revs: number[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${id}@r`)) continue;
    const m = name.match(REV_RE);
    if (m) revs.push(parseInt(m[1], 10));
  }
  return revs;
}

/** Highest rev already reserved for this id across outbox + sent (0 if none). */
function maxRevForId(id: string, cwd: string | undefined): number {
  const all = [
    ...revsForId(id, federationSubdir('outbox', cwd, 'read')),
    ...revsForId(id, federationSubdir('sent', cwd, 'read')),
  ];
  return all.length ? Math.max(...all) : 0;
}

function recordFilename(id: string, rev: number): string {
  return `${id}@r${rev}.json`;
}

function writeRecordAtomic(dir: string, filename: string, record: OutboxRecord): void {
  ensureDir(dir);
  const finalPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, finalPath);
}

// ── Enablement gate (memoized per cwd — resolve config once per process) ───────

const enabledCache = new Map<string, boolean>();

function syncEnabledCached(cwd: string | undefined): boolean {
  const key = cwd ?? process.cwd();
  const cached = enabledCache.get(key);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    value = isCloudSyncEnabled(cwd);
  } catch {
    // Missing/unreadable config → treat federation as disabled.
  }
  enabledCache.set(key, value);
  return value;
}

/** Test/hook seam: drop the memoized enablement (config changed on disk). */
export function clearFederationEnablementCache(): void {
  enabledCache.clear();
}

/**
 * Cheap gate for the persistence seam: is a federation enqueue possibly needed?
 * Lets the caller skip the prev-status load entirely when not federating.
 */
export function isFederationEnqueueActive(cwd?: string, suppress?: boolean): boolean {
  return !suppress && syncEnabledCached(cwd);
}

// ── Enqueue (the diff-based seam entry point) ──────────────────────────────────

/**
 * Enqueue a claim lifecycle transition for cloud sync, if it qualifies.
 *
 * Called from saveClaimUnlocked (under the store mutation mutex). Enqueues iff:
 * cloud sync is enabled, not suppressed (cloud-origin materialization), and the
 * save is a real transition — a create, or a status change. Mid-life saves that
 * do not change status do NOT enqueue (dec#123). Never throws to the caller.
 *
 * Returns the reserved rev, or null when nothing was enqueued.
 */
export function maybeEnqueueClaimTransition(
  claim: Claim,
  prevStatus: ClaimStatus | undefined,
  created: boolean,
  cwd?: string,
  suppress?: boolean,
): number | null {
  try {
    if (suppress) return null;
    if (!syncEnabledCached(cwd)) return null;
    const isTransition = created || prevStatus !== claim.status;
    if (!isTransition) return null;

    const rev = maxRevForId(claim.id, cwd) + 1;
    const contentHash = claimContentHash(claim);
    const record: OutboxRecord = {
      op: 'upsert_claim',
      entity_type: 'claim',
      entity_id: claim.id,
      rev,
      from_status: prevStatus ?? null,
      to_status: claim.status,
      content_hash: contentHash,
      payload: buildClaimPayload(claim, rev, contentHash),
      enqueued_at: nowISO(),
      attempts: 0,
      last_status: null,
      last_error: null,
      last_attempt_at: null,
    };
    writeRecordAtomic(federationSubdir('outbox', cwd, 'write'), recordFilename(claim.id, rev), record);
    logger.debug(`Federation outbox: enqueued claim ${claim.id}@r${rev} (${prevStatus ?? 'new'}→${claim.status})`);
    return rev;
  } catch (err) {
    // Federation bookkeeping must never break a claim write.
    logger.debug('Federation outbox enqueue failed (non-fatal):', err);
    return null;
  }
}

// ── Drain-side helpers (used by `brainclaw federation sync`) ───────────────────

function loadRecordsFrom(dir: string): LoadedRecord[] {
  if (!fs.existsSync(dir)) return [];
  const out: LoadedRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const filepath = path.join(dir, name);
    try {
      out.push({ record: JSON.parse(fs.readFileSync(filepath, 'utf-8')) as OutboxRecord, filepath });
    } catch (err) {
      logger.debug(`Federation outbox: skipping unreadable record ${name}:`, err);
    }
  }
  return out;
}

export function listOutboxRecords(cwd?: string): LoadedRecord[] {
  return loadRecordsFrom(federationSubdir('outbox', cwd, 'read'))
    .sort((a, b) => (a.record.entity_id.localeCompare(b.record.entity_id)) || (a.record.rev - b.record.rev));
}

/** Highest rev already archived in sent/ for an id (the sync marker). 0 if none. */
export function sentMarkerRev(id: string, cwd?: string): number {
  const revs = revsForId(id, federationSubdir('sent', cwd, 'read'));
  return revs.length ? Math.max(...revs) : 0;
}

function removeFileIfExists(filepath: string): void {
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch { /* best-effort */ }
}

/** Archive a record from outbox → sent (success or superseded). */
export function archiveToSent(rec: LoadedRecord, meta: { http_status: number }, cwd?: string): void {
  const sentDir = federationSubdir('sent', cwd, 'write');
  const archived: OutboxRecord & { synced_at: string; http_status: number } = {
    ...rec.record,
    synced_at: nowISO(),
    http_status: meta.http_status,
  };
  writeRecordAtomic(sentDir, recordFilename(rec.record.entity_id, rec.record.rev), archived);
  removeFileIfExists(rec.filepath);
}

/** Move a record from outbox → parked (dead-letter). */
export function parkRecord(rec: LoadedRecord, reason: string, cwd?: string): void {
  const parkedDir = federationSubdir('parked', cwd, 'write');
  const parked: OutboxRecord & { parked_at: string; parked_reason: string } = {
    ...rec.record,
    parked_at: nowISO(),
    parked_reason: reason,
  };
  writeRecordAtomic(parkedDir, recordFilename(rec.record.entity_id, rec.record.rev), parked);
  removeFileIfExists(rec.filepath);
}

/** Persist an updated attempt count / last error on a still-pending record. */
export function recordAttempt(rec: LoadedRecord, meta: { http_status: number | null; error: string | null }, cwd?: string): void {
  const updated: OutboxRecord = {
    ...rec.record,
    attempts: rec.record.attempts + 1,
    last_status: meta.http_status,
    last_error: meta.error,
    last_attempt_at: nowISO(),
  };
  writeRecordAtomic(federationSubdir('outbox', cwd, 'write'), recordFilename(rec.record.entity_id, rec.record.rev), updated);
}

export interface ReconcileResult {
  dropped: number;
  parked: number;
}

/**
 * Startup reconcile before a drain: for each outbox record, if sent/ already
 * holds a rev >= this one, this record is already superseded — drop it. If the
 * SAME rev exists in sent with a different content_hash, park it (divergence).
 */
export function reconcileOutbox(cwd?: string): ReconcileResult {
  const result: ReconcileResult = { dropped: 0, parked: 0 };
  const sentDir = federationSubdir('sent', cwd, 'read');
  for (const rec of listOutboxRecords(cwd)) {
    const sentRev = sentMarkerRev(rec.record.entity_id, cwd);
    if (sentRev < rec.record.rev) continue;
    // A sent record at >= this rev exists. If the SAME rev has a different hash, park.
    const sameRevPath = path.join(sentDir, recordFilename(rec.record.entity_id, rec.record.rev));
    if (fs.existsSync(sameRevPath)) {
      try {
        const sent = JSON.parse(fs.readFileSync(sameRevPath, 'utf-8')) as OutboxRecord;
        if (sent.content_hash !== rec.record.content_hash) {
          parkRecord(rec, 'reconcile: same rev already sent with a different content_hash', cwd);
          result.parked++;
          continue;
        }
      } catch { /* fall through to drop */ }
    }
    removeFileIfExists(rec.filepath);
    result.dropped++;
  }
  return result;
}
