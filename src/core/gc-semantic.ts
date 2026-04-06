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
import { loadState, persistState } from './state.js';
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
}

export interface CompactionResult {
  dry_run: boolean;
  eligible_count: number;
  archived_count: number;
  archived_items: CompactableItem[];
  backup_path?: string;
  template?: string;
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

export function compact(options: CompactionOptions = {}): CompactionResult {
  const cwd = options.cwd ?? process.cwd();
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const minAgeDays = options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const dryRun = options.dryRun ?? false;
  const state = loadState(cwd);
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
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
  const selected = eligible.slice(0, maxItems);
  if (dryRun || selected.length === 0) {
    return {
      dry_run: true,
      eligible_count: eligible.length,
      archived_count: 0,
      archived_items: selected,
      template: selected.length > 0 ? buildCompactionTemplate(selected) : undefined,
    };
  }
  const backupPath = createBackup(selected, cwd);
  const archived = archiveCompactedItems(selected, cwd);
  return {
    dry_run: false,
    eligible_count: eligible.length,
    archived_count: archived.length,
    archived_items: archived,
    backup_path: backupPath,
    template: buildCompactionTemplate(archived),
  };
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
  const state = loadState(cwd);
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
  const createdIds: string[] = [];
  if (options.newItems && options.newItems.length > 0) {
    const freshState = loadState(cwd);
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
        freshState.active_constraints.push({ ...base, status: 'active' } as Constraint);
      } else if (newItem.type === 'decision') {
        freshState.recent_decisions.push({ ...base } as Decision);
      } else if (newItem.type === 'trap') {
        freshState.known_traps.push({
          ...base, status: 'active',
          severity: (newItem.severity as 'low' | 'medium' | 'high') ?? 'medium',
          visibility: 'shared',
        } as Trap);
      }
      createdIds.push(id);
    }
    persistState(freshState, cwd);
  }
  return {
    archived_count: archived.length,
    archived_ids: archived.map(a => a.id),
    created_count: createdIds.length,
    created_ids: createdIds,
    backup_path: backupPath,
  };
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
      fs.unlinkSync(sourcePath);
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
