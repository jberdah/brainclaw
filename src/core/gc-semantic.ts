/**
 * LLM-driven semantic memory compaction.
 *
 * Two-phase protocol:
 *  Phase 1 (assessMemoryPressure): returns pressure flag + eligible items + template
 *  Phase 2 (applyCompaction): archives specified items, creates new memory entries
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadState, mutateState } from './state.js';
import { resolveEntityDir } from './io.js';
import { logger } from './logger.js';
import { generateIdWithLabel, nowISO } from './ids.js';
import type { PlanItem, Handoff, Constraint, Decision, Trap } from './schema.js';

const PLAN_PRESSURE_THRESHOLD = 50;
const HANDOFF_PRESSURE_THRESHOLD = 30;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MIN_AGE_DAYS = 7;

export interface MemoryPressureResult {
  memory_pressure: boolean;
  done_plans: number;
  closed_handoffs: number;
  eligible_items: number;
  thresholds: { plans: number; handoffs: number };
}

export interface AssessmentResult {
  pressure: boolean;
  done_plans: number;
  closed_handoffs: number;
  eligible_items: CompactableItem[];
  thresholds: { plans: number; handoffs: number };
}

export interface CompactableItem {
  id: string;
  type: 'plan' | 'handoff';
  text: string;
  created_at: string;
  completed_at?: string;
  status: string;
  tags: string[];
  author?: string;
}

export interface CompactionOptions {
  dryRun?: boolean;
  maxItems?: number;
  minAgeDays?: number;
  cwd?: string;
  /** Also archive released claims older than `minAgeDays`. Default true. */
  purgeReleasedClaims?: boolean;
  /** Also archive session-lifecycle runtime_notes older than `minAgeDays`. Default true. */
  purgeSessionNotes?: boolean;
  /** Also deduplicate auto-generated session-end handoffs. Default true. */
  dedupHandoffs?: boolean;
}

export interface CompactionResult {
  dry_run: boolean;
  eligible_count: number;
  archived_count: number;
  archived_items: CompactableItem[];
  backup_path?: string;
  template?: string;
  /** Post-v1 extensions: file-direct cleanup alongside plans/handoffs. */
  claims_archived?: number;
  session_notes_archived?: number;
  handoffs_deduped?: number;
}

export interface CompactionNewItem {
  type: 'constraint' | 'decision' | 'trap';
  text: string;
  tags?: string[];
  severity?: string;
}

export interface ApplyCompactionOptions {
  archiveIds: string[];
  newItems?: CompactionNewItem[];
  author?: string;
  authorId?: string;
  cwd?: string;
}

export interface ApplyCompactionResult {
  archived_count: number;
  archived_ids: string[];
  created_count: number;
  created_ids: string[];
  backup_path: string;
}

export function checkMemoryPressure(cwd?: string): MemoryPressureResult {
  const effectiveCwd = cwd ?? process.cwd();
  const state = loadState(effectiveCwd);
  const donePlans = state.plan_items.filter(
    p => p.status === 'done' || p.status === 'dropped',
  ).length;
  const closedHandoffs = state.open_handoffs.filter(
    h => h.status === 'closed',
  ).length;
  const eligible = countEligibleItems(state, DEFAULT_MIN_AGE_DAYS);
  return {
    memory_pressure: donePlans >= PLAN_PRESSURE_THRESHOLD || closedHandoffs >= HANDOFF_PRESSURE_THRESHOLD,
    done_plans: donePlans,
    closed_handoffs: closedHandoffs,
    eligible_items: eligible,
    thresholds: { plans: PLAN_PRESSURE_THRESHOLD, handoffs: HANDOFF_PRESSURE_THRESHOLD },
  };
}

