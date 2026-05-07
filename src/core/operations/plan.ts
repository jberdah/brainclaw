/**
 * Pure business logic for plan operations.
 *
 * No console.log, no process.exit, no MCP formatting.
 * Both CLI commands and MCP handlers call these functions.
 *
 * @module
 */
import { mutateState } from '../state.js';
import { generateIdWithLabel, generateId, nowISO } from '../ids.js';
import type { PlanItem, PlanStep, PlanStatus, PlanStepStatus, PlanType, Priority } from '../schema.js';

// ── Create Plan ──────────────────────────────────────────────

export interface CreatePlanInput {
  text: string;
  author: string;
  type?: PlanType;
  priority?: Priority;
  assignee?: string;
  project?: string;
  tags?: string[];
  relatedPaths?: string[];
  dependsOn?: string[];
  estimatedEffort?: number;
}

export interface CreatePlanResult {
  id: string;
  shortLabel: string;
  text: string;
}

export function createPlan(input: CreatePlanInput, cwd: string): CreatePlanResult {
  if (input.estimatedEffort !== undefined) {
    if (!Number.isInteger(input.estimatedEffort) || input.estimatedEffort <= 0) {
      throw new Error('estimate must be a positive integer (minutes)');
    }
  }

  const result = mutateState((state) => {
    const { id, short_label } = generateIdWithLabel('plan_items', cwd);
    const timestamp = nowISO();

    const entry: PlanItem = {
      id,
      short_label,
      text: input.text,
      type: input.type,
      created_at: timestamp,
      updated_at: timestamp,
      author: input.author,
      status: 'todo',
      priority: input.priority ?? 'medium',
      assignee: input.assignee,
      project: input.project,
      tags: input.tags ?? [],
      related_paths: input.relatedPaths,
      depends_on: input.dependsOn ?? [],
      estimated_effort: input.estimatedEffort,
    };

    state.plan_items.push(entry);
    return { id, shortLabel: short_label, text: input.text };
  }, cwd);

  return result;
}

// ── Add Step ─────────────────────────────────────────────────

export interface AddStepInput {
  planId: string;
  text: string;
  assignee?: string;
}

export interface AddStepResult {
  stepId: string;
  planId: string;
  totalSteps: number;
  doneSteps: number;
}

export function addStep(input: AddStepInput, cwd?: string): AddStepResult {
  const result = mutateState((state) => {
    const plan = state.plan_items.find(
      (p) => p.id === input.planId || p.short_label === input.planId,
    );
    if (!plan) {
      throw new Error(`Plan '${input.planId}' not found.`);
    }

    const step: PlanStep = {
      id: generateId('plan_steps'),
      text: input.text,
      status: 'todo',
      assignee: input.assignee,
      created_at: nowISO(),
      updated_at: nowISO(),
    };

    plan.steps = [...(plan.steps ?? []), step];
    plan.updated_at = nowISO();

    return {
      stepId: step.id,
      planId: plan.id,
      totalSteps: plan.steps.length,
      doneSteps: plan.steps.filter((s) => s.status === 'done').length,
    };
  }, cwd);

  return result;
}

// ── Update Plan ──────────────────────────────────────────────

export interface UpdatePlanInput {
  id: string;
  status?: PlanStatus;
  assignee?: string;
  priority?: Priority;
  actualEffort?: string;
  /**
   * Generic patch escape-hatch for fields declared in EntityRegistry.updatable
   * but not exposed via the typed surface (text, tags, estimated_effort,
   * depends_on, plus actual_effort in snake_case if the caller prefers it).
   * Applied last via Object.assign so explicit typed fields take precedence
   * for legacy callers that mix both.
   */
  patch?: Partial<PlanItem>;
}

export interface UpdatePlanResult {
  id: string;
  text: string;
  status: PlanStatus;
}

export function updatePlan(input: UpdatePlanInput, cwd?: string): UpdatePlanResult {
  const result = mutateState((state) => {
    const plan = state.plan_items.find(
      (p) => p.id === input.id || p.short_label === input.id,
    );
    if (!plan) {
      throw new Error(`Plan item '${input.id}' not found.`);
    }

    const timestamp = nowISO();
    if (input.status) {
      plan.status = input.status;
      if (input.status === 'in_progress' && !plan.started_at) plan.started_at = timestamp;
      if (input.status === 'done' && !plan.completed_at) plan.completed_at = timestamp;
    }
    if (input.assignee !== undefined) plan.assignee = input.assignee;
    if (input.priority) plan.priority = input.priority;
    if (input.actualEffort) plan.actual_effort = input.actualEffort;

    if (input.patch) {
      Object.assign(plan, input.patch);
    }

    plan.updated_at = timestamp;

    return { id: plan.id, text: plan.text, status: plan.status };
  }, cwd);

  return result;
}

// ── Complete Step ────────────────────────────────────────────

export interface CompleteStepInput {
  planId: string;
  stepId: string;
}

