/**
 * pln#635 — structured warnings.
 *
 * The load-bearing test here is LEGACY PARITY: `warnings: string[]` must keep
 * byte-identical contents, because the migrated sites shipped a specific JSON
 * blob and any consumer may be matching on it. The structured channel is only
 * allowed to be additive.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ALL_TOOLS } from '../../src/commands/mcp.js';
import { FacadeResponseSchema, type WarningDetail } from '../../src/core/facade-schema.js';
import {
  agentValidationFailedWarning,
  planAlreadyAssignedWarning,
  pushStructuredWarning,
  renderLegacyWarning,
  scopeAlreadyClaimedWarning,
} from '../../src/core/warnings.js';

type AjvValidator = (data: unknown) => boolean;
interface AjvInstance { compile: (schema: unknown) => AjvValidator & { errors?: unknown } }
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;
const requireCjs = createRequire(import.meta.url);
const AjvExport = requireCjs('ajv') as AjvCtor & { default?: AjvCtor };
const Ajv: AjvCtor = AjvExport.default ?? AjvExport;

interface ToolDescriptor { name: string; inputSchema: Record<string, unknown> }
const TOOLS = ALL_TOOLS as readonly ToolDescriptor[];

describe('structured warnings — legacy parity (byte-identical `warnings`)', () => {
  it('agent_validation_failed renders the exact pre-pln#635 JSON blob', () => {
    const warnings: string[] = [];
    const details: WarningDetail[] = [];
    pushStructuredWarning(warnings, details, agentValidationFailedWarning({
      agent: 'gemini', code: 'not_spawnable', reason: 'no invoke_binary',
    }));
    // Exactly what the JSON.stringify site emitted, same key order.
    assert.equal(
      warnings[0],
      JSON.stringify({ warning: 'agent_validation_failed', agent: 'gemini', code: 'not_spawnable', reason: 'no invoke_binary' }),
    );
  });

  it('plan_already_assigned renders the exact pre-pln#635 JSON blob', () => {
    const warnings: string[] = [];
    const details: WarningDetail[] = [];
    pushStructuredWarning(warnings, details, planAlreadyAssignedWarning({
      planId: 'src/auth', existingAgent: 'codex',
    }));
    assert.equal(
      warnings[0],
      JSON.stringify({ warning: 'plan_already_assigned', plan_id: 'src/auth', existing_agent: 'codex' }),
    );
  });

  it('scope_already_claimed renders the exact pre-pln#635 JSON blob', () => {
    const warnings: string[] = [];
    const details: WarningDetail[] = [];
    pushStructuredWarning(warnings, details, scopeAlreadyClaimedWarning({
      scope: 'src/auth', existingAgent: 'codex', existingClaimId: 'clm_abc',
    }));
    assert.equal(
      warnings[0],
      JSON.stringify({
        warning: 'scope_already_claimed', scope: 'src/auth',
        existing_agent: 'codex', existing_claim_id: 'clm_abc',
      }),
    );
  });

  it('both channels are always written together (never one without the other)', () => {
    const warnings: string[] = [];
    const details: WarningDetail[] = [];
    pushStructuredWarning(warnings, details, scopeAlreadyClaimedWarning({
      scope: 's', existingAgent: 'a', existingClaimId: 'clm_1',
    }));
    pushStructuredWarning(warnings, details, agentValidationFailedWarning({ agent: 'x' }));
    assert.equal(warnings.length, 2);
    assert.equal(details.length, 2);
  });

  it('a NEW code renders as prose, never as an accidental JSON blob', () => {
    // The historical JSON set is enumerated on purpose: a future code must not
    // start emitting JSON at consumers that only ever saw prose.
    const rendered = renderLegacyWarning({
      code: 'some_future_code',
      message: 'Something advisory happened.',
      data: { a: 1 },
    });
    assert.equal(rendered, 'Something advisory happened.');
  });
});

describe('structured warnings — the payoff: an actionable recovery path', () => {
  it('scope_already_claimed names the two calls that resolve it', () => {
    const w = scopeAlreadyClaimedWarning({ scope: 'src/auth', existingAgent: 'codex', existingClaimId: 'clm_z' });
    assert.deepEqual(w.next_actions?.map((a) => a.tool), ['bclaw_get', 'bclaw_coordinate']);
    // The inspect action must target the ACTUAL conflicting claim, not a generic list.
    assert.equal((w.next_actions![0].args as Record<string, unknown>).id, 'clm_z');
    assert.equal((w.next_actions![1].args as Record<string, unknown>).intent, 'reroute');
  });

  it('every warning-borne next_action is callable against its real inputSchema', () => {
    const builders = [
      agentValidationFailedWarning({ agent: 'x', code: 'c', reason: 'r' }),
      planAlreadyAssignedWarning({ planId: 'p', existingAgent: 'a' }),
      scopeAlreadyClaimedWarning({ scope: 's', existingAgent: 'a', existingClaimId: 'clm_1' }),
    ];
    const actions = builders.flatMap((b) => b.next_actions ?? []);
    assert.ok(actions.length >= 4, 'the builders must actually carry recovery paths');
    for (const action of actions) {
      const tool = TOOLS.find((t) => t.name === action.tool);
      assert.ok(tool, `warning next_action names an unknown tool: ${action.tool}`);
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(tool.inputSchema);
      assert.ok(
        validate(action.args ?? {}),
        `warning next_action for ${action.tool} violates its inputSchema: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it('warning_details is accepted by FacadeResponseSchema and stays optional', () => {
    const base = {
      status: 'ok' as const, intent: 'assign', result: {},
      artifacts: [], side_effects: [], warnings: [],
    };
    // Absent → still valid (additive).
    assert.ok(FacadeResponseSchema.safeParse(base).success);
    // Present → valid, with recovery paths attached.
    const withDetails = FacadeResponseSchema.safeParse({
      ...base,
      warnings: ['{"warning":"scope_already_claimed"}'],
      warning_details: [scopeAlreadyClaimedWarning({ scope: 's', existingAgent: 'a', existingClaimId: 'clm_1' })],
    });
    assert.ok(withDetails.success, JSON.stringify(withDetails.error?.issues));
  });
});