export function assessMemoryPressure(cwd?: string): AssessmentResult {
  const effectiveCwd = cwd ?? process.cwd();
  const state = loadState(effectiveCwd);
  const cutoff = new Date(Date.now() - DEFAULT_MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const donePlans = state.plan_items.filter(
    p => p.status === 'done' || p.status === 'dropped',
  ).length;
  const closedHandoffs = state.open_handoffs.filter(
    h => h.status === 'closed',
  ).length;
  const eligible: CompactableItem[] = [];
  for (const plan of state.plan_items) {
    if (plan.status !== 'done' && plan.status !== 'dropped') continue;
    const completedAt = plan.completed_at ?? plan.updated_at ?? plan.created_at;
    if (completedAt > cutoff) continue;
    eligible.push(planToCompactable(plan));
  }
  for (const handoff of state.open_handoffs) {
    if (handoff.status !== 'closed') continue;
    if (handoff.created_at > cutoff) continue;
    eligible.push(handoffToCompactable(handoff));
  }
  eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    pressure: donePlans >= PLAN_PRESSURE_THRESHOLD || closedHandoffs >= HANDOFF_PRESSURE_THRESHOLD,
    done_plans: donePlans,
    closed_handoffs: closedHandoffs,
    eligible_items: eligible,
    thresholds: { plans: PLAN_PRESSURE_THRESHOLD, handoffs: HANDOFF_PRESSURE_THRESHOLD },
  };
}

function collectEligible(state: ReturnType<typeof loadState>, cutoff: string): CompactableItem[] {
  const eligible: CompactableItem[] = [];
  for (const plan of state.plan_items) {
    if (plan.status !== 'done' && plan.status !== 'dropped') continue;
    const completedAt = plan.completed_at ?? plan.updated_at ?? plan.created_at;
    if (completedAt > cutoff) continue;
    eligible.push(planToCompactable(plan));
  }
  for (const handoff of state.open_handoffs) {
    if (handoff.status !== 'closed') continue;
    if (handoff.created_at > cutoff) continue;
    eligible.push(handoffToCompactable(handoff));
  }
  eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return eligible;
}

export function compact(options: CompactionOptions = {}): CompactionResult {
  const cwd = options.cwd ?? process.cwd();
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const minAgeDays = options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const dryRun = options.dryRun ?? false;
  const purgeReleasedClaims = options.purgeReleasedClaims ?? true;
  const purgeSessionNotes = options.purgeSessionNotes ?? true;
  const dedupHandoffs = options.dedupHandoffs ?? true;
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

  if (dryRun) {
    const claimsArchived = purgeReleasedClaims ? archiveReleasedClaims(cwd, minAgeDays, true) : 0;
    const sessionNotesArchived = purgeSessionNotes ? archiveSessionNotes(cwd, minAgeDays, true) : 0;
    const handoffsDeduped = dedupHandoffs ? dedupAutoHandoffs(cwd, true) : 0;
    const state = loadState(cwd);
    const eligible = collectEligible(state, cutoff);
    const selected = eligible.slice(0, maxItems);
    return {
      dry_run: true,
      eligible_count: eligible.length,
      archived_count: 0,
      archived_items: selected,
      template: selected.length > 0 ? buildCompactionTemplate(selected) : undefined,
      claims_archived: claimsArchived,
      session_notes_archived: sessionNotesArchived,
      handoffs_deduped: handoffsDeduped,
    };
  }
  return mutateState((state) => {
    // Direct file-store GC participates in the same store-wide mutation lock as
    // state compaction so a stale snapshot cannot race against these deletes.
    const claimsArchived = purgeReleasedClaims ? archiveReleasedClaims(cwd, minAgeDays, false) : 0;
    const sessionNotesArchived = purgeSessionNotes ? archiveSessionNotes(cwd, minAgeDays, false) : 0;
    const handoffsDeduped = dedupHandoffs ? dedupAutoHandoffs(cwd, false) : 0;
    const eligible = collectEligible(state, cutoff);
    const selected = eligible.slice(0, maxItems);
    if (selected.length === 0) {
      return {
        dry_run: false,
        eligible_count: eligible.length,
        archived_count: 0,
        archived_items: [] as CompactableItem[],
        claims_archived: claimsArchived,
        session_notes_archived: sessionNotesArchived,
        handoffs_deduped: handoffsDeduped,
      } as CompactionResult;
    }
    const backupPath = createBackup(selected, cwd);
    const archived = archiveCompactedItems(selected, cwd);
    const archivedIds = new Set(archived.map(a => a.id));
    state.plan_items = state.plan_items.filter(p => !archivedIds.has(p.id));
    state.open_handoffs = state.open_handoffs.filter(h => !archivedIds.has(h.id));
    return {
      dry_run: false,
      eligible_count: eligible.length,
      archived_count: archived.length,
      archived_items: archived,
      backup_path: backupPath,
      template: buildCompactionTemplate(archived),
      claims_archived: claimsArchived,
      session_notes_archived: sessionNotesArchived,
      handoffs_deduped: handoffsDeduped,
    };
  }, cwd);
}

