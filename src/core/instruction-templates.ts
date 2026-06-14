/**
 * Adaptive instruction file templates — generates brainclaw section content
 * based on the agent's capability profile (tier A/B/C).
 *
 * Two surface types:
 *   STABLE (versioned, rare refresh) — vision, protocol, durable constraints, instructions
 *   LIVE (gitignored, frequent refresh) — plans, claims, traps, decisions, sequences
 *
 * Tier delivery:
 *   Tier A (managed MCP/native surface): stable file only — live context via MCP or native runtime surfaces
 *   Tier B (MCP, no hooks): stable file + live companion file
 *   Tier C (no MCP): stable file + live companion file (richer, only source)
 */

import type { AgentCapabilityProfile } from './agent-capability.js';
import type { State, Constraint, Decision, Trap, PlanItem, Claim, Candidate, Handoff } from './schema.js';
import { resolveExportTarget } from './agent-files.js';

export interface InstructionTemplateInput {
  profile: AgentCapabilityProfile;
  state: State;
  projectName: string;
  brainclawVersion: string;
  resolvedInstructions: string[];
  /** Project vision text from PROJECT.md (injected as first content section). */
  projectVision?: string;
  /** Maximum number of traps to include for tier B (default: 5) */
  maxTraps?: number;
  /** Maximum number of plans to include for tier C (default: 10) */
  maxPlans?: number;
  /** Active claims (loaded separately from state). */
  activeClaims?: Claim[];
  /** Pending candidates (loaded separately from state). */
  pendingCandidates?: Candidate[];
}

export interface InstructionTemplateOutput {
  content: string;
  tier: 'A' | 'B' | 'C';
  sectionsIncluded: string[];
}

/**
 * Render the STABLE brainclaw section content for an instruction file.
 * This is the versioned file that changes rarely (on upgrade, convention change).
 *
 * For backward compatibility, this is also the entry point used by existing
 * export code. Tier B/C stable output no longer includes traps/plans/decisions.
 */
export function renderBrainclawSection(input: InstructionTemplateInput): InstructionTemplateOutput {
  return renderStableSection(input);
}

/**
 * Render stable content only: vision, protocol, constraints, instructions.
 * No traps, plans, decisions, claims — those go in the live companion.
 */
export function renderStableSection(input: InstructionTemplateInput): InstructionTemplateOutput {
  const { profile } = input;

  switch (profile.templateTier) {
    case 'A': return renderStableTierA(input);
    case 'B': return renderStableTierB(input);
    case 'C': return renderStableTierC(input);
  }
}

/**
 * Render LIVE companion content: traps, plans, claims, candidates, handoffs,
 * and (for tier C) recent decisions.
 * This is the gitignored file refreshed on plan/claim/sequence mutations.
 *
 * Returns undefined when the profile does not emit a filesystem live
 * companion.
 */
export function renderLiveSection(input: InstructionTemplateInput): InstructionTemplateOutput | undefined {
  const tier = resolveLiveCompanionTier(input.profile);
  if (!tier) return undefined;

  return renderLiveCompanion(input, {
    tier,
    maxTraps: tier === 'C' ? input.maxTraps ?? 10 : input.maxTraps ?? 5,
    maxPlans: tier === 'C' ? input.maxPlans ?? 10 : input.maxPlans ?? 5,
    maxHandoffs: tier === 'C' ? 10 : 5,
    includeDecisions: tier === 'C',
  });
}

// ─── Tier A: Stable only ────────────────────────────────────────────────────
// Minimal: vision + protocol. Everything else arrives via hooks/MCP.

function renderStableTierA(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  sections.push(renderSessionProtocol());
  included.push('protocol');

  sections.push(renderUserWorkflow());
  included.push('user-workflow');

  sections.push(renderAutonomyContract());
  included.push('autonomy-contract');

  sections.push(renderAvailableTools());
  included.push('available-tools');

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return { content: sections.join('\n\n'), tier: 'A', sectionsIncluded: included };
}

// ─── Tier B: Stable + Live ──────────────────────────────────────────────────

function renderStableTierB(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  sections.push(renderSessionProtocol());
  included.push('protocol');

  sections.push(renderUserWorkflow());
  included.push('user-workflow');

  sections.push(renderAutonomyContract());
  included.push('autonomy-contract');

  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return { content: sections.join('\n\n'), tier: 'B', sectionsIncluded: included };
}

interface LiveCompanionRenderOptions {
  tier: 'B' | 'C';
  maxTraps: number;
  maxPlans: number;
  maxHandoffs: number;
  includeDecisions: boolean;
}

