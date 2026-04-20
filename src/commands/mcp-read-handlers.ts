/**
 * MCP read-only tool handlers.
 *
 * Extracted from mcp.ts to reduce file size. These handlers do not mutate
 * state — they build context, list items, search, and inspect.
 *
 * @module
 */
import { getTriggeredItems, renderTriggeredItems } from '../core/lifecycle.js';
import { applyBootstrapImport, renderBootstrapInterview, renderBootstrapSummary, runBootstrapProfile, uninstallBootstrapImport } from '../core/bootstrap.js';
import { buildAgentToolingContext, renderAgentToolingSummary } from '../core/agent-context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { scanDescendantPlans } from './list-plans.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { buildExecutionContext, renderExecutionContextSummary } from '../core/execution-context.js';
import { checkBrainclawInstallableUpdate, getInstalledBrainclawVersion, readDiskBrainclawVersion, renderBrainclawInstallableUpdateNotice } from '../core/brainclaw-version.js';
import { loadConfig } from '../core/config.js';
import { loadAllSessions, loadCurrentSession, saveCurrentSession, gcStaleSessions } from '../core/identity.js';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';
import { listArchivedCandidates, listCandidates, resolvedSource } from '../core/candidates.js';
import type { CandidateSource } from '../core/schema.js';
import { listClaims, assessClaimLiveness } from '../core/claims.js';
import { listAssignments } from '../core/assignments.js';
import { listAgentRuns } from '../core/agentruns.js';
import { listActionRequired } from '../core/actions.js';
import { queryRuntimeEvents } from '../core/events.js';
import { listSequences, getActiveSequence } from '../core/sequence.js';
import { resolveCurrentHostId } from '../core/host.js';
import {
  listAgentIdentities,
  resolveAgentScope,
  resolveCurrentAgentIdentity,
  resolveCurrentAgentName,
} from '../core/agent-registry.js';
import { readAuditLog, type AuditAction } from '../core/audit.js';
import { readInbox, getThread } from '../core/messaging.js';
import { analyzeSequence } from '../core/dispatcher.js';
import { checkPolicy } from '../core/policy.js';
import { buildGovernanceReport, renderGovernanceMarkdown } from '../core/governance.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from '../core/instructions.js';
import { buildReputationSnapshot, toPublicReputationSummary } from '../core/reputation.js';
import { search } from '../core/search.js';
import { buildEstimationReport } from './estimation-report.js';
import { runDoctor } from './doctor.js';
import { buildProjectDiscovery, saveDiscoveryProfile, loadDiscoveryProfile, renderDiscoverySummary } from '../core/project-discovery.js';
import { listCapabilities, listTools as listRegistryTools } from '../core/registries.js';
import { listAvailableProjects, switchProject } from './switch.js';
import { resolveEffectiveCwd, resolveProjectRef, resolveStoreChain } from '../core/store-resolution.js';
import { readUnseenEvents, buildNotificationSummary } from '../core/event-log.js';
import { BootstrapInterviewAnswerSchema, AssignmentStatusSchema, AgentRunStatusSchema, AgentRunTransportSchema, ActionRequiredStatusSchema, ActionRequiredKindSchema } from '../core/schema.js';
import type { ActionRequiredKind, ActionRequiredStatus, AssignmentStatus, BootstrapInterviewAnswer, PlanStatus, PlanType, RuntimeEventType, SequenceStatus } from '../core/schema.js';
import {
  type McpToolResponse,
  type McpReadToolContext,
  SCHEMA_VERSION,
  createToolErrorResponse,
  normaliseFormat,
  renderContextForMcp,
} from './mcp.js';

function normalizeBootstrapInterviewAnswersArg(value: unknown): BootstrapInterviewAnswer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => BootstrapInterviewAnswerSchema.parse(entry));
}

/** Validate a string enum filter or return undefined. Throws on invalid. */
function validateEnumFilter<T extends string>(value: unknown, schema: { safeParse: (v: unknown) => { success: boolean } }, label: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const str = String(value);
  const result = schema.safeParse(str);
  if (!result.success) {
    throw new Error(`Invalid ${label}: '${str}'`);
  }
  return str as T;
}

function normalizeBootstrapInterviewAudienceArg(value: unknown): 'cli' | 'ide_chat' | 'any' {
  if (value === 'cli' || value === 'ide_chat' || value === 'any') {
    return value;
  }
  return 'any';
}

function getReviewAssignee(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith('assignee:')) {
      return tag.slice('assignee:'.length).trim() || undefined;
    }
  }
  return undefined;
}