export function buildCompactionTemplate(items: CompactableItem[]): string {
  const planItems = items.filter(i => i.type === 'plan');
  const handoffItems = items.filter(i => i.type === 'handoff');
  const lines: string[] = [];
  lines.push('# Semantic Compaction Template');
  lines.push('');
  lines.push(items.length + ' item(s) have been archived from active memory.');
  lines.push('Review the items below and create durable memory entries for any insights worth preserving.');
  lines.push('');
  if (planItems.length > 0) {
    lines.push('## Archived Plans (' + planItems.length + ')');
    for (const item of planItems) {
      lines.push('');
      lines.push('### ' + item.id + ' [' + item.status + '] \u2014 ' + (item.tags.join(', ') || 'untagged'));
      lines.push('Created: ' + item.created_at.slice(0, 10) + (item.completed_at ? ' | Completed: ' + item.completed_at.slice(0, 10) : ''));
      lines.push(item.text);
    }
    lines.push('');
  }
  if (handoffItems.length > 0) {
    lines.push('## Archived Handoffs (' + handoffItems.length + ')');
    for (const item of handoffItems) {
      lines.push('');
      lines.push('### ' + item.id + ' [' + item.status + '] \u2014 ' + (item.tags.join(', ') || 'untagged'));
      lines.push('Created: ' + item.created_at.slice(0, 10) + ' | Author: ' + (item.author ?? 'unknown'));
      lines.push(item.text);
    }
    lines.push('');
  }
  lines.push('## Instructions');
  lines.push('');
  lines.push('Summarize these ' + items.length + ' items. For each insight worth preserving, create a durable memory entry using bclaw_update_memory with type constraint, decision, or trap.');
  lines.push('');
  lines.push('Focus on:');
  lines.push('- **Traps learned**: What recurring problems or pitfalls emerged?');
  lines.push('- **Decisions confirmed**: What architectural or process decisions were validated?');
  lines.push('- **Patterns observed**: What recurring themes appear across items?');
  lines.push('');
  lines.push('Do NOT re-create the original items. Distill them into concise, actionable memory entries.');
  return lines.join('\n');
}