const LIVE_COMPANION_TIER_B_AGENTS = new Set([
  'cursor',
  'cline',
  'windsurf',
  'github-copilot',
]);

function resolveLiveCompanionTier(profile: AgentCapabilityProfile): 'B' | 'C' | undefined {
  if (profile.templateTier === 'C') return 'C';
  if (profile.templateTier === 'B') return 'B';
  return LIVE_COMPANION_TIER_B_AGENTS.has(profile.name) ? 'B' : undefined;
}

function renderLiveCompanion(
  input: InstructionTemplateInput,
  options: LiveCompanionRenderOptions,
): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderLiveHeader(input));
  included.push('live-header');

  const traps = renderTopTraps(input.state, options.maxTraps);
  if (traps) { sections.push(traps); included.push('traps'); }

  const plans = renderActivePlans(input.state, options.maxPlans);
  if (plans) { sections.push(plans); included.push('plans'); }

  const claims = renderActiveClaimsFromInput(input);
  if (claims) { sections.push(claims); included.push('claims'); }

  const candidates = renderPendingCandidates(input);
  if (candidates) { sections.push(candidates); included.push('candidates'); }

  const handoffs = renderOpenHandoffs(input.state, options.maxHandoffs);
  if (handoffs) { sections.push(handoffs); included.push('handoffs'); }

  if (options.includeDecisions) {
    const decisions = renderRecentDecisions(input.state);
    if (decisions) { sections.push(decisions); included.push('decisions'); }
  }

  return { content: sections.join('\n\n'), tier: options.tier, sectionsIncluded: included };
}

// ─── Tier C: Stable + Live (richer) ─────────────────────────────────────────

function renderStableTierC(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  sections.push(renderSessionProtocol());
  included.push('protocol');

  sections.push(renderUserWorkflow());
  included.push('user-workflow');

  sections.push(renderAutonomyContract());
  included.push('autonomy-contract');

  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return { content: sections.join('\n\n'), tier: 'C', sectionsIncluded: included };
}

// ─── Shared section renderers ────────────────────────────────────────────────

function renderVisionSection(input: InstructionTemplateInput): string | undefined {
  if (!input.projectVision?.trim()) return undefined;

  return [
    `## brainclaw — this project`,
    '',
    input.projectVision.trim(),
  ].join('\n');
}

function renderHeader(input: InstructionTemplateInput): string {
  return [
    `> Managed by brainclaw — do not edit manually.`,
    `> Regenerate: brainclaw export --format ${formatForAgent(input.profile.name)} --write`,
  ].join('\n');
}

function renderLiveHeader(_input: InstructionTemplateInput): string {
  return [
    `> Brainclaw live state — auto-refreshed, do not edit.`,
    `> Last updated: ${new Date().toISOString().slice(0, 19)}`,
  ].join('\n');
}

// Kept deliberately small (pln#542): entry point + grammar + escalation
// pointer. Everything else is discoverable via the `next_actions` carried by
// every MCP response — protocol teaching moved out of this file.
function renderSessionProtocol(): string {
  return [
    '## brainclaw — session protocol',
    '',
    '1. Call `bclaw_work(intent)` (consult|execute|resume|review) — one call handles session, context, and claim (execute). Every response carries `next_actions` with the exact follow-up calls: follow those instead of memorizing the API.',
    '2. Canonical grammar for memory objects: `bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition` (entity, …).',
    '3. Do not assume project state without reading brainclaw context first.',
    '',
    'Escalation (only when orchestrating other agents): `bclaw_coordinate(intent=review|consult|assign)`. Verify any dispatch with `bclaw_dispatch_status(target_id)` — trust its sentinel-based verdict, not the tracked pid. Details: `docs/concepts/dispatch-lifecycle.md`.',
  ].join('\n');
}

function renderUserWorkflow(): string {
  return [
    '## brainclaw — user workflow',
    '',
    '    ideation → plan (+ steps) → claim → implement → release claim → review → close step/plan → merge',
    '',
    'Entities: `plan` (intended outcome) · `step` (unit inside a plan) · `sequence` (optional parallel lanes) · `claim` (advisory scope reservation) · `handoff` (stage snapshot) · `candidate` (proposed memory awaiting review) · `decision`/`constraint`/`trap`/`runtime_note` (context captured along the way).',
    '',
    'Review & Fix Loop: start with `bclaw_coordinate(intent=review, open_loop=true, review_mode=symmetric|asymmetric, targetAgents=[reviewer])` — opens the loop AND dispatches the first turn. Drive your turns with `bclaw_loop(intent=turn|complete_turn|advance|close)`. Parallelize a sequence\'s lanes with `bclaw_dispatch(intent=execute)`.',
    'Ideation / Debug / Research loops — *planned* (`docs/product/agent-first-model.md` §3).',
  ].join('\n');
}

