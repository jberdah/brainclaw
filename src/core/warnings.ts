/**
 * pln#635 — structured warnings.
 *
 * `FacadeResponse.warnings` is a `string[]`, so handlers with genuinely
 * structured information had nowhere to put it and resorted to
 * `warnings.push(JSON.stringify({ warning: 'scope_already_claimed', … }))` —
 * five such sites in the coordination handler alone. That shape forces every
 * consumer to sniff-parse a string that may or may not be JSON, and it cannot
 * carry the one thing an agent needs: what to DO about it.
 *
 * ADDITIVE BY CONSTRUCTION (the re-scope all three critiques converged on):
 * `warnings` keeps its type AND its byte-identical historical contents — the
 * legacy string is derived from the structured record. `warning_details` is a
 * new optional sibling.
 *
 * SCOPE, STATED PLAINLY: `warning_details` is a structured **subset**, not a
 * mirror. `warnings` remains the complete channel. The coordination handler
 * threads its `warnings` array into helper functions that push prose into it by
 * reference, so a collector object cannot own the array without rewriting those
 * signatures — a churn/risk trade this PR deliberately refuses. Consumers must
 * therefore keep reading `warnings` for completeness and use
 * `warning_details` for the codes that carry recovery paths. Converting the
 * prose sites is a follow-up sweep, not a prerequisite.
 *
 * Validation errors are NOT warnings and are deliberately not routed here: a
 * rejected call stays a tool error (pln#607 — errors must be executable, never
 * downgraded into advisory noise).
 *
 * @module
 */
import type { NextAction, WarningDetail } from './facade-schema.js';

export interface StructuredWarningInput {
  code: string;
  message: string;
  data?: Record<string, unknown>;
  next_actions?: NextAction[];
}

/**
 * Codes that historically shipped as a JSON blob keep shipping that exact blob,
 * so no existing consumer sees a changed string. The set is enumerated rather
 * than inferred so a NEW code cannot accidentally start emitting JSON at a
 * consumer that only ever saw prose.
 */
const LEGACY_JSON_CODES = new Set([
  'agent_validation_failed',
  'plan_already_assigned',
  'scope_already_claimed',
]);

/** Derive the legacy `warnings` string for a structured warning. */
export function renderLegacyWarning(detail: WarningDetail): string {
  if (LEGACY_JSON_CODES.has(detail.code)) {
    return JSON.stringify({ warning: detail.code, ...(detail.data ?? {}) });
  }
  return detail.message;
}

/**
 * Build the structured record without touching any legacy channel.
 *
 * Used by surfaces that have NO historical `warnings: string[]` to stay
 * compatible with — a field introduced already-structured (pln#636 C2's
 * `LaneHarvestResult.warnings`, for one) should not have to invent a throwaway
 * string array just to reach this shape.
 */
export function toWarningDetail(input: StructuredWarningInput): WarningDetail {
  return {
    code: input.code,
    message: input.message,
    ...(input.data ? { data: input.data } : {}),
    ...(input.next_actions?.length ? { next_actions: input.next_actions } : {}),
  };
}

/**
 * Record a structured warning into BOTH channels at once.
 *
 * Taking the two arrays as parameters (rather than owning them) is what keeps
 * this additive: the caller's `warnings: string[]` stays the same object it
 * already passes by reference to its own helpers.
 */
export function pushStructuredWarning(
  warnings: string[],
  details: WarningDetail[],
  input: StructuredWarningInput,
): void {
  const detail = toWarningDetail(input);
  details.push(detail);
  warnings.push(renderLegacyWarning(detail));
}

// ── Builders for the migrated sites ─────────────────────────────────────────
// Each owns its recovery path, which is the entire point of the structured
// channel: `scope_already_claimed` used to be a dead-end string; now it names
// the two calls that resolve it.

export function agentValidationFailedWarning(input: {
  agent: string;
  code?: string;
  reason?: string;
}): StructuredWarningInput {
  return {
    code: 'agent_validation_failed',
    message: `Agent '${input.agent}' cannot be dispatched to${input.reason ? `: ${input.reason}` : ''}.`,
    data: { agent: input.agent, code: input.code, reason: input.reason },
    next_actions: [{
      tool: 'bclaw_find',
      args: { entity: 'agent', filter: { scope: 'global' } },
      when: 'list the dispatchable agents and pick a target that is actually spawnable',
    }],
  };
}

export function planAlreadyAssignedWarning(input: {
  planId: string;
  existingAgent: string;
}): StructuredWarningInput {
  return {
    code: 'plan_already_assigned',
    message: `'${input.planId}' already has an active assignment for ${input.existingAgent} — this call adds a second one.`,
    data: { plan_id: input.planId, existing_agent: input.existingAgent },
    next_actions: [{
      tool: 'bclaw_find',
      args: { entity: 'assignment', filter: { agent: input.existingAgent, status: 'offered' } },
      when: 'inspect the existing assignment before letting two agents work the same scope',
    }],
  };
}

export function scopeAlreadyClaimedWarning(input: {
  scope: string;
  existingAgent: string;
  existingClaimId: string;
}): StructuredWarningInput {
  return {
    code: 'scope_already_claimed',
    message: `Scope '${input.scope}' is already claimed by ${input.existingAgent} (${input.existingClaimId}).`,
    data: {
      scope: input.scope,
      existing_agent: input.existingAgent,
      existing_claim_id: input.existingClaimId,
    },
    next_actions: [
      {
        tool: 'bclaw_get',
        args: { entity: 'claim', id: input.existingClaimId },
        when: 'see who holds the scope and since when before creating a second claim on it',
      },
      {
        tool: 'bclaw_coordinate',
        args: { intent: 'reroute', task: `Reassign work on ${input.scope}`, scope: input.scope },
        when: 'hand the existing claim to another agent instead of double-claiming the scope',
      },
    ],
  };
}