export function applyCompaction(options: ApplyCompactionOptions): ApplyCompactionResult {
  const cwd = options.cwd ?? process.cwd();
  return mutateState((state) => {
    const toArchive: CompactableItem[] = [];
    for (const id of options.archiveIds) {
      const plan = state.plan_items.find(p => p.id === id);
      if (plan && (plan.status === 'done' || plan.status === 'dropped')) {
        toArchive.push(planToCompactable(plan));
        continue;
      }
      const handoff = state.open_handoffs.find(h => h.id === id);
      if (handoff && handoff.status === 'closed') {
        toArchive.push(handoffToCompactable(handoff));
      }
    }
    const backupPath = createBackup(toArchive, cwd);
    const archived = archiveCompactedItems(toArchive, cwd);
    const archivedIds = new Set(archived.map(a => a.id));
    state.plan_items = state.plan_items.filter(p => !archivedIds.has(p.id));
    state.open_handoffs = state.open_handoffs.filter(h => !archivedIds.has(h.id));
    const createdIds: string[] = [];
    if (options.newItems && options.newItems.length > 0) {
      const author = options.author ?? 'compaction';
      const authorId = options.authorId;
      for (const newItem of options.newItems) {
        const { id, short_label } = generateIdWithLabel(newItem.type, cwd);
        const now = nowISO();
        const base = {
          id, short_label, text: newItem.text, created_at: now, author,
          ...(authorId ? { author_id: authorId } : {}),
          tags: newItem.tags ?? ['compaction'],
        };
        if (newItem.type === 'constraint') {
          state.active_constraints.push({ ...base, status: 'active' } as Constraint);
        } else if (newItem.type === 'decision') {
          state.recent_decisions.push({ ...base } as Decision);
        } else if (newItem.type === 'trap') {
          state.known_traps.push({
            ...base, status: 'active',
            severity: (newItem.severity as 'low' | 'medium' | 'high') ?? 'medium',
            visibility: 'shared',
          } as Trap);
        }
        createdIds.push(id);
      }
    }
    return {
      archived_count: archived.length,
      archived_ids: archived.map(a => a.id),
      created_count: createdIds.length,
      created_ids: createdIds,
      backup_path: backupPath,
    };
  }, cwd);
}

function archiveCompactedItems(items: CompactableItem[], cwd: string): CompactableItem[] {
  const archived: CompactableItem[] = [];
  for (const item of items) {
    const entityDir = item.type === 'plan' ? 'plans' : 'handoffs';
    const readDir = resolveEntityDir(entityDir, cwd, 'read');
    const writeDir = resolveEntityDir(entityDir, cwd, 'write');
    const sourcePath = path.join(readDir, item.id + '.json');
    const archivePath = path.join(writeDir, 'compacted.jsonl');
    if (!fs.existsSync(sourcePath)) {
      logger.debug('gc-semantic: source file not found, skipping: ' + sourcePath);
      continue;
    }
    try {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      parsed._compacted_at = new Date().toISOString();
      parsed._compaction_type = 'semantic';
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.appendFileSync(archivePath, JSON.stringify(parsed) + '\n', 'utf-8');
      archived.push(item);
    } catch (err) {
      logger.debug('gc-semantic: failed to archive ' + item.id + ':', err);
    }
  }
  return archived;
}