/**
 * Autonomy contract — emitted into every agent surface (pln#496 Phase 1).
 *
 * The contract binds protocol-defined transitions as MUST-execute, so live
 * agents stop pausing on `should I send this reply? / merge? / release?`
 * after every step. Without this, brainclaw collapses into a messaging layer
 * with the human as the synchronization carrier-pigeon.
 *
 * Empirical motivation: in May 2026, multi-agent review threads systematically
 * stalled at protocol-defined transitions (pln#480 worker did not release the
 * claim, copilot pln#490 reviewer asked the human whether to send the reply).
 * See feedback_agent_autonomy_gap + run_77e65e77 for the full diagnostic.
 *
 * Surface-fingerprint test (tests/unit/instruction-templates-autonomy-fingerprint.test.ts)
 * fails CI if any tier drops this block — drift here re-introduces the gap.
 */
function renderAutonomyContract(): string {
  return [
    '## brainclaw — autonomous workflow contract',
    '',
    'When a brainclaw protocol prescribes the next action, **execute it. Do not ask for permission.** (Empirical: May 2026 multi-agent review threads stalled at "should I send this reply? / merge?", forcing the human to carry context between agents.)',
    '',
    'MUST execute autonomously:',
    '- review done → send the verdict: `bclaw_send_message(type="reply", thread_id=…)`',
    '- LGTM received and you own the merge → close the loop and merge yourself',
    '- findings received → apply fixes, commit, reply for re-review',
    '- work complete → `bclaw_release_claim(id=…, planStatus="done")`',
    '- dispatched work done → `bclaw_assignment_update(assignment_id=…, status="completed", artifacts=[…])`',
    '',
    'Pause for the human ONLY when the action is destructive AND irreversible AND outside the protocol, when the protocol does not specify the next step, or when the user explicitly asked for confirmation.',
  ].join('\n');
}

// ─── Constraint sections (split by category) ────────────────────────────────

const RULE_CATEGORIES = new Set(['process', 'reliability', 'compatibility', 'security', 'other']);
const ARCH_CATEGORIES = new Set(['architecture', 'performance']);

function renderWorkingRules(state: State): string | undefined {
  const rules = state.active_constraints.filter((c: Constraint) =>
    c.status === 'active' && (!c.category || RULE_CATEGORIES.has(c.category))
  );
  if (rules.length === 0) return undefined;

  return [
    '## brainclaw — working rules',
    '',
    ...rules.map((c: Constraint) => `- ${c.text}`),
  ].join('\n');
}

function renderArchitecture(state: State): string | undefined {
  const arch = state.active_constraints.filter((c: Constraint) =>
    c.status === 'active' && c.category && ARCH_CATEGORIES.has(c.category)
  );
  if (arch.length === 0) return undefined;

  return [
    '## brainclaw — architecture',
    '',
    ...arch.map((c: Constraint) => `- ${c.text}`),
  ].join('\n');
}

function renderInstructions(instructions: string[]): string | undefined {
  if (instructions.length === 0) return undefined;

  return [
    '## brainclaw — active instructions',
    '',
    ...instructions.map((text: string) => `- ${text}`),
  ].join('\n');
}