export interface CompleteStepResult {
  stepId: string;
  planId: string;
  totalSteps: number;
  doneSteps: number;
  planAutoCompleted: boolean;
}

export function completeStep(input: CompleteStepInput, cwd?: string): CompleteStepResult {
  const result = mutateState((state) => {
    const plan = state.plan_items.find(
      (p) => p.id === input.planId || p.short_label === input.planId,
    );
    if (!plan) {
      throw new Error(`Plan '${input.planId}' not found.`);
    }
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error(`Plan '${input.planId}' has no steps.`);
    }

    const step = plan.steps.find(
      (s) => s.id === input.stepId || s.text.toLowerCase().includes(input.stepId.toLowerCase()),
    );
    if (!step) {
      throw new Error(`Step '${input.stepId}' not found in plan '${input.planId}'.`);
    }

    const timestamp = nowISO();
    step.status = 'done';
    step.updated_at = timestamp;
    plan.updated_at = timestamp;

    const totalSteps = plan.steps.length;
    const doneSteps = plan.steps.filter((s) => s.status === 'done').length;

    let planAutoCompleted = false;
    if (doneSteps === totalSteps && plan.status !== 'done') {
      plan.status = 'done';
      plan.completed_at = timestamp;
      planAutoCompleted = true;
    }

    return { stepId: step.id, planId: plan.id, totalSteps, doneSteps, planAutoCompleted };
  }, cwd);

  return result;
}

// ── Update Step ─────────────────────────────────────────────

export interface UpdateStepInput {
  planId: string;
  stepId: string;
  status?: PlanStepStatus;
  text?: string;
  assignee?: string;
}

export interface UpdateStepResult {
  stepId: string;
  planId: string;
  totalSteps: number;
  doneSteps: number;
  planAutoCompleted: boolean;
}

export function updateStep(input: UpdateStepInput, cwd?: string): UpdateStepResult {
  const result = mutateState((state) => {
    const plan = state.plan_items.find(
      (p) => p.id === input.planId || p.short_label === input.planId,
    );
    if (!plan) {
      throw new Error(`Plan '${input.planId}' not found.`);
    }
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error(`Plan '${input.planId}' has no steps.`);
    }

    const step = plan.steps.find(
      (s) => s.id === input.stepId,
    );
    if (!step) {
      throw new Error(`Step '${input.stepId}' not found in plan '${input.planId}'.`);
    }

    const timestamp = nowISO();
    if (input.status) step.status = input.status;
    if (input.text !== undefined) step.text = input.text;
    if (input.assignee !== undefined) step.assignee = input.assignee || undefined;
    step.updated_at = timestamp;
    plan.updated_at = timestamp;

    const totalSteps = plan.steps.length;
    const doneSteps = plan.steps.filter((s) => s.status === 'done').length;

    let planAutoCompleted = false;
    if (doneSteps === totalSteps && plan.status !== 'done') {
      plan.status = 'done';
      plan.completed_at = timestamp;
      planAutoCompleted = true;
    }

    return { stepId: step.id, planId: plan.id, totalSteps, doneSteps, planAutoCompleted };
  }, cwd);

  return result;
}

// ── Delete Step ─────────────────────────────────────────────

export interface DeleteStepInput {
  planId: string;
  stepId: string;
}

export interface DeleteStepResult {
  stepId: string;
  planId: string;
  totalSteps: number;
  doneSteps: number;
}

export function deleteStep(input: DeleteStepInput, cwd?: string): DeleteStepResult {
  const result = mutateState((state) => {
    const plan = state.plan_items.find(
      (p) => p.id === input.planId || p.short_label === input.planId,
    );
    if (!plan) {
      throw new Error(`Plan '${input.planId}' not found.`);
    }
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error(`Plan '${input.planId}' has no steps.`);
    }

    const idx = plan.steps.findIndex((s) => s.id === input.stepId);
    if (idx < 0) {
      throw new Error(`Step '${input.stepId}' not found in plan '${input.planId}'.`);
    }

    plan.steps.splice(idx, 1);
    plan.updated_at = nowISO();

    const totalSteps = plan.steps.length;
    const doneSteps = plan.steps.filter((s) => s.status === 'done').length;

    return { stepId: input.stepId, planId: plan.id, totalSteps, doneSteps };
  }, cwd);

  return result;
}

// ── Delete Plan ──────────────────────────────────────────────

export interface DeletePlanResult {
  id: string;
  text: string;
}

export function deletePlan(planId: string, cwd?: string): DeletePlanResult {
  const result = mutateState((state) => {
    const idx = state.plan_items.findIndex(
      (p) => p.id === planId || p.short_label === planId,
    );
    if (idx < 0) {
      throw new Error(`Plan item '${planId}' not found.`);
    }
    const removed = state.plan_items.splice(idx, 1)[0]!;
    return { id: removed.id, text: removed.text };
  }, cwd);

  return result;
}