function createBackup(items: CompactableItem[], cwd: string): string {
  const writeDir = resolveEntityDir('gc-backups', cwd, 'write');
  fs.mkdirSync(writeDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(writeDir, 'compact-' + timestamp + '.jsonl');
  for (const item of items) {
    const entityDir = item.type === 'plan' ? 'plans' : 'handoffs';
    const readDir = resolveEntityDir(entityDir, cwd, 'read');
    const sourcePath = path.join(readDir, item.id + '.json');
    if (!fs.existsSync(sourcePath)) continue;
    try {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
    } catch (err) {
      logger.debug('gc-semantic: backup failed for ' + item.id + ':', err);
    }
  }
  return backupPath;
}

function planToCompactable(plan: PlanItem): CompactableItem {
  return {
    id: plan.id, type: 'plan', text: plan.text, created_at: plan.created_at,
    completed_at: plan.completed_at, status: plan.status, tags: plan.tags, author: plan.author,
  };
}

function handoffToCompactable(handoff: Handoff): CompactableItem {
  return {
    id: handoff.id, type: 'handoff', text: handoff.text, created_at: handoff.created_at,
    status: handoff.status, tags: handoff.tags, author: handoff.author,
  };
}

function countEligibleItems(state: ReturnType<typeof loadState>, minAgeDays: number): number {
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
  let count = 0;
  for (const plan of state.plan_items) {
    if (plan.status !== 'done' && plan.status !== 'dropped') continue;
    const completedAt = plan.completed_at ?? plan.updated_at ?? plan.created_at;
    if (completedAt <= cutoff) count++;
  }
  for (const handoff of state.open_handoffs) {
    if (handoff.status !== 'closed') continue;
    if (handoff.created_at <= cutoff) count++;
  }
  return count;
}

/**
 * Archive released claims older than the cutoff. Claims live in their own
 * JsonStore (.brainclaw/coordination/claims/*.json), independent of the
 * mutateState pipeline, so this is a direct file sweep with a compacted.jsonl
 * + gc-backup trail matching the plans/handoffs compaction contract.
 */
function archiveReleasedClaims(cwd: string, minAgeDays: number, dryRun: boolean): number {
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const claimsDir = path.join(cwd, '.brainclaw', 'coordination', 'claims');
  if (!fs.existsSync(claimsDir)) return 0;
  const files = fs.readdirSync(claimsDir).filter(f => f.endsWith('.json'));
  const eligible: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(claimsDir, file), 'utf-8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const status = typeof parsed.status === 'string' ? parsed.status : '';
      const releasedAt = typeof parsed.released_at === 'string' ? parsed.released_at
        : typeof parsed.updated_at === 'string' ? parsed.updated_at
        : typeof parsed.created_at === 'string' ? parsed.created_at : '';
      if (status !== 'released') continue;
      if (!releasedAt || releasedAt > cutoff) continue;
      eligible.push({ file, content });
    } catch {
      // Skip unparseable files — they'll be surfaced by loadDirectoryItems'
      // logger.warn in a separate pass (data-loss fix guarantees preservation).
    }
  }
  if (dryRun || eligible.length === 0) return eligible.length;
  // Archive to compacted.jsonl + backup + unlink.
  const archivePath = path.join(claimsDir, 'compacted.jsonl');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(cwd, '.brainclaw', 'gc-backups', `compact-claims-${timestamp}.jsonl`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  for (const { file, content } of eligible) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed._compacted_at = new Date().toISOString();
    parsed._compaction_type = 'released-claim';
    fs.appendFileSync(archivePath, JSON.stringify(parsed) + '\n', 'utf-8');
    fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
    fs.unlinkSync(path.join(claimsDir, file));
  }
  return eligible.length;
}

/**
 * Archive session-lifecycle runtime_notes older than the cutoff. These are
 * the "Session started / ended" auto-generated notes (tagged `session`) which
 * accumulate at 1000s per project and bury the real human signal.
 */
function archiveSessionNotes(cwd: string, minAgeDays: number, dryRun: boolean): number {
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const runtimeDir = path.join(cwd, '.brainclaw', 'coordination', 'runtime');
  if (!fs.existsSync(runtimeDir)) return 0;
  const eligible: Array<{ filePath: string; content: string }> = [];
  // Runtime notes are nested: runtime/<agent>/<id>.json
  for (const agent of fs.readdirSync(runtimeDir)) {
    const agentDir = path.join(runtimeDir, agent);
    if (!fs.statSync(agentDir).isDirectory()) continue;
    const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(agentDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const tags = Array.isArray(parsed.tags) ? parsed.tags as unknown[] : [];
        const isSession = tags.some(t => t === 'session');
        const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : '';
        if (!isSession || !createdAt || createdAt > cutoff) continue;
        eligible.push({ filePath, content });
      } catch {
        // Skip unparseable
      }
    }
  }
  if (dryRun || eligible.length === 0) return eligible.length;
  const archivePath = path.join(runtimeDir, 'session-notes-archive.jsonl');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(cwd, '.brainclaw', 'gc-backups', `compact-session-notes-${timestamp}.jsonl`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  for (const { filePath, content } of eligible) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed._compacted_at = new Date().toISOString();
    parsed._compaction_type = 'session-note';
    fs.appendFileSync(archivePath, JSON.stringify(parsed) + '\n', 'utf-8');
    fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
    fs.unlinkSync(filePath);
  }
  return eligible.length;
}

