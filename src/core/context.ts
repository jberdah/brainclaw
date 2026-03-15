import { loadConfig } from './config.js';
import { buildContextDiff, type ContextDiffResult } from './context-diff.js';
import { findAgentIdentityByName, resolveCurrentAgentIdentity } from './agent-registry.js';
import { hasReusableBootstrapProfile, runBootstrapProfile, selectDerivedSignals, type DerivedContextSignal } from './bootstrap.js';
import { buildAgentToolingContext, type AgentToolingSnapshot } from './agent-context.js';
import { buildExecutionContext, compactExecutionContext, type CompactExecutionContextSnapshot } from './execution-context.js';
import { getVisibleMemoryVersion } from './freshness.js';
import { resolveCurrentHostId } from './host.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from './instructions.js';
import { buildCurrentAgentResumeSummary, buildReputationRankingLookup, type AgentResumeSummary } from './reputation.js';
import { loadState } from './state.js';
import { listCandidates } from './candidates.js';
import { listRuntimeNotes } from './runtime.js';
import { listOperationalTraps } from './traps.js';
import type { InstructionEntry, ProjectMode, ProjectStrategy } from './schema.js';

export const CONTEXT_SCHEMA_VERSION = '1.2';

export interface ContextOptions {
  target?: string;
  project?: string;
  agent?: string;
  host?: string;
  allHosts?: boolean;
  includePending?: boolean;
  profile?: 'dev' | 'openclaw' | 'ops' | 'research';
  maxItems?: number;
  maxChars?: number;
  digest?: boolean;
  bootstrap?: boolean;
  refreshBootstrap?: boolean;
  sinceSession?: string;
  cwd?: string;
}

export interface ContextItem {
  id: string;
  section: 'plan' | 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate' | 'runtime';
  text: string;
  tags: string[];
  score: number;
  reasons: string[];
  related_paths?: string[];
  extra?: string;
  provenance?: {
    actor?: string;
    actor_id?: string;
    project_id?: string;
    host_id?: string;
    session_id?: string;
  };
}

export interface ContextResult {
  context_schema: string;
  profile: string;
  project_id?: string;
  agent_id?: string;
  project_mode: ProjectMode;
  project_strategy: ProjectStrategy;
  current_host: string;
  host_filter?: string;
  all_hosts: boolean;
  memory_version: string;
  target: string;
  project?: string;
  agent?: string;
  digest?: string;
  memory_density: 'low' | 'medium' | 'high';
  bootstrap_available: boolean;
  derived_signals?: DerivedContextSignal[];
  execution_context?: CompactExecutionContextSnapshot;
  agent_tooling?: Pick<AgentToolingSnapshot, 'agents_md_present' | 'agents_md_title' | 'agents_rules' | 'skills' | 'mcp_servers'>;
  scoped_activity?: ScopedActivitySummary;
  context_diff?: ContextDiffResult;
  resolved_instructions: InstructionEntry[];
  resume_summary?: AgentResumeSummary;
  selected: ContextItem[];
}

export interface ScopedActivityItemSummary {
  id: string;
  text: string;
  age_hours: number;
}

export interface ScopedActivitySummary {
  scope: string;
  last_decision?: ScopedActivityItemSummary;
  last_trap?: ScopedActivityItemSummary;
  recent_notes: number;
  pending_candidates: number;
  last_agent?: string;
  last_session?: string;
}

