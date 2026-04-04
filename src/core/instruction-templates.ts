/**
 * Adaptive instruction file templates — generates brainclaw section content
 * based on the agent's capability profile (tier A/B/C).
 *
 * 5-section ordering (not all tiers include all sections):
 *   1. Vision   — project identity from PROJECT.md
 *   2. Protocol — session workflow, adapted per tier
 *   3. Working rules — constraints categorised as process/reliability/compatibility
 *   4. Architecture — constraints categorised as architecture
 *   5. Stable traps — high-severity, shared traps (Tier B/C only)
 *
 * Core (static) vs Run (dynamic) separation:
 *   Tier A (MCP + hooks): sections 1-2 only — hooks inject everything else
 *   Tier B (MCP, no hooks): sections 1-4 + top traps
 *   Tier C (no MCP): all sections + plans + decisions (only source)
 */

import type { AgentCapabilityProfile } from './agent-capability.js';
import type { State, Constraint, Decision, Trap, PlanItem } from './schema.js';

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
}

export interface InstructionTemplateOutput {
  content: string;
  tier: 'A' | 'B' | 'C';
  sectionsIncluded: string[];
}

/**
 * Render the brainclaw section content for an instruction file,
 * adapted to the agent's capability profile.
 */
export function renderBrainclawSection(input: InstructionTemplateInput): InstructionTemplateOutput {
  const { profile } = input;

  switch (profile.templateTier) {
    case 'A': return renderTierA(input);
    case 'B': return renderTierB(input);
    case 'C': return renderTierC(input);
  }
}

// ─── Tier A: Full integration (MCP + hooks) ─────────────────────────────────
// Minimal: vision + protocol. Everything else arrives via hooks/MCP.

function renderTierA(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  // Section 1: Vision (replaces boilerplate "why this matters")
  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  // Section 2: Protocol (compact, includes estimation + version check inline)
  sections.push(renderProtocolTierA());
  included.push('protocol');

  // Instructions only (no constraints/traps — hooks deliver those)
  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return {
    content: sections.join('\n\n'),
    tier: 'A',
    sectionsIncluded: included,
  };
}

// ─── Tier B: Standard integration (MCP, no hooks) ───────────────────────────
// Medium: vision + protocol + working rules + architecture + top traps.

function renderTierB(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  // Section 1: Vision
  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  // Section 2: Protocol
  sections.push(renderProtocolTierB());
  included.push('protocol');

  // Section 3: Working rules (process + reliability + compatibility constraints)
  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  // Section 4: Architecture constraints
  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  // Instructions
  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  // Section 5: Top traps (agent has no hooks to get them dynamically)
  const traps = renderTopTraps(input.state, input.maxTraps ?? 5);
  if (traps) { sections.push(traps); included.push('traps'); }

  return {
    content: sections.join('\n\n'),
    tier: 'B',
    sectionsIncluded: included,
  };
}

// ─── Tier C: Limited integration (no MCP) ────────────────────────────────────
// Rich: all sections + plans + decisions (instruction file is the only source).

function renderTierC(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  // Section 1: Vision
  const vision = renderVisionSection(input);
  if (vision) { sections.push(vision); included.push('vision'); }

  // Section 2: Protocol (skill-based)
  sections.push(renderProtocolTierC(input.profile));
  included.push('protocol');

  // Section 3: Working rules
  const rules = renderWorkingRules(input.state);
  if (rules) { sections.push(rules); included.push('working-rules'); }

  // Section 4: Architecture
  const arch = renderArchitecture(input.state);
  if (arch) { sections.push(arch); included.push('architecture'); }

  // Instructions
  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  // Section 5: Top traps (more generous limit — only source)
  const traps = renderTopTraps(input.state, input.maxTraps ?? 10);
  if (traps) { sections.push(traps); included.push('traps'); }

  // Additional run content (Tier C only — no MCP to query)
  const plans = renderActivePlans(input.state, input.maxPlans ?? 10);
  if (plans) { sections.push(plans); included.push('plans'); }

  const decisions = renderRecentDecisions(input.state);
  if (decisions) { sections.push(decisions); included.push('decisions'); }

  return {
    content: sections.join('\n\n'),
    tier: 'C',
    sectionsIncluded: included,
  };
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

function renderProtocolTierA(): string {
  return [
    '## brainclaw — session protocol',
    '',
    'Brainclaw context is injected automatically via hooks at each prompt.',
    '',
    '1. Read the injected board state before acting',
    '2. Call `bclaw_get_context(target)` for deeper memory on a specific scope',
    '3. Call `bclaw_claim(scope)` before editing if other agents are active',
    '4. Call `bclaw_session_end(auto_release: true)` when done',
    '',
    'Estimate duration in minutes when creating plans. Report actual effort when completing.',
    'Call `bclaw_get_execution_context` at session start to check for brainclaw updates.',
  ].join('\n');
}

function renderProtocolTierB(): string {
  return [
    '## brainclaw — session protocol (REQUIRED)',
    '',
    'You MUST follow this protocol before any work in this project.',
    '',
    '1. Call `bclaw_session_start` — identify yourself and see the active board',
    '2. Call `bclaw_get_context(target: "<file or dir>")` — load relevant memory',
    '3. Call `bclaw_get_execution_context` — check for brainclaw updates',
    '4. Check that no other agent has claimed your target scope',
    '5. Call `bclaw_claim(scope)` before editing',
    '6. Call `bclaw_write_note(text)` to record observations',
    '7. Call `bclaw_session_end(auto_release: true)` when done',
    '',
    'Estimate duration in minutes when creating plans. Report actual effort when completing.',
  ].join('\n');
}

function renderProtocolTierC(profile: AgentCapabilityProfile): string {
  const lines = [
    '## brainclaw — project coordination',
    '',
  ];

  if (profile.hasSkills) {
    lines.push(
      'Use the brainclaw-context skill to refresh project memory.',
      'Trigger: "refresh project memory", "load brainclaw context", "inspect active plans"',
      '',
    );
  }

  lines.push(
    'Before working:',
    '- Review the constraints and active plans below',
    '- Check the known traps section for pitfalls in your scope',
    '',
    'The sections below are regenerated from brainclaw memory.',
    'For the freshest state, use the brainclaw skill or ask the developer to run `brainclaw context`.',
  );

  return lines.join('\n');
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