/**
 * pln#564 step B — autonomous runtime-note retention.
 *
 * The runtime-note tree (`coordination/runtime/<agent>/*.json`) is fully
 * scanned by buildContext on every read (trp_439fec51). It accumulates
 * unbounded because the only existing GC (archiveSessionNotes) runs solely
 * inside the LLM-driven compaction phase, which is rarely triggered — so
 * 1000s of write-only lifecycle notes bury the real signal and drive a ~11s
 * read. This pass runs cheaply on session-start (full maintenance) with NO
 * LLM gate, capping the redundant classes while preserving genuine captures.
 *
 * Classification (priority order):
 *  - `fakehome`     — scope points at a Temp/bclaw-fakehome worktree: test
 *                     leakage referencing dead paths. Archived unconditionally.
 *  - `lifecycle`    — carries an `event_type` (run_, assignment_, lane_ …):
 *                     dispatch telemetry already in the event journal.
 *  - `session`      — note_type session_start/session_end or tagged `session`:
 *                     session markers already in the audit log + journal.
 *  - `observation`  — genuine human/agent capture. NEVER archived.
 *
 * `session` and `lifecycle` are capped to the newest `keepPerAgent` per agent;
 * the rest are parked (backed up to gc-backups, then unlinked).
 */
const RUNTIME_FAKEHOME_RE = /bclaw-fakehome|[\\/]Temp[\\/]/i;
const DEFAULT_RUNTIME_NOTE_KEEP_PER_AGENT = 20;

type RuntimeNoteClass = 'observation' | 'session' | 'lifecycle' | 'fakehome';

export interface RuntimeNoteRetentionOptions {
  cwd?: string;
  /** Keep the newest N session/lifecycle notes per agent. Default 20. */
  keepPerAgent?: number;
  dryRun?: boolean;
}

export interface RuntimeNoteRetentionResult {
  scanned: number;
  archived: number;
  kept: number;
  by_class: Record<RuntimeNoteClass, number>;
  backup_path?: string;
}

function classifyRuntimeNote(parsed: Record<string, unknown>): RuntimeNoteClass {
  const scope = typeof parsed.scope === 'string' ? parsed.scope : '';
  if (scope && RUNTIME_FAKEHOME_RE.test(scope)) return 'fakehome';
  if (typeof parsed.event_type === 'string' && parsed.event_type.length > 0) return 'lifecycle';
  const noteType = parsed.note_type;
  const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  if (noteType === 'session_start' || noteType === 'session_end' || tags.includes('session')) {
    return 'session';
  }
  return 'observation';
}

/**
 * Enforce runtime-note retention across all agent dirs. Best-effort and
 * idempotent: archiving older/excess notes is safe against a concurrent
 * reader (it just sees fewer notes) and every removed file is parked under
 * `.brainclaw/gc-backups/` first, so nothing is lost.
 */
