/**
 * Adaptive instruction file templates — generates brainclaw section content
 * based on the agent's capability profile (tier A/B/C).
 *
 * Two surface types:
 *   STABLE (versioned, rare refresh) — vision, protocol, durable constraints, instructions
 *   LIVE (gitignored, frequent refresh) — plans, claims, traps, decisions, sequences
 *
 * Tier delivery:
 *   Tier A (MCP + hooks): stable file only — live context via hooks/MCP
 *   Tier B (MCP, no hooks): stable file + live companion file
 *   Tier C (no MCP): stable file + live companion file (richer, only source)
 */

import type { AgentCapabilityProfile } from './agent-capability.js';
import type { State, Constraint, Decision, Trap, PlanItem, Claim, Candidate } from './schema.js';

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
 * Render LIVE companion content: traps, plans, decisions, claims, sequences.
 * This is the gitignored file refreshed on plan/claim/sequence mutations.
 *
 * Returns undefined for Tier A (live content delivered via hooks/MCP).
 */
export function renderLiveSection(input: InstructionTemplateInput): InstructionTemplateOutput | undefined {
  const { profile } = input;

  switch (profile.templateTier) {
    case 'A': return undefined; // hooks deliver live content
    case 'B': return renderLiveTierB(input);
    case 'C': return renderLiveTierC(input);
  }
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

  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return { content: sections.join('\n\n'), tier: 'B', sectionsIncluded: included };
}

function renderLiveTierB(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderLiveHeader(input));
  included.push('live-header');

  const traps = renderTopTraps(input.state, input.maxTraps ?? 5);
  if (traps) { sections.push(traps); included.push('traps'); }

  const plans = renderActivePlans(input.state, input.maxPlans ?? 5);
  if (plans) { sections.push(plans); included.push('plans'); }

  const claims = renderActiveClaimsFromInput(input);
  if (claims) { sections.push(claims); included.push('claims'); }

  const candidates = renderPendingCandidates(input);
  if (candidates) { sections.push(candidates); included.push('candidates'); }

  return { content: sections.join('\n\n'), tier: 'B', sectionsIncluded: included };
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

  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return { content: sections.join('\n\n'), tier: 'C', sectionsIncluded: included };
}

function renderLiveTierC(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderLiveHeader(input));
  included.push('live-header');

  const traps = renderTopTraps(input.state, input.maxTraps ?? 10);
  if (traps) { sections.push(traps); included.push('traps'); }

  const plans = renderActivePlans(input.state, input.maxPlans ?? 10);
  if (plans) { sections.push(plans); included.push('plans'); }

  const claims = renderActiveClaimsFromInput(input);
  if (claims) { sections.push(claims); included.push('claims'); }

  const candidates = renderPendingCandidates(input);
  if (candidates) { sections.push(candidates); included.push('candidates'); }

  const decisions = renderRecentDecisions(input.state);
  if (decisions) { sections.push(decisions); included.push('decisions'); }

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
    `> Managed by brainclaw v${input.brainclawVersion} — do not edit manually.`,
    `> Regenerate: brainclaw export --format ${formatForAgent(input.profile.name)} --write`,
  ].join('\n');
}

function renderLiveHeader(_input: InstructionTemplateInput): string {
  return [
    `> Brainclaw live state — auto-refreshed, do not edit.`,
    `> Last updated: ${new Date().toISOString().slice(0, 19)}`,
  ].join('\n');
}

function renderSessionProtocol(): string {
  return [
    '## brainclaw — session protocol',
    '',
    '1. Call `bclaw_work(intent)` to start working — it handles session, context, and claims automatically.',
    '2. Use the canonical grammar (`bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition`) to work with memory objects (plans, decisions, constraints, traps, handoffs, claims, candidates, runtime_notes, …). Read `## brainclaw — working with memory` below for the full map.',
    '3. Do not assume project state without reading brainclaw context first.',
    '',
    '_Escalation path (only when you orchestrate other agents) — by goal:_',
    '- Start a code review / consult an agent / assign a scope → `bclaw_coordinate(intent=review|consult|assign)`',
    '- Parallelize execute across a sequence\'s lanes → `bclaw_dispatch(intent=execute)`',
    '- Drive a turn in a loop already assigned to you → `bclaw_loop(intent=turn|complete_turn|advance|close)`',
    '',
    'Do NOT call `bclaw_loop(intent=open)` directly — it creates a loop structure without dispatch, so the reviewer/participant never gets the work. Use the goal entries above.',
  ].join('\n');
}

