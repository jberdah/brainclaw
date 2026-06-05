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
import type { State, Constraint, Decision, Trap, PlanItem, Claim, Candidate, Handoff } from './schema.js';

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
    '1. Call `bclaw_work(intent)` to start working — it handles session, context, and claims automatically. Returns a compact payload by default; pass `compact: false` for the full context result, or use `bclaw_context(kind="memory")` after.',
    '2. Use the canonical grammar (`bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition`) to work with memory objects (plans, decisions, constraints, traps, handoffs, claims, candidates, runtime_notes, …). Read `## brainclaw — working with memory` below for the full map.',
    '3. Do not assume project state without reading brainclaw context first.',
    '',
    '_Escalation path (only when you orchestrate other agents) — by goal:_',
    '- Start a code review / consult an agent / assign a scope → `bclaw_coordinate(intent=review|consult|assign)`',
    '- Parallelize execute across a sequence\'s lanes → `bclaw_dispatch(intent=execute)`',
    '- Drive a turn in a loop already assigned to you → `bclaw_loop(intent=turn|complete_turn|advance|close)`',
    '',
    'Do NOT call `bclaw_loop(intent=open)` directly — it creates a loop structure without dispatch, so the reviewer/participant never gets the work. Use the goal entries above.',
    '',
    '_How to verify a dispatch actually worked:_ `execution_status="delivered_and_started"` only means the brief-ack sentinel was touched — it does NOT mean the worker is doing useful work. (1) Call `bclaw_dispatch_status(target_id=<asgn_…|clm_…|lop_…|run_…>)` — the purpose-built facade: it resolves the linked entities, reads the runtime sentinels (`ack` / `heartbeat` / `completed` / `failed`) and the captured stdout/stderr tails, checks pid liveness, and returns a single health verdict plus a recommended next action. This is the `verify_with` target named in the coordinate/dispatch response — prefer it over assembling the picture by hand. (2) Do NOT diagnose liveness from the tracked pid yourself: on Windows an ack-wrapped spawn runs under a `cmd.exe` shell, so `agent_run.pid` is the wrapper (which exits early by design), NOT the real worker — `Get-Process -Id <pid>` reads it dead while the worker is alive and committing. Trust the sentinel-derived verdict instead; the reconciler already infers `completed` from a post-start commit on the worktree branch even when the worker never called `bclaw_assignment_update`. (3) Fallback only if the facade is unavailable: `bclaw_find(entity="agent_run", filter={assignment_id})` plus the captured streams at `.brainclaw/coordination/runtime/log/<assignment_id>.{stdout,stderr}.log` — note that `claude -p` buffers stdout until exit, so an empty log mid-run is expected; use the `heartbeat` sentinel as the live progress signal, not stdout. Full FSM tables + diagnostic decision tree in `docs/concepts/dispatch-lifecycle.md`.',
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
    'When a brainclaw protocol prescribes the next action after the one you just',
    'completed, **execute it. Do not ask for permission.** brainclaw\'s coordination',
    'promise depends on this — every avoidable pause forces the human back into the',
    'synchronization loop, which is exactly what brainclaw is built to eliminate.',
    '',
    '**Protocol-defined transitions you MUST execute autonomously:**',
    '',
    '- IF you completed a review (assigned via `bclaw_coordinate(intent=review)` or',
    '  inbox `review_request` message) → produce findings → **send the reply with',
    '  your verdict via `bclaw_send_message(type="reply", thread_id=…)`**. Do not',
    '  ask whether to send.',
    '- IF you receive a reply with an `LGTM` verdict AND you are the requester →',
    '  **close the loop and merge the branch yourself** (when you own the merge).',
    '  Do not pass the merge to the human.',
    '- IF the reviewer reply contains findings → **apply the symmetric fixes you',
    '  can make**, commit on the same branch, then reroute via',
    '  `bclaw_send_message(type="reply", …)` for re-review. Do not stop after the',
    '  fixes.',
    '- IF you have an active claim and your work is complete → call',
    '  `bclaw_release_claim(id=…, planStatus="done")`. Do not leave the claim',
    '  active for someone else to clean up.',
    '- IF you have an `assignment_id` (you were dispatched via `bclaw_coordinate` /',
    '  `bclaw_dispatch`) → at end of work, call',
    '  `bclaw_assignment_update(assignment_id=…, status="completed", artifacts=[…])`.',
    '  The coordinator depends on this lifecycle event; without it, the loop never',
    '  converges and the supervisor cannot tell success from silent failure.',
    '',
    '**Legitimate reasons to pause and ask the human:**',
    '',
    '1. The action would be **destructive AND irreversible AND outside the',
    '   protocol** (e.g. `git push --force` on a public branch, dropping a',
    '   production database, deleting a non-empty memory cluster). Protocol-',
    '   defined merges to a local branch are NOT in this category.',
    '2. The protocol genuinely **does not specify** the next action (e.g. a',
    '   verdict that splits the dispatched work into two new plans — needs',
    '   scoping judgement only the human owns).',
    '3. The user has **explicitly told you to confirm** before specific actions',
    '   in this session.',
    '',
    'Asking *"should I send the reply?"* on a protocol-defined send is a UX bug,',
    'not safety. If the next step appears in the workflow above — do it. The',
    'empirical cost of skipping the contract: in May 2026, multi-agent review',
    'threads systematically stalled at "should I send this reply?" / "should I',
    'merge?", forcing the human supervisor to manually carry context between',
    'agents. Stop reproducing that pattern.',
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
    '**Entry facades:** `bclaw_work(intent, compact?)`, `bclaw_context(kind)` — bclaw_work defaults to compact:true (minimal payload); use compact:false or bclaw_context for full memory',
    '**Canonical grammar (standard tier) — your main tool for working with memory:**',
    '- `bclaw_find(entity, filter?)` — list by type',
    '- `bclaw_get(entity, id)` — read one',
    '- `bclaw_create(entity, data)` — add a new plan / decision / constraint / trap / handoff / candidate / runtime_note',
    '- `bclaw_update(entity, id, patch)` — edit in place',
    '- `bclaw_remove(entity, id, purge?)` — soft-delete (or purge)',
    '- `bclaw_transition(entity, id, to)` — change status (e.g. plan todo→in_progress→done)',
    '',
    'Entities supported by the grammar: plan, decision, constraint, trap, handoff, runtime_note, candidate, sequence, claim, action, assignment, agent_run.',
    '',
    '**Cross-project access (pln#359):** every canonical-grammar call, `bclaw_context`, and `bclaw_coordinate` accept an optional `project: <name>` argument that routes the operation to a linked project (cross_project_links from `brainclaw link list` OR a workspace store-chain child). Identity is sourced from the caller; writes + audit land in the target. Unknown project names throw — no silent fallback. The CLI exposes the same as `--project <name>` (mutually exclusive with `--cwd`). Example: `bclaw_get(entity="trap", id="trp#36", project="brainclaw-site")`. Cross-project `bclaw_coordinate` is inbox-only — auto-spawn is force-disabled because the spawn cwd / worktree are tied to the target repo; the target agent picks the brief up async via its own `bclaw_work`.',
    '',
    '**Session + claims:** `bclaw_session_start`, `bclaw_session_end`, `bclaw_claim`, `bclaw_release_claim`',
    '**Plan steps:** `bclaw_add_step`, `bclaw_complete_step`, `bclaw_update_step`, `bclaw_delete_step`',
    '**Sequences:** `bclaw_list_sequences`, `bclaw_create_sequence`, `bclaw_update_sequence`, `bclaw_delete_sequence` — create/activate ordered lanes for parallel dispatch. Item shape: `{ planId, stepId?, rank, hard_after?, soft_after?, lane?, scope_hint?, rationale? }`.',
    '**Inbox + handoffs:** `bclaw_read_inbox`, `bclaw_ack_message`, `bclaw_send_message`, `bclaw_correct_handoff`',
    '**Notes + search:** `bclaw_write_note`, `bclaw_quick_capture`, `bclaw_search`',
    '**Escalation (orchestrator path):**',
    '- Review / consult / assign another agent → `bclaw_coordinate(intent=review|consult|assign)` (use `open_loop=true` on review to also dispatch the reviewer turn)',
    '- Parallel execute across a sequence\'s lanes → create/update an active sequence, then `bclaw_dispatch(intent=analysis)` and `bclaw_dispatch(intent=execute)`',
    '- Drive your turn in an already-opened loop → `bclaw_loop(intent=turn|complete_turn|advance|close)`',
    '**Setup + navigation:** `bclaw_setup`, `bclaw_bootstrap`, `bclaw_switch`, `bclaw_release_notes`',
    '',
    'Legacy per-entity tools (`bclaw_list_plans`, `bclaw_accept`, `bclaw_get_context`, `bclaw_dispatch_review`, …) were removed from the catalog at v1.0 — direct calls still succeed as a migration escape hatch but emit a redirect warning. See `docs/integrations/mcp.md` + `docs/concepts/mcp-governance.md` for the full catalog and stability contract.',
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
    '## brainclaw â€” open handoffs',
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
