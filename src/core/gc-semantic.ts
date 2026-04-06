/**
 * LLM-driven semantic memory compaction.
 *
 * Unlike the deterministic compactor (memory-compactor.ts) which clusters
 * near-duplicates, this module handles high-level semantic compression:
 * archiving old done plans and closed handoffs, then producing a template
 * for the calling LLM agent to summarize patterns, traps, and decisions.
 *
 * brainclaw itself never calls an LLM — the template is returned to the
 * agent, which fills it in and creates durable memory entries.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from './state.js';
import { resolveEntityDir } from './io.js';
import { logger } from './logger.js';
import type { PlanItem, Handoff } from './schema.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const PLAN_PRESSURE_THRESHOLD = 100;
const HANDOFF_PRESSURE_THRESHOLD = 50;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MIN_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryPressureResult {
  memory_pressure: boolean;
  done_plans: number;
  closed_handoffs: number;
  eligible_items: number;
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

// ---------------------------------------------------------------------------
// Memory pressure check (used by session_start)
// ---------------------------------------------------------------------------

/**
 * Check whether the store has accumulated enough closed items to warrant
 * LLM-driven compaction. Returns counts and a boolean pressure flag.
 */
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

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

/**
 * Identify and optionally archive eligible items, returning a structured
 * template for the calling agent to produce durable summary memories.
 */
export function compact(options: CompactionOptions = {}): CompactionResult {
  const cwd = options.cwd ?? process.cwd();
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const minAgeDays = options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;
  const dryRun = options.dryRun ?? false;

  const state = loadState(cwd);
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

  // Collect eligible items: done/dropped plans and closed handoffs older than cutoff
  const eligible: CompactableItem[] = [];

  for (const plan of state.plan_items) {
    if (plan.status !== 'done' && plan.status !== 'dropped') continue;
    const completedAt = plan.completed_at ?? plan.updated_at ?? plan.created_at;
    if (completedAt > cutoff) continue;
    eligible.push(planToCompactable(plan));
  }

  for (const handoff of state.open_handoffs) {
    if (handoff.status !== 'closed') continue;
    const closedAt = handoff.created_at; // handoffs don't have completed_at
    if (closedAt > cutoff) continue;
    eligible.push(handoffToCompactable(handoff));
  }

  // Sort oldest first, then take maxItems
  eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const selected = eligible.slice(0, maxItems);

  if (dryRun || selected.length === 0) {
    return {
      dry_run: true,
      eligible_count: eligible.length,
      archived_count: 0,
      archived_items: selected,
      template: selected.length > 0 ? buildTemplate(selected) : undefined,
    };
  }

  // Safety: backup before compaction
  const backupPath = createBackup(selected, cwd);

  // Archive items to cold storage JSONL and remove source files
  const archived = archiveCompactedItems(selected, cwd);

  return {
    dry_run: false,
    eligible_count: eligible.length,
    archived_count: archived.length,
    archived_items: archived,
    backup_path: backupPath,
    template: buildTemplate(archived),
  };
}

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

function buildTemplate(items: CompactableItem[]): string {
  const planItems = items.filter(i => i.type === 'plan');
  const handoffItems = items.filter(i => i.type === 'handoff');

  const lines: string[] = [];
  lines.push(`# Semantic Compaction Template`);
  lines.push(``);
  lines.push(`${items.length} item(s) have been archived from active memory.`);
  lines.push(`Review the items below and create durable memory entries for any insights worth preserving.`);
  lines.push(``);

  if (planItems.length > 0) {
    lines.push(`## Archived Plans (${planItems.length})`);
    for (const item of planItems) {
      lines.push(``);
      lines.push(`### ${item.id} [${item.status}] — ${item.tags.join(', ') || 'untagged'}`);
      lines.push(`Created: ${item.created_at.slice(0, 10)}${item.completed_at ? ` | Completed: ${item.completed_at.slice(0, 10)}` : ''}`);
      lines.push(`${item.text}`);
    }
    lines.push(``);
  }

  if (handoffItems.length > 0) {
    lines.push(`## Archived Handoffs (${handoffItems.length})`);
    for (const item of handoffItems) {
      lines.push(``);
      lines.push(`### ${item.id} [${item.status}] — ${item.tags.join(', ') || 'untagged'}`);
      lines.push(`Created: ${item.created_at.slice(0, 10)} | Author: ${item.author ?? 'unknown'}`);
      lines.push(`${item.text}`);
    }
    lines.push(``);
  }

  lines.push(`## Instructions`);
  lines.push(``);
  lines.push(`Summarize these ${items.length} items. For each insight worth preserving, create a durable memory entry using the appropriate brainclaw tool (bclaw_update_memory with type constraint, decision, or trap).`);
  lines.push(``);
  lines.push(`Focus on:`);
  lines.push(`- **Traps learned**: What recurring problems or pitfalls emerged?`);
  lines.push(`- **Decisions confirmed**: What architectural or process decisions were validated?`);
  lines.push(`- **Patterns observed**: What recurring themes appear across items?`);
  lines.push(``);
  lines.push(`Do NOT re-create the original items. Distill them into concise, actionable memory entries.`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Archival helpers
// ---------------------------------------------------------------------------

function archiveCompactedItems(items: CompactableItem[], cwd: string): CompactableItem[] {
  const archived: CompactableItem[] = [];

  for (const item of items) {
    const entityDir = item.type === 'plan' ? 'plans' : 'handoffs';
    const readDir = resolveEntityDir(entityDir, cwd, 'read');
    const writeDir = resolveEntityDir(entityDir, cwd, 'write');
    const sourcePath = path.join(readDir, `${item.id}.json`);
    const archivePath = path.join(writeDir, 'compacted.jsonl');

    if (!fs.existsSync(sourcePath)) {
      logger.debug(`gc-semantic: source file not found, skipping: ${sourcePath}`);
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
      logger.debug(`gc-semantic: failed to archive ${item.id}:`, err);
    }
  }

  return archived;
}

function createBackup(items: CompactableItem[], cwd: string): string {
  const writeDir = resolveEntityDir('gc-backups', cwd, 'write');
  fs.mkdirSync(writeDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(writeDir, `compact-${timestamp}.jsonl`);

  for (const item of items) {
    const entityDir = item.type === 'plan' ? 'plans' : 'handoffs';
    const readDir = resolveEntityDir(entityDir, cwd, 'read');
    const sourcePath = path.join(readDir, `${item.id}.json`);

    if (!fs.existsSync(sourcePath)) continue;
    try {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      fs.appendFileSync(backupPath, content.trim() + '\n', 'utf-8');
    } catch (err) {
      logger.debug(`gc-semantic: backup failed for ${item.id}:`, err);
    }
  }

  return backupPath;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function planToCompactable(plan: PlanItem): CompactableItem {
  return {
    id: plan.id,
    type: 'plan',
    text: plan.text,
    created_at: plan.created_at,
    completed_at: plan.completed_at,
    status: plan.status,
    tags: plan.tags,
    author: plan.author,
  };
}

function handoffToCompactable(handoff: Handoff): CompactableItem {
  return {
    id: handoff.id,
    type: 'handoff',
    text: handoff.text,
    created_at: handoff.created_at,
    status: handoff.status,
    tags: handoff.tags,
    author: handoff.author,
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