function renderAvailableTools(): string {
  return [
    '## brainclaw — available tools',
    '',
    '**Entry:** `bclaw_work(intent, compact?, budget_tokens?)` · `bclaw_context(kind=memory|execution|board|board_summary|delta)`',
    '**Canonical grammar** (entities: plan, decision, constraint, trap, handoff, runtime_note, candidate, sequence, claim, action, assignment, agent_run): `bclaw_find`, `bclaw_get`, `bclaw_create`, `bclaw_update`, `bclaw_remove`, `bclaw_transition`. Reads accept `budget_tokens` and `project` (cross-project routing — unknown names throw).',
    '**Session/claims:** `bclaw_session_start`, `bclaw_session_end`, `bclaw_claim`, `bclaw_release_claim` · **steps:** `bclaw_add_step`, `bclaw_complete_step`, `bclaw_update_step`, `bclaw_delete_step` · **sequences:** `bclaw_list_sequences`, `bclaw_create_sequence`, `bclaw_update_sequence`, `bclaw_delete_sequence`',
    '**Inbox:** `bclaw_read_inbox`, `bclaw_ack_message`, `bclaw_send_message`, `bclaw_correct_handoff` · **capture:** `bclaw_write_note`, `bclaw_quick_capture(text, type?)` · **search:** `bclaw_search` · **setup:** `bclaw_setup`, `bclaw_bootstrap`, `bclaw_switch`, `bclaw_release_notes`',
    '**Escalation (orchestrators):** `bclaw_coordinate(intent=review|consult|assign|ideate)` · `bclaw_dispatch(intent=execute)` on an active sequence · `bclaw_loop(intent=turn|complete_turn|advance|close)` to drive turns · `bclaw_dispatch_status(target_id)` to verify',
    '',
    'Responses are self-teaching — follow their `next_actions`. Full catalog + stability contract: `docs/integrations/mcp.md`, `docs/concepts/mcp-governance.md`.',
  ].join('\n');
}

// ─── Live section renderers ─────────────────────────────────────────────────

function renderTopTraps(state: State, limit: number): string | undefined {
  const traps = state.known_traps
    .filter((t: Trap) => t.visibility === 'shared' && (!t.status || t.status === 'active') && !t.platform_scope)
    .sort((a: Trap, b: Trap) => severityOrder(b.severity) - severityOrder(a.severity))
    .slice(0, limit);

  if (traps.length === 0) return undefined;

  return [
    '## brainclaw — known traps',
    '',
    ...traps.map((t: Trap) => `- [${t.severity}] ${t.text}`),
  ].join('\n');
}

function renderActivePlans(state: State, limit: number): string | undefined {
  const active = state.plan_items
    .filter((p: PlanItem) => p.status === 'in_progress' || p.status === 'todo')
    .sort((a: PlanItem, b: PlanItem) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      return priorityOrder(b.priority) - priorityOrder(a.priority);
    })
    .slice(0, limit);

  if (active.length === 0) return undefined;

  return [
    '## brainclaw — active plans',
    '',
    ...active.map((p: PlanItem) => {
      const assignee = p.assignee ? ` (@${p.assignee})` : '';
      return `- [${p.status}] ${p.text}${assignee}`;
    }),
  ].join('\n');
}

function renderActiveClaimsFromInput(input: InstructionTemplateInput): string | undefined {
  const claims = input.activeClaims;
  if (!claims || claims.length === 0) return undefined;

  return [
    '## brainclaw — active claims',
    '',
    ...claims.map((c: Claim) => `- ${c.scope} (by ${c.agent ?? 'unknown'})`),
  ].join('\n');
}

function renderPendingCandidates(input: InstructionTemplateInput): string | undefined {
  const candidates = input.pendingCandidates;
  if (!candidates || candidates.length === 0) return undefined;

  return [
    '## brainclaw — open candidates',
    '',
    ...candidates.slice(0, 5).map((c: Candidate) => `- [${c.type}] ${c.text} (by ${c.author ?? 'unknown'})`),
  ].join('\n');
}

function renderOpenHandoffs(state: State, limit: number): string | undefined {
  const handoffs = state.open_handoffs
    .filter((h: Handoff) => !h.status || h.status === 'open')
    .slice(-limit)
    .reverse();
  if (handoffs.length === 0) return undefined;

  return [
    '## brainclaw — open handoffs',
    '',
    ...handoffs.map((h: Handoff) => {
      const plan = h.plan_id ? ` (${h.plan_id})` : '';
      return `- ${h.from ?? 'unknown'} -> ${h.to ?? 'unknown'}${plan}: ${h.text}`;
    }),
  ].join('\n');
}

function renderRecentDecisions(state: State): string | undefined {
  const decisions = state.recent_decisions.slice(-5);
  if (decisions.length === 0) return undefined;

  return [
    '## brainclaw — recent decisions',
    '',
    ...decisions.map((d: Decision) => `- ${d.text}`),
  ].join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function severityOrder(severity: string): number {
  switch (severity) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function priorityOrder(priority?: string): number {
  switch (priority) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

/**
 * Resolve an agent name to its export format by reading AGENT_EXPORT_REGISTRY.
 * Was a hand-maintained switch that drifted with every new agent — now derived
 * from the same registry the export command iterates, so adding an agent in one
 * place updates every consumer (pln#546 step 2).
 */
function formatForAgent(agentName: string): string {
  return resolveExportTarget(agentName).format;
}