function renderUserWorkflow(): string {
  return [
    '## brainclaw — user workflow',
    '',
    'The intended end-to-end flow, executable by a single agent:',
    '',
    '    ideation → plan (+ steps) → claim → implement → release claim → review → close step/plan → merge',
    '',
    'Multi-agent coordination is optional — use the escalation path only when delegating to another agent.',
    '`sequence` is optional: add it between plan and claim when you want parallelized lanes across agents.',
    '',
    '**Entity → role in the flow:**',
    '- `plan` — intended outcome. Create with `bclaw_create(plan, …)`, decompose with `bclaw_add_step`.',
    '- `step` — incremental unit inside a plan; mark done with `bclaw_complete_step` as you implement.',
    '- `sequence` — ordered lanes when work can be parallelized across claims/agents (optional).',
    '- `claim` — advisory reservation of a scope before editing; release once implementation is ready for review.',
    '- `handoff` — immutable snapshot of what moved to the next stage (review, merge).',
    '- `candidate` — proposed decision / constraint / trap awaiting review before entering durable memory.',
    '- `decision` / `constraint` / `trap` / `runtime_note` — captured along the way to preserve context for future sessions.',
    '',
    '**Review & Fix Loop (multi-turn delegation):**',
    '- Start: `bclaw_coordinate(intent=review, open_loop=true, review_mode=symmetric|asymmetric, targetAgents=[reviewer])` — opens the loop AND dispatches the first turn to the reviewer.',
    '- Drive: `bclaw_loop(intent=turn|complete_turn|advance|close)` for turns assigned to your slot.',
    '- Anti-pattern: `bclaw_loop(intent=open)` alone — creates the loop structure without any dispatch, so nothing actually runs.',
    '',
    'Ideation / Debug / Research / Planning loops — *planned*. See `docs/product/agent-first-model.md` §3.',
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
    'The default MCP catalog is intentionally small. Start with `bclaw_work`, then use the canonical grammar for reads/writes on any entity. Coordination facades below are an **escalation path** for agents that orchestrate other agents — not the default loop.',
    '',
    '**Entry facades:** `bclaw_work(intent)`, `bclaw_context(kind)`',
    '**Canonical grammar (standard tier) — your main tool for working with memory:**',
    '- `bclaw_find(entity, filter?)` — list by type',
    '- `bclaw_get(entity, id)` — read one',
    '- `bclaw_create(entity, data)` — add a new plan / decision / constraint / trap / handoff / candidate / runtime_note',
    '- `bclaw_update(entity, id, patch)` — edit in place',
    '- `bclaw_remove(entity, id, purge?)` — soft-delete (or purge)',
    '- `bclaw_transition(entity, id, to)` — change status (e.g. plan todo→in_progress→done)',
    '',
    'Entities supported by the grammar: plan, decision, constraint, trap, handoff, runtime_note, candidate, claim, action, assignment, agent_run.',
    '',
    '**Session + claims:** `bclaw_session_start`, `bclaw_session_end`, `bclaw_claim`, `bclaw_release_claim`',
    '**Plan steps:** `bclaw_add_step`, `bclaw_complete_step`, `bclaw_update_step`, `bclaw_delete_step`',
    '**Inbox + handoffs:** `bclaw_read_inbox`, `bclaw_ack_message`, `bclaw_send_message`, `bclaw_correct_handoff`',
    '**Notes + search:** `bclaw_write_note`, `bclaw_quick_capture`, `bclaw_search`',
    '**Escalation (orchestrator path):**',
    '- Review / consult / assign another agent → `bclaw_coordinate(intent=review|consult|assign)` (use `open_loop=true` on review to also dispatch the reviewer turn)',
    '- Parallel execute across a sequence\'s lanes → `bclaw_dispatch(intent=execute)`',
    '- Drive your turn in an already-opened loop → `bclaw_loop(intent=turn|complete_turn|advance|close)`',
    '**Setup + navigation:** `bclaw_setup`, `bclaw_bootstrap`, `bclaw_switch`, `bclaw_release_notes`',
    '',
    'Legacy per-entity tools (`bclaw_list_plans`, `bclaw_accept`, `bclaw_get_context`, `bclaw_dispatch_review`, …) were removed from the catalog at v1.0 — direct calls still succeed as a migration escape hatch but emit a redirect warning. See `docs/integrations/mcp.md` + `docs/concepts/mcp-governance.md` for the full catalog and stability contract; raw MCP clients can request advanced tools with `tools/list` params `{ catalog: "all" }`.',
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

function formatForAgent(agentName: string): string {
  switch (agentName) {
    case 'claude-code': return 'claude-md';
    case 'cursor': return 'cursor-rules';
    case 'github-copilot': return 'copilot-instructions';
    case 'opencode':
    case 'codex': return 'agents-md';
    case 'antigravity': return 'gemini-md';
    case 'windsurf': return 'windsurf';
    case 'cline': return 'cline';
    case 'roo': return 'roo';
    case 'kilocode': return 'kilocode';
    case 'continue': return 'continue';
    default: return 'agents-md';
  }
}