export function buildContext(options: ContextOptions = {}): ContextResult {
  const state = loadState(options.cwd);
  const config = loadConfig(options.cwd);

  const profile = options.profile ?? config.profile ?? 'dev';
  const projectMode = config.project_mode ?? 'auto';
  const projectStrategy = config.projects?.strategy ?? 'manual';
  const currentHost = resolveCurrentHostId();
  const memoryVersion = getVisibleMemoryVersion({ cwd: options.cwd, hostId: options.host, allHosts: options.allHosts });
  const target = options.target?.trim() ?? '';
  const project = options.project?.trim() || inferProjectFromTarget(target, config);
  const agent = options.agent?.trim() || config.current_agent?.trim();
  const currentAgentIdentity = agent
    ? (options.agent?.trim() ? findAgentIdentityByName(agent, options.cwd) : resolveCurrentAgentIdentity(options.cwd))
    : undefined;
  const maxItems = options.maxItems ?? 8;
  const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : undefined;
  const resolvedInstructions = resolveInstructions(loadInstructions(options.cwd), { project, agent });
  const rankingLookup = buildReputationRankingLookup(options.cwd);

  const items: ContextItem[] = [];

  for (const plan of state.plan_items.filter((item) => item.status !== 'done' && item.status !== 'dropped')) {
    const meta: string[] = [plan.status, plan.priority];
    if (plan.assignee) meta.push(`assignee:${plan.assignee}`);
    if (plan.project) meta.push(`project:${plan.project}`);
    items.push({
      id: plan.id,
      section: 'plan',
      text: plan.text,
      tags: plan.tags,
      related_paths: plan.related_paths,
      score: 0,
      reasons: [],
      extra: meta.join(', '),
    });
  }

  for (const c of state.active_constraints) {
    items.push({
      id: c.id,
      section: 'constraint',
      text: c.text,
      tags: c.tags,
      related_paths: c.related_paths,
      score: 0,
      reasons: [],
      extra: c.status,
      provenance: {
        actor: c.author,
        actor_id: c.author_id,
        project_id: c.project_id,
        host_id: c.host_id,
        session_id: c.session_id,
      },
    });
  }

  for (const d of state.recent_decisions) {
    items.push({
      id: d.id,
      section: 'decision',
      text: d.text,
      tags: d.tags,
      related_paths: d.related_paths,
      score: 0,
      reasons: [],
      extra: d.related_paths?.join(', '),
      provenance: {
        actor: d.author,
        actor_id: d.author_id,
        project_id: d.project_id,
        host_id: d.host_id,
        session_id: d.session_id,
      },
    });
  }

  for (const t of state.known_traps) {
    items.push({
      id: t.id,
      section: 'trap',
      text: t.text,
      tags: t.tags,
      related_paths: t.related_paths,
      score: 0,
      reasons: [],
      extra: `${t.severity}, visibility:${t.visibility ?? 'shared'}`,
      provenance: {
        actor: t.author,
        actor_id: t.author_id,
        project_id: t.project_id,
        host_id: t.host_id,
        session_id: t.session_id,
      },
    });
  }

  for (const trap of listOperationalTraps({ hostId: options.host, includeAllHosts: options.allHosts }, options.cwd)) {
    items.push({
      id: trap.id,
      section: 'trap',
      text: trap.text,
      tags: trap.tags,
      related_paths: trap.related_paths,
      score: 0,
      reasons: [],
      extra: `${trap.severity}, visibility:${trap.visibility ?? 'machine'}${trap.host_id ? `, host:${trap.host_id}` : ''}`,
    });
  }

  for (const h of state.open_handoffs.filter((x) => x.status === 'open')) {
    items.push({
      id: h.id,
      section: 'handoff',
      text: h.text,
      tags: h.tags,
      related_paths: h.related_paths,
      score: 0,
      reasons: [],
      extra: `${h.from} -> ${h.to}`,
      provenance: {
        actor: h.author,
        actor_id: h.author_id,
        project_id: h.project_id,
        host_id: h.host_id,
        session_id: h.session_id,
      },
    });
  }

  const runtimeNotes = listRuntimeNotes({
    hostId: options.host,
    includeAllHosts: options.allHosts,
  }, options.cwd);
  for (const note of runtimeNotes) {
    if (project && note.project && note.project !== project) {
      continue;
    }

    const meta: string[] = [`agent:${note.agent}`, `visibility:${note.visibility}`];
    if (note.host_id) meta.push(`host:${note.host_id}`);
    if (note.agent_id) meta.push(`agent_id:${note.agent_id}`);
    if (note.session_id) meta.push(`session:${note.session_id}`);
    if (note.plan_id) meta.push(`plan:${note.plan_id}`);
    if (note.project) meta.push(`project:${note.project}`);
    items.push({
      id: note.id,
      section: 'runtime',
      text: note.text,
      tags: note.tags,
      score: 0,
      reasons: [],
      extra: meta.join(', '),
      provenance: {
        actor: note.agent,
        actor_id: note.agent_id,
        project_id: note.project_id,
        host_id: note.host_id,
        session_id: note.session_id,
      },
    });
  }

  if (options.includePending) {
    for (const p of listCandidates('pending', options.cwd)) {
      const meta: string[] = [`${p.type}`, `stars:${p.star_count ?? 0}`, `uses:${p.usage_count ?? 0}`];
      if (p.author_id) meta.push(`author_id:${p.author_id}`);
      if (p.session_id) meta.push(`session:${p.session_id}`);
      items.push({
        id: p.id,
        section: 'candidate',
        text: p.text,
        tags: p.tags,
        related_paths: p.related_paths,
        score: 0,
        reasons: [],
        extra: meta.join(', '),
        provenance: {
          actor: p.author,
          actor_id: p.author_id,
          project_id: p.project_id,
          host_id: p.host_id,
          session_id: p.session_id,
        },
      });
    }
  }

  const queryTerms = tokenise(target);
  for (const item of items) {
    const relevance = computeRelevance(item, queryTerms, profile, target);
    item.score = relevance.score;
    item.reasons = relevance.reasons;
    if (item.score >= 0 && item.provenance) {
      const trustBonus = rankingLookup.getRankingBonus(item.provenance.actor_id, item.provenance.actor);
      if (trustBonus > 0) {
        item.score += trustBonus;
        item.reasons = uniqueReasons([...item.reasons, `reputation signal:+${trustBonus.toFixed(2)}`]);
      }
    }
  }

  const ranked = items
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxItems);

  const selected = maxChars ? applyCharBudget(ranked, maxChars) : ranked;
  const resumeSummary = buildCurrentAgentResumeSummary(options.cwd);
  const scopedActivity = buildScopedActivity({
    target,
    project,
    state,
    runtimeNotes,
    pendingCandidates: listCandidates('pending', options.cwd),
  });
  const memoryDensity = classifyMemoryDensity(selected.length);
  const bootstrapEnabled = options.bootstrap !== false;
  let bootstrapAvailable = hasReusableBootstrapProfile(target, options.cwd);
  let derivedSignals: DerivedContextSignal[] | undefined;

  if (bootstrapEnabled && (options.refreshBootstrap || memoryDensity === 'low')) {
    const bootstrap = runBootstrapProfile({
      target,
      refresh: options.refreshBootstrap,
      cwd: options.cwd,
    });
    bootstrapAvailable = bootstrap.profile.seed_count > 0;
    if (memoryDensity === 'low') {
      const signals = selectDerivedSignals(target, 5, options.cwd);
      if (signals.length > 0) {
        derivedSignals = signals;
      }
    }
  } else if (bootstrapEnabled && bootstrapAvailable && memoryDensity === 'low') {
    const signals = selectDerivedSignals(target, 5, options.cwd);
    if (signals.length > 0) {
      derivedSignals = signals;
    }
  }

  const executionSensitive = isExecutionSensitiveTarget(target);
  const derivedUsesExecution = derivedSignals?.some((signal) => signal.source_kind === 'machine') ?? false;
  const derivedUsesTooling = derivedSignals?.some((signal) => signal.source_kind === 'skill' || signal.source_kind === 'mcp') ?? false;
  const rawAgentTooling = buildAgentToolingContext({ cwd: options.cwd });
  const actionableAgentRules = rawAgentTooling.agents_rules.length > 0;
  const blockingTooling = rawAgentTooling.mcp_servers.some((server) => server.availability === 'missing_command');
  const shouldExposeExecution = memoryDensity === 'low' || executionSensitive || derivedUsesExecution;
  const shouldExposeAgentTooling = memoryDensity === 'low'
    || executionSensitive
    || derivedUsesTooling
    || actionableAgentRules
    || blockingTooling;
  const executionContext = shouldExposeExecution
    ? compactExecutionContext(buildExecutionContext({ cwd: options.cwd }))
    : undefined;
  const agentTooling = shouldExposeAgentTooling
    ? summariseAgentTooling(rawAgentTooling)
    : undefined;

  const result: ContextResult = {
    context_schema: CONTEXT_SCHEMA_VERSION,
    profile,
    project_id: config.project_id,
    agent_id: currentAgentIdentity?.agent_id,
    project_mode: projectMode,
    project_strategy: projectStrategy,
    current_host: currentHost,
    host_filter: options.host,
    all_hosts: options.allHosts ?? false,
    memory_version: memoryVersion,
    target,
    project,
    agent,
    memory_density: memoryDensity,
    bootstrap_available: bootstrapAvailable,
    derived_signals: derivedSignals,
    execution_context: executionContext,
    agent_tooling: agentTooling,
    scoped_activity: scopedActivity,
    context_diff: options.sinceSession
      ? buildContextDiff({
          session: options.sinceSession,
          cwd: options.cwd,
          includeItems: true,
        })
      : undefined,
    resolved_instructions: resolvedInstructions,
    resume_summary: resumeSummary,
    selected,
  };

  if (options.digest) {
    result.digest = buildContextDigest(result);
  }

  return result;
}