export function enforceRuntimeNoteRetention(options: RuntimeNoteRetentionOptions = {}): RuntimeNoteRetentionResult {
  const cwd = options.cwd ?? process.cwd();
  const keepPerAgent = options.keepPerAgent ?? DEFAULT_RUNTIME_NOTE_KEEP_PER_AGENT;
  const dryRun = options.dryRun ?? false;
  const by_class: Record<RuntimeNoteClass, number> = { observation: 0, session: 0, lifecycle: 0, fakehome: 0 };
  const result: RuntimeNoteRetentionResult = { scanned: 0, archived: 0, kept: 0, by_class };

  const runtimeDir = path.join(cwd, '.brainclaw', 'coordination', 'runtime');
  if (!fs.existsSync(runtimeDir)) return result;

  const toArchive: Array<{ filePath: string; content: string }> = [];

  for (const agent of fs.readdirSync(runtimeDir)) {
    const agentDir = path.join(runtimeDir, agent);
    let isDir = false;
    try { isDir = fs.statSync(agentDir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;

    // Capped classes are grouped per agent so we keep the newest N each.
    const capped: Record<'session' | 'lifecycle', Array<{ filePath: string; content: string; createdAt: string }>> = {
      session: [],
      lifecycle: [],
    };

    for (const file of fs.readdirSync(agentDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(agentDir, file);
      let content: string;
      let parsed: Record<string, unknown>;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        continue; // unparseable — leave it alone
      }
      result.scanned += 1;
      const cls = classifyRuntimeNote(parsed);
      by_class[cls] += 1;
      if (cls === 'observation') {
        result.kept += 1;
        continue;
      }
      if (cls === 'fakehome') {
        toArchive.push({ filePath, content });
        continue;
      }
      const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : '';
      capped[cls].push({ filePath, content, createdAt });
    }

    for (const cls of ['session', 'lifecycle'] as const) {
      const entries = capped[cls];
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
      result.kept += Math.min(entries.length, keepPerAgent);
      for (const extra of entries.slice(keepPerAgent)) {
        toArchive.push({ filePath: extra.filePath, content: extra.content });
      }
    }
  }

  if (dryRun || toArchive.length === 0) {
    result.archived = toArchive.length;
    return result;
  }

  const timestamp = nowISO().replace(/[:.]/g, '-');
  const backupPath = path.join(cwd, '.brainclaw', 'gc-backups', `runtime-note-retention-${timestamp}.jsonl`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  for (const { filePath, content } of toArchive) {
    try {
      fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
      fs.unlinkSync(filePath);
      result.archived += 1;
    } catch { /* best-effort: a failed unlink just leaves the note in place */ }
  }
  result.backup_path = backupPath;
  return result;
}

/**
 * Deduplicate auto-generated session-end handoffs. These carry the same
 * commits list when several sessions close on the same project state, so the
 * board ends up with N near-identical handoff rows. Group by a signature
 * built from the commits block and keep only the most recent per group.
 */
function dedupAutoHandoffs(cwd: string, dryRun: boolean): number {
  const handoffsDir = path.join(cwd, '.brainclaw', 'coordination', 'handoffs');
  if (!fs.existsSync(handoffsDir)) return 0;
  const files = fs.readdirSync(handoffsDir).filter(f => f.endsWith('.json'));
  // signature -> [{file, created_at, content}]
  const groups = new Map<string, Array<{ file: string; createdAt: string; content: string }>>();
  for (const file of files) {
    const filePath = path.join(handoffsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      // Auto-generated session-end handoffs start with "Session sess_… — auto-generated handoff"
      // and enumerate commits in a block. Skip non-matching handoffs (human-authored).
      if (!text.startsWith('Session sess_') || !text.includes('auto-generated handoff')) continue;
      // Signature: first 100 chars of the "Commits:" block.
      const commitsIdx = text.indexOf('Commits:');
      const sig = commitsIdx >= 0 ? text.slice(commitsIdx, commitsIdx + 100) : text.slice(0, 100);
      const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : '';
      const list = groups.get(sig) ?? [];
      list.push({ file, createdAt, content });
      groups.set(sig, list);
    } catch {
      // Skip unparseable
    }
  }
  // For each group with >1 entries, keep the most recent and archive the rest.
  const toArchive: Array<{ filePath: string; content: string }> = [];
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    for (const entry of list.slice(1)) {
      toArchive.push({ filePath: path.join(handoffsDir, entry.file), content: entry.content });
    }
  }
  if (dryRun || toArchive.length === 0) return toArchive.length;
  const archivePath = path.join(handoffsDir, 'compacted.jsonl');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(cwd, '.brainclaw', 'gc-backups', `compact-handoffs-dedup-${timestamp}.jsonl`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  for (const { filePath, content } of toArchive) {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed._compacted_at = new Date().toISOString();
    parsed._compaction_type = 'handoff-dedup';
    fs.appendFileSync(archivePath, JSON.stringify(parsed) + '\n', 'utf-8');
    fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
    fs.unlinkSync(filePath);
  }
  return toArchive.length;
}
