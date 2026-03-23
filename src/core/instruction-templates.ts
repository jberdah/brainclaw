/**
 * Adaptive instruction file templates — generates brainclaw section content
 * based on the agent's capability profile (tier A/B/C).
 *
 * Core (static) vs Run (dynamic) separation:
 *   Core: protocol, "why brainclaw", constraints, instructions, estimation rule
 *   Run:  traps, plans, decisions, claims, handoffs, runtime notes
 *
 * Tier A (MCP + hooks): lightweight — hooks inject run content automatically
 * Tier B (MCP, no hooks): directive — includes top traps, forces MCP calls
 * Tier C (no MCP): rich — includes plans, traps, decisions (only source)
 */

import type { AgentCapabilityProfile } from './agent-capability.js';
import type { State, Constraint, Decision, Trap, PlanItem } from './schema.js';

export interface InstructionTemplateInput {
  profile: AgentCapabilityProfile;
  state: State;
  projectName: string;
  brainclawVersion: string;
  resolvedInstructions: string[];
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

function renderTierA(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  sections.push(renderWhySection(input.profile));
  included.push('why');

  sections.push(renderProtocolTierA());
  included.push('protocol');

  sections.push(renderEstimationRule());
  included.push('estimation');

  sections.push(renderVersionCheckRule());
  included.push('version-check');

  const constraints = renderConstraints(input.state);
  if (constraints) { sections.push(constraints); included.push('constraints'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  return {
    content: sections.join('\n\n'),
    tier: 'A',
    sectionsIncluded: included,
  };
}

// ─── Tier B: Standard integration (MCP, no hooks) ───────────────────────────

function renderTierB(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  sections.push(renderWhySection(input.profile));
  included.push('why');

  sections.push(renderProtocolTierB());
  included.push('protocol');

  sections.push(renderEstimationRule());
  included.push('estimation');

  sections.push(renderVersionCheckRule());
  included.push('version-check');

  const constraints = renderConstraints(input.state);
  if (constraints) { sections.push(constraints); included.push('constraints'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  // Tier B includes top traps statically (agent has no hooks to get them)
  const traps = renderTopTraps(input.state, input.maxTraps ?? 5);
  if (traps) { sections.push(traps); included.push('traps'); }

  return {
    content: sections.join('\n\n'),
    tier: 'B',
    sectionsIncluded: included,
  };
}

// ─── Tier C: Limited integration (no MCP) ────────────────────────────────────

function renderTierC(input: InstructionTemplateInput): InstructionTemplateOutput {
  const sections: string[] = [];
  const included: string[] = [];

  sections.push(renderHeader(input));
  included.push('header');

  sections.push(renderWhySection(input.profile));
  included.push('why');

  sections.push(renderProtocolTierC(input.profile));
  included.push('protocol');

  sections.push(renderEstimationRule());
  included.push('estimation');

  const constraints = renderConstraints(input.state);
  if (constraints) { sections.push(constraints); included.push('constraints'); }

  const instructions = renderInstructions(input.resolvedInstructions);
  if (instructions) { sections.push(instructions); included.push('instructions'); }

  // Tier C includes everything statically — it's the only source of context
  const traps = renderTopTraps(input.state, input.maxTraps ?? 10);
  if (traps) { sections.push(traps); included.push('traps'); }

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

function renderHeader(input: InstructionTemplateInput): string {
  return [
    `> Managed by brainclaw v${input.brainclawVersion} — do not edit manually.`,
    `> Regenerate: brainclaw export --format ${formatForAgent(input.profile.name)} --write`,
  ].join('\n');
}

function renderWhySection(profile: AgentCapabilityProfile): string {
  const lines = [
    '## brainclaw — why this matters',
    '',
    'This project uses brainclaw for shared memory and multi-agent coordination.',
  ];

  if (profile.hasMcp) {
    lines.push(
      'Other agents and developers work in this repo. Without brainclaw context:',
      '- You may edit files another agent is actively working on',
      '- You will miss known traps and architectural decisions',
      '- You will duplicate or contradict planned work',
    );
  } else {
    lines.push(
      'Project context is maintained in brainclaw memory. This includes:',
      '- Active constraints that must be respected',
      '- Known traps to avoid repeating mistakes',
      '- Plans and decisions for ongoing work coordination',
    );
  }

  return lines.join('\n');
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

function renderEstimationRule(): string {
  return [
    '## brainclaw — plans and estimation',
    '',
    'When creating a plan or step, always estimate duration in minutes.',
    'When completing, report actual effort. This calibrates future estimates.',
  ].join('\n');
}

function renderVersionCheckRule(): string {
  return [
    '## brainclaw — version check',
    '',
    'Call `bclaw_get_execution_context` at session start to check for brainclaw updates.',
    'If a newer version is available, inform the developer and suggest updating.',
    'Brainclaw updates may include new features, bug fixes, and improved coordination.',
  ].join('\n');
}

function renderConstraints(state: State): string | undefined {
  const active = state.active_constraints.filter((c: Constraint) => c.status === 'active');
  if (active.length === 0) return undefined;

  return [
    '## brainclaw — active constraints',
    '',
    ...active.map((c: Constraint) => `- ${c.text}`),
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