export function renderContextMarkdown(result: ContextResult, explain: boolean = false): string {
  const lines: string[] = [];
  lines.push(`# Agent Context (${result.profile})`);
  lines.push('');
  lines.push(`Context schema: ${result.context_schema}`);
  if (result.project_id) {
    lines.push(`Project ID: ${result.project_id}`);
  }
  if (result.agent_id && result.agent) {
    lines.push(`Agent ID: ${result.agent_id}`);
  }
  lines.push(`Project mode: ${result.project_mode} (${result.project_strategy})`);
  lines.push(`Current host: ${result.current_host}`);
  lines.push(`Memory version: ${result.memory_version}`);
  lines.push(`Memory density: ${result.memory_density}`);
  lines.push(`Bootstrap available: ${result.bootstrap_available ? 'yes' : 'no'}`);
  if (result.all_hosts) {
    lines.push('Runtime host filter: all-hosts');
  } else if (result.host_filter) {
    lines.push(`Runtime host filter: ${result.host_filter}`);
  }
  if (result.project) {
    lines.push(`Resolved project: ${result.project}`);
  }
  if (result.agent) {
    const suffix = result.agent_id ? ` (${result.agent_id})` : '';
    lines.push(`Resolved agent: ${result.agent}${suffix}`);
  }
  if (result.execution_context) {
    lines.push('');
    lines.push('Execution context:');
    if (result.execution_context.branch) {
      lines.push(`- Branch: ${result.execution_context.branch}`);
    }
    lines.push(`- Git status: ${result.execution_context.git_status}`);
    lines.push(`- Workspace: ${result.execution_context.workspace_root}`);
    const toolchains = result.execution_context.toolchains.map((tool) => `${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
    if (toolchains.length > 0) {
      lines.push(`- Toolchains: ${toolchains.join(', ')}`);
    }
  }
  if (result.agent_tooling) {
    lines.push('');
    lines.push('Agent tooling:');
    lines.push(`- AGENTS.md: ${result.agent_tooling.agents_md_present ? 'present' : 'absent'}`);
    if (result.agent_tooling.agents_md_title) {
      lines.push(`- AGENTS title: ${result.agent_tooling.agents_md_title}`);
    }
    for (const rule of result.agent_tooling.agents_rules) {
      lines.push(`- Rule: ${rule}`);
    }
    if (result.agent_tooling.skills.length > 0) {
      lines.push(`- Skills: ${result.agent_tooling.skills.map((skill) => formatSkillSummary(skill)).join(', ')}`);
    }
    if (result.agent_tooling.mcp_servers.length > 0) {
      lines.push(`- MCP servers: ${result.agent_tooling.mcp_servers.map((server) => formatMcpServerSummary(server)).join(', ')}`);
    }
  }
  if (result.context_diff) {
    lines.push('');
    lines.push('New since session started:');
    lines.push(`- ${result.context_diff.summary}`);
  }
  if (result.digest) {
    lines.push('');
    lines.push('Digest:');
    for (const line of result.digest.split('\n')) {
      lines.push(`- ${line}`);
    }
  }
  if (result.resume_summary) {
    lines.push('');
    lines.push(`Resume summary for ${result.resume_summary.agent_name}:`);
    lines.push(`- Internal trust: ${result.resume_summary.internal_trust}`);
    lines.push(`- Contribution quality: ${result.resume_summary.contribution_quality}`);
    lines.push(`- Review reliability: ${result.resume_summary.review_reliability}`);
    lines.push(`- Continuity hygiene: ${result.resume_summary.continuity_hygiene}`);
    for (const item of result.resume_summary.strengths) {
      lines.push(`- Strength: ${item}`);
    }
    for (const item of result.resume_summary.cautions) {
      lines.push(`- Caution: ${item}`);
    }
    for (const item of result.resume_summary.suggested_focus) {
      lines.push(`- Focus: ${item}`);
    }
  }
  lines.push('');
  if (result.target) {
    lines.push(`Target: ${result.target}`);
    lines.push('');
  }

  lines.push('Instructions:');
  if (result.resolved_instructions.length === 0) {
    lines.push('- None resolved.');
  } else {
    for (const instruction of result.resolved_instructions) {
      const scope = instruction.scope ? `:${instruction.scope}` : '';
      const tags = instruction.tags.length ? ` [${instruction.tags.join(', ')}]` : '';
      lines.push(`- [${instruction.id}] <${instruction.layer}${scope}> ${instruction.text}${tags}`);
    }
  }
  lines.push('');

  if (result.selected.length === 0) {
    lines.push('- No relevant canonical memory found.');
    if (result.derived_signals && result.derived_signals.length > 0) {
      lines.push('');
      lines.push('Derived signals:');
      for (const signal of result.derived_signals) {
        lines.push(`- [${signal.seed_kind}/${signal.confidence}] ${signal.text} <${signal.source_kind}:${signal.source_ref}>`);
      }
    }
    return lines.join('\n');
  }

  lines.push('Canonical memory:');
  for (const item of result.selected) {
    const tags = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
    const extra = item.extra ? ` (${item.extra})` : '';
    const why = explain && item.reasons.length ? ` {why: ${item.reasons.join(', ')}}` : '';
    lines.push(`- [${item.id}] <${item.section}> ${item.text}${extra}${tags}${why}`);
  }

  if (result.derived_signals && result.derived_signals.length > 0) {
    lines.push('');
    lines.push('Derived signals:');
    for (const signal of result.derived_signals) {
      lines.push(`- [${signal.seed_kind}/${signal.confidence}] ${signal.text} <${signal.source_kind}:${signal.source_ref}>`);
    }
  }

  return lines.join('\n');
}

export function renderContextPromptTemplate(result: ContextResult, compact: boolean = false): string {
  const lines: string[] = [];
  if (!compact) {
    lines.push('Use the following project memory context before planning or making changes:');
    lines.push('');
  }
  lines.push('```memory-context');
  if (compact) {
    lines.push(`cs=${result.context_schema}`);
    if (result.digest) {
      lines.push('dg:');
      for (const line of result.digest.split('\n')) {
        lines.push(`  - ${line}`);
      }
    }
    lines.push(`p=${result.profile}`);
    if (result.project_id) {
      lines.push(`pid=${result.project_id}`);
    }
    if (result.agent_id) {
      lines.push(`aid=${result.agent_id}`);
    }
    lines.push(`pm=${result.project_mode}`);
    lines.push(`ps=${result.project_strategy}`);
    lines.push(`ch=${result.current_host}`);
    lines.push(`mv=${result.memory_version}`);
    lines.push(`md=${result.memory_density}`);
    lines.push(`ba=${result.bootstrap_available ? 'y' : 'n'}`);
    if (result.all_hosts) {
      lines.push('hf=all-hosts');
    } else if (result.host_filter) {
      lines.push(`hf=${result.host_filter}`);
    }
    if (result.project) {
      lines.push(`pr=${result.project}`);
    }
    if (result.agent) {
      lines.push(`ag=${result.agent}`);
    }
    if (result.execution_context) {
      if (result.execution_context.branch) {
        lines.push(`br=${result.execution_context.branch}`);
      }
      lines.push(`gs=${result.execution_context.git_status}`);
      lines.push(`wr=${result.execution_context.workspace_root}`);
    }
    if (result.agent_tooling) {
      lines.push(`am=${result.agent_tooling.agents_md_present ? 'y' : 'n'}`);
      lines.push(`ar=${result.agent_tooling.agents_rules.length}`);
      lines.push(`sk=${result.agent_tooling.skills.length}`);
      lines.push(`ms=${result.agent_tooling.mcp_servers.length}`);
    }
    if (result.context_diff) {
      lines.push(`sd=${result.context_diff.since_session ?? ''}`);
      lines.push(`dc=${result.context_diff.counts.total}`);
    }
    if (result.resume_summary) {
      lines.push(`rt=${result.resume_summary.internal_trust}`);
      lines.push('rs:');
      for (const item of result.resume_summary.suggested_focus) {
        lines.push(`  - ${item}`);
      }
    }
    if (result.target) {
      lines.push(`t=${result.target}`);
    }
  } else {
    lines.push(`context_schema: ${result.context_schema}`);
    if (result.digest) {
      lines.push('digest:');
      for (const line of result.digest.split('\n')) {
        lines.push(`  - ${line}`);
      }
    }
    lines.push(`profile: ${result.profile}`);
    if (result.project_id) {
      lines.push(`project_id: ${result.project_id}`);
    }
    if (result.agent_id) {
      lines.push(`agent_id: ${result.agent_id}`);
    }
    lines.push(`project_mode: ${result.project_mode}`);
    lines.push(`project_strategy: ${result.project_strategy}`);
    lines.push(`current_host: ${result.current_host}`);
    lines.push(`memory_version: ${result.memory_version}`);
    lines.push(`memory_density: ${result.memory_density}`);
    lines.push(`bootstrap_available: ${result.bootstrap_available}`);
    if (result.all_hosts) {
      lines.push('host_filter: all-hosts');
    } else if (result.host_filter) {
      lines.push(`host_filter: ${result.host_filter}`);
    }
    if (result.project) {
      lines.push(`project: ${result.project}`);
    }
    if (result.agent) {
      lines.push(`agent: ${result.agent}`);
    }
    if (result.execution_context) {
      lines.push('execution_context:');
      lines.push(`  platform: ${result.execution_context.platform}`);
      if (result.execution_context.branch) {
        lines.push(`  branch: ${result.execution_context.branch}`);
      }
      lines.push(`  git_status: ${result.execution_context.git_status}`);
      lines.push(`  workspace_root: ${result.execution_context.workspace_root}`);
      lines.push('  toolchains:');
      for (const tool of result.execution_context.toolchains) {
        lines.push(`    - ${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
      }
    }
    if (result.agent_tooling) {
      lines.push('agent_tooling:');
      lines.push(`  agents_md_present: ${result.agent_tooling.agents_md_present}`);
      if (result.agent_tooling.agents_md_title) {
        lines.push(`  agents_md_title: ${result.agent_tooling.agents_md_title}`);
      }
      lines.push('  agents_rules:');
      for (const rule of result.agent_tooling.agents_rules) {
        lines.push(`    - ${rule}`);
      }
      lines.push('  skills:');
      for (const skill of result.agent_tooling.skills) {
        lines.push(`    - ${formatSkillSummary(skill)}`);
      }
      lines.push('  mcp_servers:');
      for (const server of result.agent_tooling.mcp_servers) {
        lines.push(`    - ${formatMcpServerSummary(server)}`);
      }
    }
    if (result.context_diff) {
      lines.push('context_diff:');
      if (result.context_diff.since_session) {
        lines.push(`  since_session: ${result.context_diff.since_session}`);
      }
      if (result.context_diff.since) {
        lines.push(`  since: ${result.context_diff.since}`);
      }
      lines.push(`  summary: ${result.context_diff.summary}`);
      lines.push('  counts:');
      lines.push(`    constraints: ${result.context_diff.counts.constraints}`);
      lines.push(`    decisions: ${result.context_diff.counts.decisions}`);
      lines.push(`    traps: ${result.context_diff.counts.traps}`);
      lines.push(`    handoffs: ${result.context_diff.counts.handoffs}`);
      lines.push(`    pending_candidates: ${result.context_diff.counts.pending_candidates}`);
      lines.push(`    total: ${result.context_diff.counts.total}`);
    }
    if (result.resume_summary) {
      lines.push('resume_summary:');
      lines.push(`  agent_name: ${result.resume_summary.agent_name}`);
      if (result.resume_summary.agent_id) {
        lines.push(`  agent_id: ${result.resume_summary.agent_id}`);
      }
      lines.push(`  internal_trust: ${result.resume_summary.internal_trust}`);
      lines.push(`  contribution_quality: ${result.resume_summary.contribution_quality}`);
      lines.push(`  review_reliability: ${result.resume_summary.review_reliability}`);
      lines.push(`  continuity_hygiene: ${result.resume_summary.continuity_hygiene}`);
      lines.push('  suggested_focus:');
      for (const item of result.resume_summary.suggested_focus) {
        lines.push(`    - ${item}`);
      }
    }
    if (result.target) {
      lines.push(`target: ${result.target}`);
    }
  }
  lines.push(compact ? 'ins:' : 'instructions:');
  if (result.resolved_instructions.length === 0) {
    lines.push(compact ? '  - n' : '  - none');
  } else {
    for (const instruction of result.resolved_instructions) {
      if (compact) {
        const scope = instruction.scope ? ` sc=${instruction.scope}` : '';
        const tags = instruction.tags.length ? ` tg=[${instruction.tags.join(',')}]` : '';
        lines.push(`  - id=${instruction.id} ly=${instruction.layer}${scope}${tags} tx="${instruction.text}"`);
      } else {
        const scope = instruction.scope ? ` scope=${instruction.scope}` : '';
        const tags = instruction.tags.length ? ` tags=[${instruction.tags.join(',')}]` : '';
        lines.push(`  - id=${instruction.id} layer=${instruction.layer}${scope}${tags} text="${instruction.text}"`);
      }
    }
  }
  lines.push(compact ? 'i:' : 'items:');
  if (result.selected.length === 0) {
    lines.push(compact ? '  - n' : '  - none');
  } else {
    for (const item of result.selected) {
      if (compact) {
        const tags = item.tags.length ? ` tg=[${item.tags.join(',')}]` : '';
        const extra = item.extra ? ` ex="${item.extra}"` : '';
        const why = item.reasons.length ? ` why=[${item.reasons.join('|')}]` : '';
        lines.push(`  - id=${item.id} tp=${item.section}${tags}${extra}${why} tx="${item.text}"`);
      } else {
        const tags = item.tags.length ? ` tags=[${item.tags.join(',')}]` : '';
        const extra = item.extra ? ` extra="${item.extra}"` : '';
        const why = item.reasons.length ? ` why=[${item.reasons.join(', ')}]` : '';
        lines.push(`  - id=${item.id} type=${item.section}${tags}${extra}${why} text="${item.text}"`);
      }
    }
  }
  if (result.derived_signals && result.derived_signals.length > 0) {
    lines.push(compact ? 'ds:' : 'derived_signals:');
    for (const signal of result.derived_signals) {
      if (compact) {
        const paths = signal.related_paths?.length ? ` rp=[${signal.related_paths.join(',')}]` : '';
        lines.push(`  - id=${signal.id} sk=${signal.seed_kind} cf=${signal.confidence} src=${signal.source_kind}:${signal.source_ref}${paths} tx="${signal.text}"`);
      } else {
        const paths = signal.related_paths?.length ? ` related_paths=[${signal.related_paths.join(',')}]` : '';
        lines.push(`  - id=${signal.id} seed_kind=${signal.seed_kind} confidence=${signal.confidence} source=${signal.source_kind}:${signal.source_ref}${paths} text="${signal.text}"`);
      }
    }
  }
  if (result.context_diff) {
    lines.push(compact ? 'cd:' : 'context_diff_items:');
    for (const item of result.context_diff.changed_items ?? []) {
      if (compact) {
        lines.push(`  - tp=${item.section} id=${item.id} tx="${item.text}"`);
      } else {
        lines.push(`  - type=${item.section} id=${item.id} created_at=${item.created_at} text="${item.text}"`);
      }
    }
  }
  lines.push('```');
  return lines.join('\n');
}

export function buildScopedActivity(input: {
  target?: string;
  project?: string;
  state: ReturnType<typeof loadState>;
  runtimeNotes: ReturnType<typeof listRuntimeNotes>;
  pendingCandidates: ReturnType<typeof listCandidates>;
}): ScopedActivitySummary | undefined {
  const target = input.target?.trim();
  if (!target) {
    return undefined;
  }

  const project = input.project?.trim();
  const matchingDecisions = input.state.recent_decisions.filter((item) => matchesScopeTarget(item, target, project));
  const matchingTraps = [
    ...input.state.known_traps.filter((item) => matchesScopeTarget(item, target, project)),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const matchingRuntime = input.runtimeNotes
    .filter((item) => matchesScopeTarget(item, target, project))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const matchingPending = input.pendingCandidates.filter((item) => matchesScopeTarget(item, target, project));

  if (
    matchingDecisions.length === 0
    && matchingTraps.length === 0
    && matchingRuntime.length === 0
    && matchingPending.length === 0
  ) {
    return undefined;
  }

  const lastDecision = matchingDecisions.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const lastTrap = matchingTraps[0];
  const latestRuntime = matchingRuntime[0];

  return {
    scope: target,
    last_decision: lastDecision ? summariseScopedItem(lastDecision) : undefined,
    last_trap: lastTrap ? summariseScopedItem(lastTrap) : undefined,
    recent_notes: matchingRuntime.filter((item) => isRecent(item.created_at, 7 * 24)).length,
    pending_candidates: matchingPending.length,
    last_agent: latestRuntime?.agent,
    last_session: latestRuntime?.session_id,
  };
}

export function buildContextDigest(result: ContextResult): string {
  const lines: string[] = [];
  const highTraps = result.selected.filter((item) => item.section === 'trap' && item.extra?.includes('high'));
  const constraints = result.selected.filter((item) => item.section === 'constraint');
  const decisions = result.selected.filter((item) => item.section === 'decision');
  const candidates = result.selected.filter((item) => item.section === 'candidate');
  const scoped = result.scoped_activity;

  if (highTraps.length > 0) {
    lines.push(`High trap: ${highTraps[0].text}`);
  }
  if (constraints.length > 0) {
    lines.push(`Active constraint: ${constraints[0].text}`);
  }
  if (decisions.length > 0) {
    lines.push(`Recent decision: ${decisions[0].text}`);
  }
  if (candidates.length > 0 || (scoped?.pending_candidates ?? 0) > 0) {
    const pendingCount = Math.max(candidates.length, scoped?.pending_candidates ?? 0);
    lines.push(`Pending candidates: ${pendingCount}`);
  }
  if (scoped) {
    const scopedParts = [`Scoped activity on ${scoped.scope}: ${scoped.recent_notes} recent note(s)`];
    if (scoped.last_agent) {
      scopedParts.push(`last agent ${scoped.last_agent}`);
    }
    lines.push(scopedParts.join(', '));
  } else if (result.selected.some((item) => item.section === 'runtime')) {
    lines.push(`Runtime signal: ${result.selected.find((item) => item.section === 'runtime')?.text}`);
  }
  if (result.memory_density === 'low' && result.derived_signals && result.derived_signals.length > 0) {
    const signal = result.derived_signals[0];
    lines.push(`Derived ${signal.seed_kind}: ${signal.text}`);
  }
  if (result.context_diff && result.context_diff.counts.total > 0) {
    lines.push(`New since session started: ${result.context_diff.summary}`);
  }
  if (result.agent_tooling?.agents_rules.length) {
    lines.push(`Agent rule: ${result.agent_tooling.agents_rules[0]}`);
  }
  const blockingServer = result.agent_tooling?.mcp_servers.find((server) => server.availability === 'missing_command');
  if (blockingServer) {
    lines.push(`Tooling warning: MCP ${blockingServer.name} is configured but ${blockingServer.command ?? 'its command'} is unavailable.`);
  }
  if ((result.memory_density === 'low' || result.execution_context?.git_status === 'dirty') && result.execution_context) {
    if (result.execution_context.git_status === 'dirty') {
      lines.push('Execution: repository has uncommitted changes.');
    } else if (result.execution_context.branch) {
      lines.push(`Execution: branch ${result.execution_context.branch}`);
    } else if (result.execution_context.toolchains[0]) {
      const tool = result.execution_context.toolchains[0];
      lines.push(`Execution: toolchain ${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
    }
  }

  return lines.slice(0, 5).join('\n');
}

function classifyMemoryDensity(selectedCount: number): 'low' | 'medium' | 'high' {
  if (selectedCount < 3) return 'low';
  if (selectedCount <= 6) return 'medium';
  return 'high';
}

function summariseAgentTooling(
  snapshot: AgentToolingSnapshot,
): Pick<AgentToolingSnapshot, 'agents_md_present' | 'agents_md_title' | 'agents_rules' | 'skills' | 'mcp_servers'> {
  return {
    agents_md_present: snapshot.agents_md_present,
    agents_md_title: snapshot.agents_md_title,
    agents_rules: snapshot.agents_rules.slice(0, 5),
    skills: snapshot.skills.slice(0, 5),
    mcp_servers: snapshot.mcp_servers.slice(0, 5),
  };
}

function formatSkillSummary(skill: AgentToolingSnapshot['skills'][number]): string {
  const markers: string[] = [];
  if (skill.scripts_present) markers.push('scripts');
  if (skill.references_present) markers.push('references');
  if (skill.assets_present) markers.push('assets');
  const suffix = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
  return `${skill.name}${skill.description ? `: ${skill.description}` : ''}${suffix}`;
}

function formatMcpServerSummary(server: AgentToolingSnapshot['mcp_servers'][number]): string {
  const availability = server.availability === 'missing_command'
    ? 'missing-command'
    : server.availability;
  return `${server.name} (${server.transport}, ${availability})`;
}

function isExecutionSensitiveTarget(target: string): boolean {
  const terms = target.toLowerCase();
  return [
    'package.json',
    'makefile',
    'pyproject',
    'cargo',
    'go.mod',
    'docker',
    'workflow',
    'github',
    'git',
    'npm',
    'pnpm',
    'python',
    'shell',
    'env',
    'mcp',
    'skill',
    'agent',
    'build',
    'test',
    'lint',
  ].some((token) => terms.includes(token));
}

function tokenise(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_\/-]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function matchesPath(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars but keep globs intact
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__GLOB__')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__GLOB__/g, '[^/]*') + '$';
  return new RegExp(regexStr).test(target);
}

function summariseScopedItem(item: { id: string; text: string; created_at: string }): ScopedActivityItemSummary {
  return {
    id: item.id,
    text: item.text,
    age_hours: Math.max(0, Math.floor((Date.now() - Date.parse(item.created_at)) / 3_600_000)),
  };
}

function isRecent(createdAt: string, hours: number): boolean {
  return Date.now() - Date.parse(createdAt) <= hours * 3_600_000;
}

function matchesScopeTarget(
  item: { text: string; tags: string[]; related_paths?: string[]; project?: string },
  target: string,
  project?: string,
): boolean {
  if (project && item.project && item.project !== project) {
    return false;
  }

  if (item.related_paths && item.related_paths.length > 0) {
    return item.related_paths.some((pattern) => matchesPath(pattern, target));
  }

  const terms = scopeTerms(target);
  if (terms.length === 0) {
    return false;
  }
  const haystack = `${item.text.toLowerCase()} ${(item.tags ?? []).join(' ').toLowerCase()}`;
  return terms.some((term) => haystack.includes(term));
}

function scopeTerms(target: string): string[] {
  const direct = tokenise(target);
  const segments = target
    .split(/[\\/]/)
    .flatMap((segment) => tokenise(segment));
  return [...new Set([...direct, ...segments])];
}

function computeRelevance(item: ContextItem, terms: string[], profile: string, target: string): {
  score: number;
  reasons: string[];
} {
  let score = 1;
  const reasons: string[] = ['base memory signal'];

  // Path filtering logic
  if (item.related_paths && item.related_paths.length > 0 && target) {
    const isMatch = item.related_paths.some(p => matchesPath(p, target));
    if (isMatch) {
      score += 10; // High boost for direct spatial match
      reasons.push('path match');
    } else {
      return { score: -1, reasons: ['filtered out: path mismatch'] };
    }
  }

  // Profile weighting
  // Plans are always highest priority (actionable items)
  if (item.section === 'plan') {
    score += 4;
    reasons.push('execution boost');
  }
  // Open handoffs are second-highest (pending transitions)
  if (item.section === 'handoff') {
    score += 3;
    reasons.push('open handoff signal');
  }
  if (item.section === 'runtime') {
    score += 1;
    reasons.push('runtime execution signal');
  }
  if (profile === 'dev' && (item.section === 'decision' || item.section === 'trap')) {
    score += 2;
    reasons.push('profile boost: dev');
  }
  if (profile === 'openclaw' && (item.section === 'constraint' || item.section === 'handoff' || item.section === 'runtime')) {
    score += 2;
    reasons.push('profile boost: openclaw');
  }
  if (profile === 'ops' && (item.section === 'constraint' || item.section === 'trap')) {
    score += 2;
    reasons.push('profile boost: ops');
  }
  if (profile === 'research' && (item.section === 'decision' || item.section === 'candidate')) {
    score += 2;
    reasons.push('profile boost: research');
  }

  if (item.section === 'candidate') {
    const starMatch = (item.extra ?? '').match(/stars:(\d+)/);
    const useMatch = (item.extra ?? '').match(/uses:(\d+)/);
    const stars = starMatch ? parseInt(starMatch[1], 10) : 0;
    const uses = useMatch ? parseInt(useMatch[1], 10) : 0;
    if (stars > 0) {
      score += Math.min(stars, 3);
      reasons.push(`adoption signal:${stars} star(s)`);
    }
    if (uses > 0) {
      score += Math.min(uses * 2, 4);
      reasons.push(`reuse signal:${uses} use(s)`);
    }
  }

  if (terms.length === 0) return { score, reasons };

  const text = item.text.toLowerCase();
  const tags = item.tags.map((t) => t.toLowerCase());
  const extra = (item.extra ?? '').toLowerCase();

  for (const term of terms) {
    if (text.includes(term)) {
      score += 3;
      reasons.push(`text match:${term}`);
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 2;
      reasons.push(`tag match:${term}`);
    }
    if (extra.includes(term)) {
      score += 1;
      reasons.push(`metadata match:${term}`);
    }
  }

  return { score, reasons: uniqueReasons(reasons) };
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function estimateItemChars(item: ContextItem): number {
  const tagsLen = item.tags.join(', ').length;
  const reasonsLen = item.reasons.join(', ').length;
  const extraLen = item.extra?.length ?? 0;
  return item.text.length + tagsLen + reasonsLen + extraLen + 32;
}

function applyCharBudget(items: ContextItem[], maxChars: number): ContextItem[] {
  let used = 0;
  const selected: ContextItem[] = [];

  for (const item of items) {
    const itemChars = estimateItemChars(item);
    if (selected.length > 0 && used + itemChars > maxChars) {
      break;
    }

    selected.push(item);
    used += itemChars;
  }

  return selected;
}