export function handleMcpReadToolCall(
  name: string,
  args: Record<string, unknown> = {},
  context: McpReadToolContext = {},
): McpToolResponse {
  let cwd = context.cwd ?? resolveEffectiveCwd();

  // If a project param is provided, resolve it to an actual cwd override
  const projectArg = args.project as string | undefined;
  if (projectArg) {
    const resolvedProject = resolveProjectRef(projectArg, cwd);
    if (resolvedProject) {
      cwd = resolvedProject;
    }
  }

  if (name === 'bclaw_get_context') {
    const result = buildContext({
      target: args.path as string | undefined,
      project: projectArg,
      agent: args.agent as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      profile: args.profile as 'dev' | 'dense' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick' | undefined,
      includePending: args.includePending as boolean | undefined,
      maxItems: args.maxItems as number | undefined,
      maxChars: args.maxChars as number | undefined,
      digest: args.digest as boolean | undefined,
      sinceSession: args.since_session as string | undefined,
      bootstrap: args.bootstrap as boolean | undefined,
      refreshBootstrap: args.refreshBootstrap as boolean | undefined,
      cwd,
    });

    // Load available capabilities and tools from dedicated registries
    const capabilities = listCapabilities(cwd);
    const tools = listRegistryTools(cwd);

    const format = normaliseFormat(args.format);
    const content = renderContextForMcp(result, format, {
      explain: args.explain as boolean | undefined,
      compactTemplate: args.compactTemplate as boolean | undefined,
    });

    // Add metadata discovery section to content
    let enrichedContent = content;
    if (capabilities.length > 0 || tools.length > 0) {
      const suggestions: string[] = [];
      if (capabilities.length > 0) {
        suggestions.push(`\n## Available Capabilities (${capabilities.length})`);
        capabilities.slice(0, 5).forEach((cap) => {
          suggestions.push(`- [${cap.id}] ${cap.name} (${cap.category})`);
        });
        if (capabilities.length > 5) {
          suggestions.push(`- ... and ${capabilities.length - 5} more`);
        }
      }
      if (tools.length > 0) {
        suggestions.push(`\n## Available Tools (${tools.length})`);
        tools.slice(0, 5).forEach((tool) => {
          suggestions.push(`- [${tool.id}] ${tool.name} (${tool.type})`);
        });
        if (tools.length > 5) {
          suggestions.push(`- ... and ${tools.length - 5} more`);
        }
      }
      suggestions.push('\n💡 Tip: Use bclaw_get_capabilities, bclaw_list_tools, or bclaw_search_tools for detailed discovery');
      enrichedContent = content + suggestions.join('\n');
    }

    // Check for unseen events from other agents
    const agentName = (args.agent as string) ?? resolveCurrentAgentName(cwd);
    const unseenEvents = readUnseenEvents(agentName, cwd);
    const notifications = buildNotificationSummary(unseenEvents);

    return {
      content: [{ type: 'text', text: enrichedContent || 'No relevant memory found.' }],
      structuredContent: {
        ...result,
        available_capabilities: capabilities.map((cap) => ({
          id: cap.id,
          name: cap.name,
          category: cap.category,
        })),
        available_tools: tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          type: tool.type,
        })),
        ...(notifications ? { pending_notifications: notifications, unseen_event_count: unseenEvents.length } : {}),
      },
    };
  }

  if (name === 'bclaw_bootstrap') {
    const interviewAnswers = normalizeBootstrapInterviewAnswersArg(args.interviewAnswers);
    if (args.apply && args.uninstall) {
      throw new Error('bclaw_bootstrap does not allow apply and uninstall at the same time.');
    }
    if (args.uninstall) {
      const result = uninstallBootstrapImport(cwd);
      const text = !result.receipt
        ? 'No bootstrap import receipt found.'
        : `Bootstrap uninstall completed: ${result.deactivatedCount} instruction(s) deactivated, ${result.deletedCount} artifact(s) deleted, ${result.skippedCount} artifact(s) skipped.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          receipt: result.receipt,
          deactivated_count: result.deactivatedCount,
          deleted_count: result.deletedCount,
          skipped_count: result.skippedCount,
        },
      };
    }
    if (args.apply) {
      const applied = applyBootstrapImport({
        target: args.target as string | undefined,
        refresh: args.refresh as boolean | undefined,
        interviewAnswers,
        cwd,
      });
      return {
        content: [{
          type: 'text',
          text: `Bootstrap import applied: ${applied.createdCount} item(s) created, ${applied.skippedCount} suggestion(s) skipped.`,
        }],
        structuredContent: {
          created_count: applied.createdCount,
          skipped_count: applied.skippedCount,
          receipt: applied.receipt,
          import_plan: applied.proposal,
        },
      };
    }
    const result = runBootstrapProfile({
      target: args.target as string | undefined,
      refresh: args.refresh as boolean | undefined,
      interviewAnswers,
      cwd,
    });
    const audience = normalizeBootstrapInterviewAudienceArg(args.audience);
    const text = args.interview
      ? renderBootstrapInterview(result, audience)
      : renderBootstrapSummary(result);

    // Extract top-level suggested questions for conversational bootstrap (step 11)
    const suggestedQuestions = result.importPlan.interview?.questions?.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      rationale: q.rationale,
      priority: q.priority,
    })) ?? [];

    // Separate auto-imports (high confidence) from proposals (need discussion)
    const autoImports = result.importPlan.suggestions.filter((s) => s.confidence === 'high');
    const proposals = result.importPlan.suggestions.filter((s) => s.confidence !== 'high');

    return {
      content: [{ type: 'text', text }],
        structuredContent: {
          summary: result.profile.summary,
          target: result.profile.target,
          repo_fingerprint: result.profile.repo_fingerprint,
          sources_scanned: result.profile.sources_scanned,
          workspace_kind: result.profile.workspace_kind,
        onboarding_mode: result.profile.onboarding_mode,
        confidence: result.profile.confidence,
        native_instruction_files: result.profile.native_instruction_files,
        gaps: result.profile.gaps,
        seed_count: result.profile.seed_count,
        seeds: result.seeds,
        import_plan: result.importPlan,
        auto_imports: autoImports,
        proposals,
        suggested_questions: suggestedQuestions,
        last_application: result.lastApplication,
        reused_profile: result.reusedProfile,
      },
    };
  }

  if (name === 'bclaw_get_execution_context') {
    const executionContext = buildExecutionContext({ cwd });
    const config = loadConfig(cwd);
    const installableUpdate = checkBrainclawInstallableUpdate(config, cwd, { useDefaultNpmSource: true });
    const installableUpdateNotice = renderBrainclawInstallableUpdateNotice(installableUpdate);
    const agentTooling = args.includeAgentTooling ? buildAgentToolingContext({ cwd }) : undefined;
    const text = [
      renderExecutionContextSummary(executionContext, true),
      ...(installableUpdateNotice ? ['', installableUpdateNotice] : []),
      ...(agentTooling ? ['', renderAgentToolingSummary(agentTooling)] : []),
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        execution_context: executionContext,
        installable_update: {
          ...installableUpdate,
          ...(installableUpdate.agent_release_notes
            ? { agent_release_notes: installableUpdate.agent_release_notes }
            : {}),
        },
        ...(agentTooling ? { agent_tooling: agentTooling } : {}),
      },
    };
  }

  if (name === 'bclaw_release_notes') {
    const config = loadConfig(cwd);
    const updateCheck = checkBrainclawInstallableUpdate(config, cwd, { useDefaultNpmSource: true });
    const arn = updateCheck.agent_release_notes;
    const lines: string[] = [];
    if (arn) {
      lines.push(`Version: ${updateCheck.latest_installable_version ?? 'unknown'}`);
      lines.push(`Summary: ${arn.summary}`);
      if (arn.agent_relevance) lines.push(`Agent relevance: ${arn.agent_relevance}`);
      lines.push(`Breaking risk: ${arn.breaking_risk ?? 'none'}`);
      if (arn.recommended_for && arn.recommended_for.length > 0) {
        lines.push(`Recommended for: ${arn.recommended_for.join(', ')}`);
      }
      if (arn.highlights && arn.highlights.length > 0) {
        lines.push('Highlights:');
        for (const h of arn.highlights) lines.push(`  • ${h}`);
      }
      if (arn.action_recommendation) lines.push(`Action: ${arn.action_recommendation}`);
    } else if (updateCheck.release_notes) {
      lines.push(`Version: ${updateCheck.latest_installable_version ?? 'unknown'}`);
      lines.push(updateCheck.release_notes);
    } else {
      lines.push('No agent release notes available for the configured update source.');
      if (updateCheck.status === 'not_configured') {
        lines.push('Configure brainclaw_update_source in your project config to enable update checks.');
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        status: updateCheck.status,
        latest_installable_version: updateCheck.latest_installable_version,
        agent_release_notes: arn ?? null,
        release_notes: updateCheck.release_notes ?? null,
      },
    };
  }

  if (name === 'bclaw_read_handoff') {
    const state = loadState(cwd);
    const handoff = state.open_handoffs.find((entry) => entry.id === args.id);
    let text = `Handoff not found: ${String(args.id)}`;
    if (handoff) {
      text = `From: ${handoff.from}\nTo: ${handoff.to}\nTask: ${handoff.text}\n`;
      if (handoff.plan_id) text += `Plan: ${handoff.plan_id}\n`;
      if (handoff.narrative) text += `\n--- Narrative ---\n${handoff.narrative}\n`;
      if (handoff.contract) {
        const c = handoff.contract;
        text += '\n--- Contract ---\n';
        if (c.files_touched?.length) text += `Files touched:\n${c.files_touched.map(f => `  - ${f}`).join('\n')}\n`;
        if (c.pre_conditions?.length) text += `Pre-conditions:\n${c.pre_conditions.map(p => `  - ${p}`).join('\n')}\n`;
        if (c.post_conditions?.length) text += `Post-conditions:\n${c.post_conditions.map(p => `  - ${p}`).join('\n')}\n`;
        if (c.tests_to_verify?.length) text += `Tests to verify:\n${c.tests_to_verify.map(t => `  - ${t}`).join('\n')}\n`;
        if (c.linked_plans?.length) text += `Linked plans:\n${c.linked_plans.map(l => `  - ${l}`).join('\n')}\n`;
      }
      if (handoff.review) {
        const review = handoff.review;
        text += '\n--- Review ---\n';
        if (review.requester) text += `Requester: ${review.requester}\n`;
        if (review.reviewer) text += `Reviewer: ${review.reviewer}\n`;
        if (review.requested_at) text += `Requested at: ${review.requested_at}\n`;
        if (review.thread_id) text += `Thread: ${review.thread_id}\n`;
        if (review.message_id) text += `Review message: ${review.message_id}\n`;
        if (review.verdict) text += `Verdict: ${review.verdict}\n`;
        if (review.reviewed_by) text += `Reviewed by: ${review.reviewed_by}\n`;
        if (review.reviewed_at) text += `Reviewed at: ${review.reviewed_at}\n`;
        if (review.summary) text += `Summary: ${review.summary}\n`;
        if (review.blocking_issues?.length) text += `Blocking issues:\n${review.blocking_issues.map((issue) => `  - ${issue}`).join('\n')}\n`;
        if (review.suggestions?.length) text += `Suggestions:\n${review.suggestions.map((suggestion) => `  - ${suggestion}`).join('\n')}\n`;
      }
      text += '\n';
      if (handoff.snapshot?.diff) {
        text += `--- Uncommitted Git Diff ---\n\`\`\`diff\n${handoff.snapshot.diff}\n\`\`\`\n`;
      }
    }
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'bclaw_get_agent_board_summary') {
    const config = loadConfig(cwd);
    const state = loadState(cwd);
    const agent = (args.agent as string | undefined) ?? resolveCurrentAgentName(cwd);
    const currentHost = resolveCurrentHostId();
    const activeClaims = listClaims(cwd).filter((c) => c.status === 'active');
    const pendingActions = listActionRequired(cwd).filter((a) => a.status === 'pending');
    const agents = listAgentIdentities(cwd);
    const sessions = loadAllSessions(cwd);
    const activeSequence = getActiveSequence(cwd);
    const sequenceTodoCount = activeSequence
      ? activeSequence.items.filter((item) => {
          const plan = state.plan_items.find((p) => p.id === item.planId || p.short_label === item.planId);
          return !plan || plan.status === 'todo';
        }).length
      : 0;
    const summary = {
      project_id: config.project_id,
      agent,
      current_host: currentHost,
      attention_required: pendingActions.length,
      in_progress: activeClaims.length,
      plans: {
        in_progress: state.plan_items.filter((p) => p.status === 'in_progress').length,
        todo: state.plan_items.filter((p) => p.status === 'todo').length,
      },
      traps: {
        high: state.known_traps.filter((t) => t.severity === 'high').length,
        total: state.known_traps.length,
      },
      agents: agents.length,
      sessions: sessions.length,
      sequences: {
        active_name: activeSequence?.name ?? null,
        todo_count: sequenceTodoCount,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  }

  if (name === 'bclaw_get_agent_board') {
    const board = buildCoordinationSnapshot({
      agent: args.agent as string | undefined,
      project: args.project as string | undefined,
      target: args.path as string | undefined,
      host: args.host as string | undefined,
      allHosts: args.allHosts as boolean | undefined,
      includeReputation: args.includeReputation as boolean | undefined,
      includeSessionMeta: args.includeSessionMeta as boolean | undefined,
      autoAcknowledge: true,
      cwd,
    });
    const lines: string[] = [];
    lines.push(`Agent board${board.agent ? ` for ${board.agent}` : ''}${board.project ? ` (${board.project})` : ''}`);
    lines.push('');
    if (board.project_id) lines.push(`Project ID: ${board.project_id}`);
    if (board.agent && board.agent_id) lines.push(`Agent ID: ${board.agent_id}`);
    lines.push(`Current host: ${board.current_host}`);
    if (board.all_hosts) lines.push('Host filter: all-hosts');
    else if (board.host_filter) lines.push(`Host filter: ${board.host_filter}`);
    if (args.includeReputation && board.reputation_summary) {
      lines.push(`Reputation: tracked=${board.reputation_summary.tracked_agents}, avg_trust=${board.reputation_summary.avg_internal_trust}`);
      if (board.agent_reputation) {
        lines.push(`Agent trust: ${board.agent_reputation.internal_trust} (cq=${board.agent_reputation.contribution_quality}, rv=${board.agent_reputation.review_reliability}, ct=${board.agent_reputation.continuity_hygiene})`);
      }
    }
    lines.push(`Active plans: ${board.active_plans.length}`);
    for (const plan of board.active_plans.slice(0, 10)) {
      const claims = plan.claims.length ? ` claims=${plan.claims.map((claim) => claim.agent).join(',')}` : '';
      lines.push(`- [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
    }
    lines.push(`Active claims: ${board.active_claims.length}`);
    for (const claim of board.active_claims.slice(0, 10)) {
      const identity = claim.agent_id ? ` [${claim.agent_id}]` : '';
      const session = claim.session_id ? ` session=${claim.session_id}` : '';
      const liveness = assessClaimLiveness(claim).status;
      const liveTag = liveness === 'live' || liveness === 'young' ? '' : ` [${liveness.toUpperCase()}]`;
      lines.push(`- [${claim.id}] ${claim.agent}${identity} -> ${claim.scope}${claim.plan_id ? ` (plan ${claim.plan_id})` : ''}${session}${liveTag}`);
    }
    lines.push(`Active assignments: ${board.active_assignments.length}`);
    for (const assignment of board.active_assignments.slice(0, 10)) {
      const plan = assignment.plan_id ? ` plan=${assignment.plan_id}` : '';
      const session = assignment.session_id ? ` session=${assignment.session_id}` : '';
      lines.push(`- [${assignment.id}] ${assignment.agent} (${assignment.status}) -> ${assignment.scope}${plan}${session}`);
    }
    lines.push(`Active runs: ${board.active_runs.length}`);
    for (const run of board.active_runs.slice(0, 10)) {
      const assignment = run.assignment_id ? ` assignment=${run.assignment_id}` : '';
      const attempt = ` attempt=${run.attempt_index}`;
      const session = run.session_id ? ` session=${run.session_id}` : '';
      lines.push(`- [${run.id}] ${run.agent} (${run.status}/${run.transport}) -> ${run.scope}${assignment}${attempt}${session}`);
    }
    lines.push(`Pending actions: ${board.active_actions.length}`);
    for (const action of board.active_actions.slice(0, 10)) {
      const run = action.run_id ? ` run=${action.run_id}` : '';
      const session = action.session_id ? ` session=${action.session_id}` : '';
      lines.push(`- [${action.id}] ${action.agent} (${action.kind}) -> ${action.title}${run}${session}`);
    }
    lines.push(`Active sequence: ${board.active_sequence ? `1 (${board.active_sequence.name})` : '0'}`);
    if (board.active_sequence) {
      lines.push(`- [${board.active_sequence.id}] ${board.active_sequence.name} (${board.active_sequence.status})`);
      for (const item of board.active_sequence.items.slice(0, 10)) {
        const lane = item.lane ? ` lane=${item.lane}` : '';
        const hardAfter = item.hard_after.length ? ` hard_after=${item.hard_after.join(',')}` : '';
        const softAfter = item.soft_after.length ? ` soft_after=${item.soft_after.join(',')}` : '';
        lines.push(`  #${item.rank} ${item.planId}${lane}${hardAfter}${softAfter}`);
      }
    }
    const sessionMetaHint = board.session_meta_hidden > 0 ? ` (+${board.session_meta_hidden} session lifecycle notes hidden — pass includeSessionMeta to show)` : '';
    lines.push(`Runtime notes: ${board.runtime_notes.length}${sessionMetaHint}`);
    for (const note of board.runtime_notes.slice(-10)) {
      const scope = note.visibility === 'shared' ? 'shared' : `${note.visibility}:${note.host_id ?? 'unknown-host'}`;
      const identity = note.agent_id ? ` [${note.agent_id}]` : '';
      lines.push(`- [${note.id}] ${note.agent}${identity}: ${note.text}${note.plan_id ? ` (plan ${note.plan_id})` : ''} [${scope}]`);
    }
    lines.push(`Open handoffs: ${board.open_handoffs.length}`);
    for (const handoff of board.open_handoffs.slice(0, 10)) {
      const contractHint = handoff.contract ? ' [contract]' : '';
      lines.push(`- [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}${contractHint}`);
    }
    lines.push(`Resolved instructions: ${board.resolved_instructions.length}`);
    for (const instruction of board.resolved_instructions.slice(0, 10)) {
      lines.push(`- [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
    }
    if (board.other_agents && board.other_agents.length > 0) {
      lines.push(`Other agents: ${board.other_agents.length}`);
      for (const other of board.other_agents) {
        lines.push(`- ${other.name}: ${other.claim_count} claim(s) on ${other.scopes.join(', ')}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ...board },
    };
  }

  if (name === 'bclaw_search') {
    const query = String(args.query ?? '');
    if (!query) {
      throw new Error('Missing required argument: query');
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const allResults = search({
      query,
      section: (args.section ?? args.type) as string | undefined,
      since: args.since as string | undefined,
      maxResults: offset + limit,
      cwd,
    });
    const total = allResults.length;
    const page = allResults.slice(offset, offset + limit);
    const lines = page.map((result) => `[${result.id}] (${result.section}) score=${result.score.toFixed(2)}: ${result.text.slice(0, 120)}`);
    return {
      content: [{ type: 'text', text: page.length > 0 ? lines.join('\n') : 'No results found.' }],
      structuredContent: { total, offset, limit, results: page },
    };
  }

  if (name === 'bclaw_estimation_report') {
    const report = buildEstimationReport({ agent: args.agent as string | undefined, cwd });
    const lines: string[] = [`Estimation Report — ${report.summary.total} completed plan(s)`];
    if (report.summary.calibration_hint) {
      lines.push(`Calibration: ${report.summary.calibration_hint}`);
      lines.push(`Median ratio: ${report.summary.median_ratio}x · Mean: ${report.summary.mean_ratio}x`);
    }
    for (const e of report.entries) {
      const est = e.estimated_minutes !== undefined ? `est:${e.estimated_minutes}min` : 'no estimate';
      const act = e.elapsed_minutes !== undefined ? `actual:${e.elapsed_minutes}min` : 'no actual';
      const ratio = e.ratio !== undefined ? ` ratio:${e.ratio}x` : '';
      lines.push(`[${e.id.slice(0, 8)}] ${e.text.slice(0, 60)} — ${est} · ${act}${ratio}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: report as unknown as Record<string, unknown>,
    };
  }

  if (name === 'bclaw_list_plans') {
    let plans = loadState(cwd).plan_items;

    // Direct lookup by ID
    if (args.id) {
      const plan = plans.find((p) => p.id === String(args.id) || p.short_label === String(args.id));
      if (!plan) {
        return { content: [{ type: 'text', text: `Plan '${args.id}' not found.` }], structuredContent: { total: 0, plans: [] } };
      }
      return {
        content: [{ type: 'text', text: `[${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})` }],
        structuredContent: { total: 1, plans: [plan] },
      };
    }

    // Filters
    if (!args.all) {
      plans = plans.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
    }
    if (args.status) {
      plans = plans.filter((plan) => plan.status === args.status);
    }
    if (args.type) {
      plans = plans.filter((plan) => plan.type === args.type);
    }
    if (args.assignee) {
      const assignee = String(args.assignee).toLowerCase();
      plans = plans.filter((plan) => plan.assignee?.toLowerCase() === assignee);
    }
    if (args.project) {
      const project = String(args.project).toLowerCase();
      plans = plans.filter((plan) => plan.project?.toLowerCase() === project);
    }

    const totalFiltered = plans.length;

    // Descendant discovery
    const descendantGroups = args.recursive
      ? scanDescendantPlans(cwd, {
          all: args.all as boolean | undefined,
          status: args.status as PlanStatus | undefined,
          type: args.type as PlanType | undefined,
          assignee: args.assignee as string | undefined,
          project: args.project as string | undefined,
        })
      : [];
    const totalDescendantPlans = descendantGroups.reduce((sum, g) => sum + g.plans.length, 0);

    // Pagination (local plans only)
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const paginated = plans.slice(offset, offset + limit);

    const lines: string[] = [];
    if (args.recursive) {
      lines.push(`── local (${totalFiltered} plans) ──`);
    }
    if (paginated.length === 0 && !args.recursive) {
      lines.push('No plan items found.');
      // Signal descendant plans when 0 local results
      if (!args.recursive) {
        const signalGroups = scanDescendantPlans(cwd, {
          all: args.all as boolean | undefined,
          status: args.status as PlanStatus | undefined,
        });
        const signalTotal = signalGroups.reduce((sum, g) => sum + g.plans.length, 0);
        if (signalTotal > 0) {
          lines.push(`ℹ ${signalTotal} plan(s) found in ${signalGroups.length} descendant project(s) (use recursive: true to see all)`);
        }
      }
    } else if (paginated.length > 0) {
      if (!args.recursive) {
        lines.push(`${totalFiltered} plan(s)${totalFiltered > paginated.length ? ` (showing ${offset + 1}-${offset + paginated.length})` : ''}:`);
      }
      for (const plan of paginated) {
        const meta: string[] = [plan.type ?? 'feat', plan.status, plan.priority];
        if (plan.assignee) meta.push(`assignee ${plan.assignee}`);
        if (plan.project) meta.push(`project ${plan.project}`);
        if (plan.depends_on.length > 0) meta.push(`depends_on ${plan.depends_on.join(',')}`);
        const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
        lines.push(`[${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`);
      }
    } else {
      lines.push('  (none)');
    }

    // Append descendant groups
    for (const group of descendantGroups) {
      const label = group.project_name ?? group.relative_path;
      lines.push(`\n── ${label} (${group.plans.length} plans) ──`);
      for (const plan of group.plans) {
        const meta: string[] = [plan.type ?? 'feat', plan.status, plan.priority];
        const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
        lines.push(`[${plan.id}] ${plan.text} (${meta.join(' · ')})${tags}`);
      }
    }

    // Compact mode: strip heavy fields
    const outputPlans = args.compact
      ? paginated.map(({ id, short_label, text, status, priority, tags, assignee, type }) => ({
          id, short_label, text, status, priority, tags, assignee, type,
        }))
      : paginated;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        total: totalFiltered,
        offset,
        limit,
        plans: outputPlans,
        ...(descendantGroups.length > 0 ? { descendants: descendantGroups, total_with_descendants: totalFiltered + totalDescendantPlans } : {}),
      },
    };
  }

  if (name === 'bclaw_list_sequences') {
    const status = args.status as SequenceStatus | undefined;
    const id = args.id as string | undefined;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    let sequences = listSequences(cwd);
    if (status) {
      sequences = sequences.filter((sequence) => sequence.status === status);
    }
    if (id) {
      sequences = sequences.filter((sequence) => sequence.id === id || sequence.short_label === id);
    }

    const total = sequences.length;
    const page = sequences.slice(offset, offset + limit);
    const compact = args.compact === true;
    const lines = page.length === 0
      ? ['No sequences found.']
      : [
          `${total} sequence(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((sequence) => compact
            ? `[${sequence.id}] ${sequence.name} (${sequence.status})`
            : `[${sequence.id}] ${sequence.name} (${sequence.status}, items=${sequence.items.length})`),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, sequences: page },
    };
  }

  if (name === 'bclaw_list_claims') {
    let claims = listClaims(cwd);
    if (!args.all) {
      claims = claims.filter((claim) => claim.status === 'active');
    }
    if (args.project) {
      claims = claims.filter((claim) => claim.project === args.project);
    }
    if (args.plan) {
      claims = claims.filter((claim) => claim.plan_id === args.plan);
    }
    if (args.agent) {
      claims = claims.filter((claim) => claim.agent === args.agent);
    }

    const total = claims.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = claims.slice(offset, offset + limit);
    const label = args.all ? 'claim(s)' : 'active claim(s)';

    const lines = page.length === 0
      ? ['No active claims.']
      : [
          `${total} ${label}${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((claim) => {
            const status = claim.status !== 'active' ? ` (${claim.status})` : '';
            const extras: string[] = [];
            if (claim.session_id) extras.push(`session ${claim.session_id.slice(-8)}`);
            if (claim.plan_id) extras.push(`plan ${claim.plan_id}`);
            if (claim.project) extras.push(`project ${claim.project}`);
            const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
            return `[${claim.id}] ${claim.agent} -> ${claim.scope}: ${claim.description}${suffix}${status}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, claims: page },
    };
  }

  if (name === 'bclaw_list_assignments') {
    const status = validateEnumFilter<AssignmentStatus>(args.status, AssignmentStatusSchema, 'assignment status');
    const id = args.id as string | undefined;
    const claimId = args.claimId as string | undefined;
    const planId = args.planId as string | undefined;
    const sequenceId = args.sequenceId as string | undefined;
    const agent = args.agent as string | undefined;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    let assignments = listAssignments(cwd, {
      ...(status ? { status } : {}),
      ...(agent ? { agent } : {}),
      ...(claimId ? { claim_id: claimId } : {}),
      ...(planId ? { plan_id: planId } : {}),
      ...(sequenceId ? { sequence_id: sequenceId } : {}),
    });
    if (id) {
      assignments = assignments.filter((assignment) =>
        assignment.id === id || assignment.short_label === id,
      );
    }

    const total = assignments.length;
    const page = assignments.slice(offset, offset + limit);
    const compact = args.compact === true;
    const lines = page.length === 0
      ? ['No assignments found.']
      : [
          `${total} assignment(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((assignment) => {
            if (compact) {
              return `[${assignment.id}] ${assignment.agent} (${assignment.status}) -> ${assignment.scope}`;
            }
            const refs: string[] = [];
            if (assignment.claim_id) refs.push(`claim ${assignment.claim_id}`);
            if (assignment.plan_id) refs.push(`plan ${assignment.plan_id}`);
            if (assignment.sequence_id) refs.push(`sequence ${assignment.sequence_id}`);
            if (assignment.session_id) refs.push(`session ${assignment.session_id.slice(-8)}`);
            const suffix = refs.length ? ` [${refs.join(', ')}]` : '';
            return `[${assignment.id}] ${assignment.agent} (${assignment.status}) -> ${assignment.scope}: ${assignment.description}${suffix}`;
          }),
        ];

    const outputAssignments = compact
      ? page.map((assignment) => ({
          id: assignment.id,
          short_label: assignment.short_label,
          agent: assignment.agent,
          status: assignment.status,
          scope: assignment.scope,
          claim_id: assignment.claim_id,
          plan_id: assignment.plan_id,
          sequence_id: assignment.sequence_id,
          updated_at: assignment.updated_at,
          last_heartbeat_at: assignment.last_heartbeat_at,
        }))
      : page;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, assignments: outputAssignments },
    };
  }

  if (name === 'bclaw_list_runs') {
    const status = validateEnumFilter<import('../core/schema.js').AgentRunStatus>(args.status, AgentRunStatusSchema, 'run status');
    const transport = validateEnumFilter<import('../core/schema.js').AgentRunTransport>(args.transport, AgentRunTransportSchema, 'run transport');
    const id = args.id as string | undefined;
    const assignmentId = args.assignmentId as string | undefined;
    const claimId = args.claimId as string | undefined;
    const planId = args.planId as string | undefined;
    const sequenceId = args.sequenceId as string | undefined;
    const agent = args.agent as string | undefined;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    let runs = listAgentRuns(cwd, {
      ...(status ? { status } : {}),
      ...(transport ? { transport } : {}),
      ...(agent ? { agent } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(claimId ? { claim_id: claimId } : {}),
      ...(planId ? { plan_id: planId } : {}),
      ...(sequenceId ? { sequence_id: sequenceId } : {}),
    });
    if (id) {
      runs = runs.filter((run) =>
        run.id === id || run.short_label === id,
      );
    }

    const total = runs.length;
    const page = runs.slice(offset, offset + limit);
    const compact = args.compact === true;
    const lines = page.length === 0
      ? ['No runs found.']
      : [
          `${total} run(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((run) => {
            if (compact) {
              return `[${run.id}] ${run.agent} (${run.status}/${run.transport}) -> ${run.assignment_id}`;
            }
            const refs: string[] = [`assignment ${run.assignment_id}`, `attempt ${run.attempt_index}`];
            if (run.claim_id) refs.push(`claim ${run.claim_id}`);
            if (run.plan_id) refs.push(`plan ${run.plan_id}`);
            if (run.session_id) refs.push(`session ${run.session_id.slice(-8)}`);
            const suffix = refs.length ? ` [${refs.join(', ')}]` : '';
            return `[${run.id}] ${run.agent} (${run.status}/${run.transport}) -> ${run.scope}: ${run.description}${suffix}`;
          }),
        ];

    const outputRuns = compact
      ? page.map((run) => ({
          id: run.id,
          short_label: run.short_label,
          agent: run.agent,
          status: run.status,
          transport: run.transport,
          assignment_id: run.assignment_id,
          claim_id: run.claim_id,
          plan_id: run.plan_id,
          sequence_id: run.sequence_id,
          attempt_index: run.attempt_index,
          updated_at: run.updated_at,
          last_event_at: run.last_event_at,
        }))
      : page;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, runs: outputRuns },
    };
  }

  if (name === 'bclaw_assignment_events') {
    const id = args.id as string | undefined;
    const assignmentId = args.assignmentId as string | undefined;
    const runId = args.runId as string | undefined;
    const claimId = args.claimId as string | undefined;
    const sessionId = args.sessionId as string | undefined;
    const agent = args.agent as string | undefined;
    const eventType = args.eventType as RuntimeEventType | undefined;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const compact = args.compact === true;

    let events = queryRuntimeEvents({
      ...(id ? { id } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(claimId ? { claim_id: claimId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(agent ? { agent } : {}),
      ...(eventType ? { event_type: eventType } : {}),
    }, cwd);

    const total = events.length;
    const page = events.slice(offset, offset + limit);
    const lines = page.length === 0
      ? ['No runtime events found.']
      : [
          `${total} runtime event(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((event) => {
            if (compact) {
              return `[${event.id}] ${event.event_type} ${event.agent}${event.assignment_id ? ` assignment=${event.assignment_id}` : ''}${event.run_id ? ` run=${event.run_id}` : ''}`;
            }
            const refs: string[] = [];
            if (event.assignment_id) refs.push(`assignment ${event.assignment_id}`);
            if (event.run_id) refs.push(`run ${event.run_id}`);
            if (event.claim_id) refs.push(`claim ${event.claim_id}`);
            if (event.session_id) refs.push(`session ${event.session_id.slice(-8)}`);
            const suffix = refs.length ? ` [${refs.join(', ')}]` : '';
            return `[${event.id}] ${event.event_type} ${event.agent}: ${event.text}${suffix}`;
          }),
        ];

    const outputEvents = compact
      ? page.map((event) => ({
          id: event.id,
          created_at: event.created_at,
          event_type: event.event_type,
          agent: event.agent,
          assignment_id: event.assignment_id,
          run_id: event.run_id,
          claim_id: event.claim_id,
          session_id: event.session_id,
          status: event.status,
          status_reason: event.status_reason,
        }))
      : page;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, events: outputEvents },
    };
  }

  if (name === 'bclaw_list_actions') {
    const status = validateEnumFilter<ActionRequiredStatus>(args.status, ActionRequiredStatusSchema, 'action status');
    const kind = validateEnumFilter<ActionRequiredKind>(args.kind, ActionRequiredKindSchema, 'action kind');
    const id = args.id as string | undefined;
    const assignmentId = args.assignmentId as string | undefined;
    const runId = args.runId as string | undefined;
    const claimId = args.claimId as string | undefined;
    const agent = args.agent as string | undefined;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const compact = args.compact === true;

    let actions = listActionRequired(cwd, {
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(agent ? { agent } : {}),
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(claimId ? { claim_id: claimId } : {}),
    });
    if (id) {
      actions = actions.filter((action) => action.id === id || action.short_label === id);
    }

    const total = actions.length;
    const page = actions.slice(offset, offset + limit);
    const lines = page.length === 0
      ? ['No actions found.']
      : [
          `${total} action(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((action) => {
            if (compact) {
              return `[${action.id}] ${action.kind} (${action.status}) -> ${action.assignment_id}`;
            }
            const refs: string[] = [`assignment ${action.assignment_id}`];
            if (action.run_id) refs.push(`run ${action.run_id}`);
            if (action.claim_id) refs.push(`claim ${action.claim_id}`);
            if (action.session_id) refs.push(`session ${action.session_id.slice(-8)}`);
            const suffix = refs.length ? ` [${refs.join(', ')}]` : '';
            return `[${action.id}] ${action.kind} (${action.status}) ${action.title}: ${action.prompt}${suffix}`;
          }),
        ];

    const outputActions = compact
      ? page.map((action) => ({
          id: action.id,
          kind: action.kind,
          status: action.status,
          assignment_id: action.assignment_id,
          run_id: action.run_id,
          claim_id: action.claim_id,
          title: action.title,
          updated_at: action.updated_at,
          resolved_at: action.resolved_at,
        }))
      : page;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, actions: outputActions },
    };
  }

  if (name === 'bclaw_list_agents') {
    const agents = listAgentIdentities(cwd);
    const current = resolveCurrentAgentIdentity(cwd);
    const reputation = args.includeReputation ? buildReputationSnapshot(cwd) : undefined;
    const reputationById = new Map((reputation?.agents ?? []).map((agent) => [agent.agent_id ?? agent.key, toPublicReputationSummary(agent)]));
    const structuredAgents = args.includeReputation
      ? agents.map((agent) => ({
          ...agent,
          reputation: reputationById.get(agent.agent_id),
        }))
      : agents;

    const lines = structuredAgents.length === 0
      ? ['No registered agents.']
      : [
          `${structuredAgents.length} registered agent(s):`,
          ...structuredAgents.map((agent) => {
            const reputation = (agent as {
              reputation?: {
                internal_trust: number;
                contribution_quality: number;
                review_reliability: number;
                continuity_hygiene: number;
              };
            }).reputation;
            const currentLabel = current?.agent_id === agent.agent_id ? ' [current]' : '';
            const capabilitiesLabel = agent.capabilities.length > 0 ? ` caps=${agent.capabilities.join(',')}` : '';
            const fingerprintLabel = agent.identity_key ? ` fp=${agent.identity_key.fingerprint.slice(0, 12)}` : '';
            const reputationLabel = reputation
              ? ` trust=${reputation.internal_trust} cq=${reputation.contribution_quality} rv=${reputation.review_reliability} ct=${reputation.continuity_hygiene}`
              : '';
            return `- ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind})${currentLabel}${reputationLabel}${capabilitiesLabel}${fingerprintLabel}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        current_agent_id: current?.agent_id,
        current_agent: current?.agent_name,
        agents: structuredAgents,
      },
    };
  }

  if (name === 'bclaw_list_instructions') {
    const config = loadConfig(cwd);
    const project = args.project as string | undefined;
    const inferredProject = project ?? inferProjectFromTarget(args.path as string | undefined, config);
    const resolvedAgent = args.resolved ? resolveAgentScope(args.agent as string | undefined) : args.agent as string | undefined;
    const source = args.resolved
      ? resolveInstructions(loadInstructions(cwd), { project: inferredProject, agent: resolvedAgent })
      : loadInstructions(cwd);

    let entries = source;
    if (args.active) {
      entries = entries.filter((entry) => entry.active);
    }
    if (args.layer) {
      entries = entries.filter((entry) => entry.layer === args.layer);
    }
    if (inferredProject) {
      entries = entries.filter((entry) => entry.layer !== 'project' || entry.scope === inferredProject);
    }
    if (args.agent) {
      entries = entries.filter((entry) => entry.layer !== 'agent' || entry.scope === args.agent);
    }

    const total = entries.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = entries.slice(offset, offset + limit);

    const lines = page.length === 0
      ? ['No instructions found.']
      : [
          `${total} instruction(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((entry) => {
            const scope = entry.scope ? `:${entry.scope}` : '';
            const flags: string[] = [entry.layer];
            if (!entry.active) flags.push('inactive');
            if (entry.supersedes) flags.push(`supersedes ${entry.supersedes}`);
            const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
            return `[${entry.id}] <${entry.layer}${scope}> ${entry.text} (${flags.join(' · ')})${tags}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, instructions: page },
    };
  }

  if (name === 'bclaw_list_candidates') {
    const status = String(args.status ?? 'pending').toLowerCase();
    let candidates = status === 'accepted'
      ? listArchivedCandidates('accepted', cwd)
      : status === 'rejected'
        ? listArchivedCandidates('rejected', cwd)
        : status === 'all'
          ? [
              ...listCandidates('pending', cwd),
              ...listArchivedCandidates('accepted', cwd),
              ...listArchivedCandidates('rejected', cwd),
            ]
          : listCandidates('pending', cwd);

    // source / auto_generated filters — resolved source defaults missing field to 'human' (backward compat)
    if (args.source !== undefined) {
      const validSources: CandidateSource[] = ['auto', 'agent', 'human'];
      const sourceArg = String(args.source) as CandidateSource;
      if (validSources.includes(sourceArg)) {
        candidates = candidates.filter((c) => resolvedSource(c) === sourceArg);
      }
    }
    if (args.auto_generated === false) {
      candidates = candidates.filter((c) => resolvedSource(c) !== 'auto');
    } else if (args.auto_generated === true) {
      candidates = candidates.filter((c) => resolvedSource(c) === 'auto');
    }

    if (args.type) {
      candidates = candidates.filter((candidate) => candidate.type === args.type);
    }
    if (args.assignee) {
      const assignee = String(args.assignee).toLowerCase();
      candidates = candidates.filter((candidate) => getReviewAssignee(candidate.tags)?.toLowerCase() === assignee);
    }

    const total = candidates.length;
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Number(args.limit) || 20);
    const page = candidates.slice(offset, offset + limit);
    const isCompact = args.compact === true;

    const lines = page.length === 0
      ? ['No candidates found.']
      : [
          `${total} candidate(s)${total > limit ? ` (showing ${offset + 1}-${offset + page.length})` : ''}:`,
          ...page.map((candidate) => {
            if (isCompact) {
              return `[${candidate.id}] ${candidate.type}/${candidate.status}: ${candidate.text.slice(0, 120)}${candidate.text.length > 120 ? '…' : ''}`;
            }
            const assignee = getReviewAssignee(candidate.tags);
            const tags = candidate.tags.length ? ` [${candidate.tags.join(', ')}]` : '';
            const assigneeLabel = assignee ? ` assignee=${assignee}` : '';
            return `[${candidate.id}] ${candidate.type}/${candidate.status}${assigneeLabel}: ${candidate.text}${tags}`;
          }),
        ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total, offset, limit, candidates: page },
    };
  }

  if (name === 'bclaw_get_capabilities') {
    const allCapabilities = listCapabilities(cwd);

    const filtered = allCapabilities.filter((cap) => {
      const categoryFilter = args.category as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (categoryFilter && cap.category !== categoryFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => cap.tags.includes(tag))) return false;
      }
      return true;
    });

    const lines: string[] = [`Capabilities (${filtered.length}):`];
    filtered.forEach((cap) => {
      lines.push(`\n[${cap.id}] ${cap.name}`);
      lines.push(`    Category: ${cap.category}`);
      lines.push(`    Author: ${cap.author}`);
      if (cap.tags.length > 0) {
        lines.push(`    Tags: ${cap.tags.join(', ')}`);
      }
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No capabilities found.' }],
      structuredContent: { total: filtered.length, capabilities: filtered },
    };
  }

  if (name === 'bclaw_list_tools') {
    const allTools = listRegistryTools(cwd);

    const filtered = allTools.filter((tool) => {
      const typeFilter = args.type as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (typeFilter && tool.type !== typeFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => tool.tags.includes(tag))) return false;
      }
      return true;
    });

    const lines: string[] = [`Tools (${filtered.length}):`];
    filtered.forEach((tool) => {
      lines.push(`\n[${tool.id}] ${tool.name}`);
      lines.push(`    Type: ${tool.type}`);
      lines.push(`    Author: ${tool.author}`);
      if (tool.tags.length > 0) {
        lines.push(`    Tags: ${tool.tags.join(', ')}`);
      }
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No tools found.' }],
      structuredContent: { total: filtered.length, tools: filtered },
    };
  }

  if (name === 'bclaw_search_tools') {
    const query = String(args.query ?? '');
    if (!query) {
      throw new Error('Missing required argument: query');
    }

    const allTools = listRegistryTools(cwd);
    const queryLower = query.toLowerCase();

    const filtered = allTools.filter((tool) => {
      const typeFilter = args.type as string | undefined;
      const tagsFilter = args.tags as string[] | undefined;

      if (typeFilter && tool.type !== typeFilter) return false;
      if (tagsFilter && tagsFilter.length > 0) {
        if (!tagsFilter.every((tag) => tool.tags.includes(tag))) return false;
      }

      return (
        tool.name.toLowerCase().includes(queryLower) ||
        tool.description.toLowerCase().includes(queryLower) ||
        tool.tags.some((tag) => tag.toLowerCase().includes(queryLower))
      );
    });

    const lines: string[] = [`Search results for '${query}' (${filtered.length} tool(s)):`];
    filtered.forEach((tool) => {
      lines.push(`\n[${tool.id}] ${tool.name}`);
      lines.push(`    Type: ${tool.type}`);
    });

    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No tools found.' }],
      structuredContent: { query, total: filtered.length, tools: filtered },
    };
  }

  if (name === 'bclaw_get_discovery') {
    const refresh = args.refresh !== false; // default: true
    const noSave = args.noSave as boolean | undefined;

    let profile;
    if (!refresh) {
      profile = loadDiscoveryProfile(cwd);
    }
    if (!profile) {
      profile = buildProjectDiscovery({ cwd });
      if (!noSave) {
        saveDiscoveryProfile(profile, cwd);
      }
    }

    return {
      content: [{ type: 'text', text: renderDiscoverySummary(profile) }],
      structuredContent: { ...profile, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_conflict_check') {
    const agentNameArg = args.agent as string | undefined;
    const agentIdArg = args.agentId as string | undefined;
    const currentAgentName = agentNameArg ?? resolveCurrentAgentName(cwd);
    const allClaimsForCheck = listClaims(cwd).filter((c) => c.status === 'active');
    const myClaimsForCheck = allClaimsForCheck.filter((c) =>
      agentIdArg ? c.agent_id === agentIdArg : c.agent === currentAgentName
    );
    const otherClaimsForCheck = allClaimsForCheck.filter((c) =>
      agentIdArg ? c.agent_id !== agentIdArg : c.agent !== currentAgentName
    );

    const conflicts: Array<{ my_claim: string; my_scope: string; other_claim: string; other_agent: string; other_scope: string; reason: string }> = [];
    for (const mine of myClaimsForCheck) {
      const myScopes = mine.scope.replace(/\\/g, '/').split(/\s+/);
      for (const other of otherClaimsForCheck) {
        const otherScopes = other.scope.replace(/\\/g, '/').split(/\s+/);
        for (const ms of myScopes) {
          for (const os of otherScopes) {
            if (ms === os || ms.startsWith(os + '/') || os.startsWith(ms + '/')) {
              conflicts.push({
                my_claim: mine.id, my_scope: mine.scope,
                other_claim: other.id, other_agent: other.agent, other_scope: other.scope,
                reason: ms === os ? `exact: ${ms}` : `overlap: ${ms} ↔ ${os}`,
              });
            }
          }
        }
      }
    }

    const text = conflicts.length === 0
      ? `No claim conflicts for ${currentAgentName}.`
      : `${conflicts.length} conflict(s) found:\n${conflicts.map((c) => `  ${c.my_scope} ↔ ${c.other_agent}:${c.other_scope} (${c.reason})`).join('\n')}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { agent: currentAgentName, conflicts, total: conflicts.length, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_switch') {
    if (args.list === true) {
      try {
        const result = listAvailableProjects(cwd);
        const lines = result.projects.map(p => {
          const marker = p.active ? '→' : ' ';
          const label = p.name ? `${p.name} (${p.relative_path})` : p.relative_path;
          return `${marker} ${label}`;
        });
        return {
          content: [{ type: 'text', text: lines.length > 0 ? `Projects in workspace:\n${lines.join('\n')}` : 'No projects found.' }],
          structuredContent: { ...result, schema_version: SCHEMA_VERSION },
        };
      } catch (err) {
        return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
      }
    }

    if (args.clear === true) {
      try {
        const session = loadCurrentSession(cwd);
        if (session?.active_project) {
          const { active_project: _removed, ...rest } = session;
          saveCurrentSession(rest, cwd);
        }
        return {
          content: [{ type: 'text', text: '✔ Active project cleared. Commands will use workspace root.' }],
          structuredContent: { cleared: true, schema_version: SCHEMA_VERSION },
        };
      } catch (err) {
        return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
      }
    }

    const projectRef = args.project as string | undefined;
    if (!projectRef) {
      return createToolErrorResponse('validation_error', 'Missing required argument: project (or use list=true / clear=true)');
    }

    try {
      const result = switchProject(projectRef, { cwd, sessionOnly: true });
      const text = `✔ Switched to ${result.name ? `"${result.name}"` : result.path} (${result.scope}-scoped)`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...result, schema_version: SCHEMA_VERSION },
      };
    } catch (err) {
      return createToolErrorResponse('switch_error', err instanceof Error ? err.message : String(err));
    }
  }

  if (name === 'bclaw_who') {
    // loadAllSessions and gcStaleSessions imported at top of file
    const doGc = args.gc === true;
    const showAll = args.all === true;

    if (doGc) {
      const removed = gcStaleSessions(cwd);
      return {
        content: [{ type: 'text', text: `✔ Removed ${removed} stale session(s).` }],
        structuredContent: { gc: true, removed, schema_version: SCHEMA_VERSION },
      };
    }

    const allSessions = loadAllSessions(cwd);
    const ttlMs = 4 * 60 * 60 * 1000;
    const now = Date.now();
    const sessions = showAll
      ? allSessions
      : allSessions.filter((s) => (now - Date.parse(s.last_seen_at)) <= ttlMs);

    const activeClaims = listClaims(cwd).filter((c) => c.status === 'active');
    const output = sessions.map((s) => ({
      session_id: s.session_id,
      user: s.user ?? 'unknown',
      agent: s.agent,
      agent_id: s.agent_id,
      project: s.active_project?.name ?? s.active_project?.path ?? null,
      claims: activeClaims.filter((c) => c.agent_id === s.agent_id).length,
      last_seen_at: s.last_seen_at,
      stale: (now - Date.parse(s.last_seen_at)) > ttlMs,
    }));

    const lines = sessions.length === 0
      ? 'No active sessions.'
      : output.map((s) => `${s.user} | ${s.agent} | ${s.project ?? '(root)'} | ${s.claims} claims | ${s.stale ? 'stale' : 'active'}`).join('\n');

    return {
      content: [{ type: 'text', text: lines }],
      structuredContent: { sessions: output, total: output.length, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_check_policy') {
    const scope = String(args.scope ?? '').trim();
    if (!scope) {
      return { content: [{ type: 'text', text: 'Error: missing required argument: scope' }] };
    }
    const result = checkPolicy({
      scope,
      agent: (args.agent as string | undefined) ?? resolveCurrentAgentName(cwd),
      agentId: args.agentId as string | undefined,
      action: args.action as string | undefined,
      cwd,
    });

    const parts: string[] = [];
    const status = result.allowed ? '✔ ALLOWED' : '✘ BLOCKED';
    parts.push(`Policy check for "${scope}": ${status}`);

    if (result.blocks.length > 0) {
      parts.push('');
      parts.push('Blocks:');
      for (const b of result.blocks) {
        parts.push(`  ✘ [${b.kind}] ${b.message}`);
      }
    }
    if (result.warnings.length > 0) {
      parts.push('');
      parts.push('Warnings:');
      for (const w of result.warnings) {
        const idLabel = w.id ? ` (${w.id})` : '';
        parts.push(`  ⚠ [${w.kind}]${idLabel} ${w.message}`);
      }
    }
    if (result.governance_context.active_instructions.length > 0) {
      parts.push('');
      parts.push(`Governance: ${result.governance_context.active_instructions.length} active instruction(s)`);
      for (const ins of result.governance_context.active_instructions) {
        const layerLabel = ins.layer === 'global' ? '[global]' : `[${ins.layer}:${ins.scope ?? '*'}]`;
        parts.push(`  ${layerLabel} ${ins.text.slice(0, 150)}${ins.text.length > 150 ? '…' : ''}`);
      }
    }

    return {
      content: [{ type: 'text', text: parts.join('\n') }],
      structuredContent: {
        allowed: result.allowed,
        blocks: result.blocks,
        warnings: result.warnings,
        governance_context: {
          active_instructions_count: result.governance_context.active_instructions.length,
          matching_constraints_count: result.governance_context.matching_constraints.length,
          matching_traps_count: result.governance_context.matching_traps.length,
          active_claims_on_scope: result.governance_context.active_claims_on_scope.map(c => ({
            id: c.id, agent: c.agent, scope: c.scope, description: c.description,
          })),
        },
        schema_version: SCHEMA_VERSION,
      },
    };
  }

  if (name === 'bclaw_doctor') {
    // Capture doctor JSON output by redirecting console.log
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a: unknown[]) => captured.push(a.join(' '));
    console.warn = (...a: unknown[]) => captured.push(a.join(' '));
    console.error = (...a: unknown[]) => captured.push(a.join(' '));
    try {
      runDoctor({ json: true, cwd, migrationCheck: args.migrationCheck as boolean | undefined });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    const jsonStr = captured.join('\n');
    let structured: Record<string, unknown> = {};
    try { structured = JSON.parse(jsonStr) as Record<string, unknown>; } catch { /* non-JSON fallback */ }
    const ok = structured.ok as boolean | undefined;
    const checks = (structured.checks as Array<{ name: string; status: string; message: string }>) ?? [];
    const errors = checks.filter(c => c.status === 'error');
    const warns = checks.filter(c => c.status === 'warn');
    const summary = ok
      ? `✔ All ${checks.length} checks passed.`
      : `${errors.length} error(s), ${warns.length} warning(s) out of ${checks.length} checks.`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { ...structured, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_history') {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('Missing required argument: id');
    const entries = readAuditLog({ itemId: id }, cwd);
    const lines = [`History for ${id} — ${entries.length} event(s):`];
    for (const e of entries) {
      const reason = e.reason ? ` | ${e.reason}` : '';
      lines.push(`  ${e.timestamp} [${e.actor}] ${e.action}${reason}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { id, total: entries.length, entries, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_audit') {
    // Governance mode
    if (args.governance === true) {
      const report = buildGovernanceReport({
        scope: args.scope as string | undefined,
        agent: args.actor as string | undefined,
        since: args.since as string | undefined,
        cwd,
      });
      const markdown = renderGovernanceMarkdown(report);
      return {
        content: [{ type: 'text', text: markdown }],
        structuredContent: { ...report, schema_version: SCHEMA_VERSION },
      };
    }

    // Chronological mode (default)
    const limit = (args.limit as number | undefined) ?? 20;
    const entries = readAuditLog({
      since: args.since as string | undefined,
      actor: args.actor as string | undefined,
      action: args.action as AuditAction | undefined,
    }, cwd);
    const sliced = entries.slice(-limit);
    const lines = [`Audit log — showing ${sliced.length} of ${entries.length} entries:`];
    for (const e of sliced) {
      const itemInfo = e.item_id ? ` → ${e.item_id}` : '';
      const typeInfo = e.item_type ? ` (${e.item_type})` : '';
      const scopeInfo = e.scope ? ` scope:${e.scope}` : '';
      const reason = e.reason ? ` | ${e.reason}` : '';
      lines.push(`  ${e.timestamp} [${e.actor}] ${e.action}${itemInfo}${typeInfo}${scopeInfo}${reason}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { total: entries.length, returned: sliced.length, entries: sliced, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_dispatch_analysis') {
    const analysis = analyzeSequence(cwd);
    if (!analysis) {
      return {
        content: [{ type: 'text', text: 'No active sequence found.' }],
        structuredContent: { active_sequence: false, schema_version: SCHEMA_VERSION },
      };
    }

    const lanesFilter = args.lanes as string[] | undefined;
    const lines: string[] = [`Dispatch analysis — Sequence: ${analysis.sequence.name}`];
    lines.push('');

    // Ready lanes
    let ready = analysis.ready;
    if (lanesFilter?.length) ready = ready.filter(r => r.lane && lanesFilter.includes(r.lane));
    lines.push(`🟢 Ready (${ready.length}):`);
    for (const r of ready) {
      const lane = r.lane ? ` [${r.lane}]` : '';
      const assignee = r.plan.assignee ? ` → ${r.plan.assignee}` : '';
      lines.push(`  ${r.plan.short_label ?? r.plan.id}${lane}${assignee} — ${r.plan.text.slice(0, 80)}`);
      lines.push(`    ${r.reason}`);
    }

    // Active lanes
    let active = analysis.active;
    if (lanesFilter?.length) active = active.filter(a => a.lane && lanesFilter.includes(a.lane));
    if (active.length > 0) {
      lines.push('');
      lines.push(`🔵 Active (${active.length}):`);
      for (const a of active) {
        const lane = a.lane ? ` [${a.lane}]` : '';
        lines.push(`  ${a.plan.short_label ?? a.plan.id}${lane} — ${a.agent} working`);
      }
    }

    // Blocked lanes
    let blocked = analysis.blocked;
    if (lanesFilter?.length) blocked = blocked.filter(b => b.lane && lanesFilter.includes(b.lane));
    if (blocked.length > 0) {
      lines.push('');
      lines.push(`🔴 Blocked (${blocked.length}):`);
      for (const b of blocked) {
        const lane = b.lane ? ` [${b.lane}]` : '';
        lines.push(`  ${b.item.planId}${lane} — ${b.reason}`);
      }
    }

    // Done
    if (analysis.done.length > 0) {
      lines.push('');
      lines.push(`✅ Done (${analysis.done.length})`);
    }

    // Available agents
    lines.push('');
    lines.push(`Available agents: ${analysis.available_agents.length > 0 ? analysis.available_agents.join(', ') : '(none)'}`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ...analysis, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_read_inbox') {
    const agentName = (args.agent as string | undefined) ?? resolveCurrentAgentName(cwd);
    const markAsRead = args.markAsRead === true; // default: false — reading doesn't imply processing
    const result = readInbox({
      agent: agentName,
      status: args.status as import('../core/schema.js').MessageStatus | undefined,
      type: args.type as import('../core/schema.js').MessageType | undefined,
      thread_id: args.thread_id as string | undefined,
      limit: args.limit as number | undefined,
      offset: args.offset as number | undefined,
      markAsRead,
    }, cwd);

    const lines: string[] = [`Inbox for ${agentName} — ${result.total} message(s):`];
    for (const msg of result.messages) {
      const ack = msg.requires_ack ? ' [ACK required]' : '';
      const thread = msg.thread_id ? ` thread:${msg.thread_id}` : '';
      lines.push(`  [${msg.short_label ?? msg.id}] ${msg.type} from ${msg.from} (${msg.status})${ack}${thread}`);
      lines.push(`    ${msg.text.slice(0, 200)}${msg.text.length > 200 ? '...' : ''}`);
    }
    if (result.messages.length === 0) {
      lines.push('  (no messages)');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ...result, schema_version: SCHEMA_VERSION },
    };
  }

  if (name === 'bclaw_context') {
    // Phase 3 slice 3c — unified dispatcher. See docs/concepts/mcp-governance.md
    // for the stability contract of the advanced tier.
    const kind = String(args.kind ?? '');
    switch (kind) {
      case 'memory':
        return handleMcpReadToolCall('bclaw_get_context', args, context);
      case 'execution':
        return handleMcpReadToolCall('bclaw_get_execution_context', args, context);
      case 'board':
        return handleMcpReadToolCall('bclaw_get_agent_board', args, context);
      case 'board_summary':
        return handleMcpReadToolCall('bclaw_get_agent_board_summary', args, context);
      case 'delta': {
        const since = args.since;
        if (typeof since !== 'string' || !since) {
          throw new Error('bclaw_context(kind="delta") requires `since` (session_id).');
        }
        return handleMcpReadToolCall(
          'bclaw_get_context',
          { ...args, since_session: since },
          context,
        );
      }
      default:
        throw new Error(`bclaw_context: unknown kind '${kind}'. Expected memory | execution | board | board_summary | delta.`);
    }
  }

  if (name === 'bclaw_get_thread') {
    const threadId = String(args.thread_id ?? '');
    if (!threadId) {
      throw new Error('Missing required argument: thread_id');
    }
    const messages = getThread(threadId, cwd);
    const lines: string[] = [`Thread ${threadId} — ${messages.length} message(s):`];
    for (const msg of messages) {
      lines.push(`  [${msg.short_label ?? msg.id}] ${msg.from} → ${msg.to} (${msg.type}, ${msg.status})`);
      lines.push(`    ${msg.text.slice(0, 200)}${msg.text.length > 200 ? '...' : ''}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { thread_id: threadId, total: messages.length, messages, schema_version: SCHEMA_VERSION },
    };
  }

  throw new Error(`Unknown read tool: ${name}`);
}
