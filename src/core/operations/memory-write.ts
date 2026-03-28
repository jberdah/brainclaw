/**
 * Pure business logic for creating memory items (decision, constraint, trap).
 *
 * No console.log, no process.exit, no MCP formatting.
 * Both CLI commands and MCP handlers call these functions.
 *
 * @module
 */
import { mutateState } from '../state.js';
import { generateIdWithLabel, nowISO } from '../ids.js';
import { generateTrapIdWithLabel, saveOperationalTrap } from '../traps.js';
import type {
  Constraint,
  ConstraintCategory,
  Decision,
  DecisionOutcome,
  MemoryVisibility,
  Severity,
  Trap,
  TrapStatus,
} from '../schema.js';

// ── Create Decision ──────────────────────────────────────────

export interface CreateDecisionInput {
  text: string;
  author: string;
  outcome?: DecisionOutcome;
  tags?: string[];
  relatedPaths?: string[];
  planId?: string;
}

export interface CreateDecisionResult {
  id: string;
  shortLabel: string;
  text: string;
}

export function createDecision(input: CreateDecisionInput, cwd: string): CreateDecisionResult {
  const result = mutateState((state) => {
    const { id, short_label } = generateIdWithLabel('recent_decisions', cwd);

    const entry: Decision = {
      id,
      short_label,
      text: input.text,
      created_at: nowISO(),
      author: input.author,
      outcome: input.outcome,
      tags: input.tags ?? [],
      related_paths: input.relatedPaths,
      plan_id: input.planId,
    };

    state.recent_decisions.push(entry);
    return { id, shortLabel: short_label, text: input.text };
  }, cwd);

  return result;
}

// ── Create Constraint ────────────────────────────────────────

export interface CreateConstraintInput {
  text: string;
  author: string;
  category?: ConstraintCategory;
  tags?: string[];
  relatedPaths?: string[];
}

export interface CreateConstraintResult {
  id: string;
  shortLabel: string;
  text: string;
}

export function createConstraint(input: CreateConstraintInput, cwd: string): CreateConstraintResult {
  const result = mutateState((state) => {
    const { id, short_label } = generateIdWithLabel('active_constraints', cwd);

    const entry: Constraint = {
      id,
      short_label,
      text: input.text,
      created_at: nowISO(),
      author: input.author,
      status: 'active',
      category: input.category,
      tags: input.tags ?? [],
      related_paths: input.relatedPaths,
    };

    state.active_constraints.push(entry);
    return { id, shortLabel: short_label, text: input.text };
  }, cwd);

  return result;
}

// ── Create Trap ──────────────────────────────────────────────

export interface CreateTrapInput {
  text: string;
  author: string;
  status?: TrapStatus;
  severity?: Severity;
  tags?: string[];
  relatedPaths?: string[];
  planId?: string;
  visibility?: MemoryVisibility;
  hostId?: string;
  expiresAt?: string;
}

export interface CreateTrapResult {
  id: string;
  shortLabel: string;
  text: string;
  visibility: MemoryVisibility;
  hostId?: string;
}

export function createTrap(input: CreateTrapInput, cwd: string): CreateTrapResult {
  const visibility = input.visibility ?? 'shared';
  const { id, short_label } = generateTrapIdWithLabel();

  const entry: Trap = {
    id,
    short_label,
    text: input.text,
    created_at: nowISO(),
    author: input.author,
    status: input.status ?? 'active',
    severity: input.severity ?? 'medium',
    tags: input.tags ?? [],
    related_paths: input.relatedPaths,
    plan_id: input.planId,
    visibility,
    host_id: input.hostId,
    expires_at: input.expiresAt,
  };

  if (visibility === 'shared') {
    mutateState((state) => {
      state.known_traps.push(entry);
    }, cwd);
  } else {
    saveOperationalTrap(entry, cwd);
  }

  return { id, shortLabel: short_label, text: input.text, visibility, hostId: input.hostId };
}
