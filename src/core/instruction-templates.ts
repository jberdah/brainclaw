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
    '2. Call `bclaw_coordinate(intent)` to assign, consult, or review other agents.',
    '3. Do not assume project state without reading brainclaw context first.',
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
    'The default MCP catalog is intentionally small. Start with the facades, then use the everyday tools below when you need a lower-level read or write.',
    '',
    '**Facades:** `bclaw_work`, `bclaw_coordinate`',
    '**Execution lifecycle:** `bclaw_session_start`, `bclaw_session_end`, `bclaw_claim`, `bclaw_release_claim`',
    '**Everyday reads:** `bclaw_get_context`, `bclaw_get_execution_context`, `bclaw_get_agent_board`, `bclaw_read_inbox`, `bclaw_read_handoff`',
    '**Planning and review:** `bclaw_list_plans`, `bclaw_list_claims`, `bclaw_list_candidates`, `bclaw_create_candidate`, `bclaw_ack_message`',
    '**Capture, setup, and navigation:** `bclaw_write_note`, `bclaw_quick_capture`, `bclaw_bootstrap`, `bclaw_release_notes`, `bclaw_switch`, `bclaw_setup`',
    '',
    'Advanced and legacy tools still exist. See `docs/integrations/mcp.md` for the broader catalog; raw MCP clients can request it with `tools/list` params `{ catalog: "all" }`.',
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
    case 'continue': return 'continue';
    default: return 'agents-md';
  }
}
