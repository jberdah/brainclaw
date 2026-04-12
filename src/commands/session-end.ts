import { execSync } from 'node:child_process';
import path from 'node:path';
import { memoryExists } from '../core/io.js';
import { buildOperationalIdentity, clearCurrentSession } from '../core/identity.js';
import { buildContextDiff } from '../core/context-diff.js';
import { listClaims, releaseClaim } from '../core/claims.js';
import { listRuntimeNotes, saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { loadState, persistState } from '../core/state.js';
import { listArchivedCandidates, listCandidates } from '../core/candidates.js';
import { createFederationMessage } from '../core/federation-message.js';
import { pushSignal } from '../core/federation-transport.js';
import { loadConfig } from '../core/config.js';
import { resolveCrossProjectLinks, type ResolvedCrossProjectLink } from '../core/cross-project.js';
import { createCandidateFromInput } from './reflect.js';
import { suggestCandidateTypes } from './reflect-runtime-note.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { appendAuditEntry, readAuditLog, type AuditAction, type AuditEntry } from '../core/audit.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { loadSessionSnapshot } from '../commands/session-start.js';
import { extractFilesFromDiff } from '../commands/handoff.js';
import { suggestCompaction } from '../core/memory-compactor.js';
import { dispatchReview } from '../core/dispatcher.js';

export interface SessionEndOptions {
  session?: string;
  summary?: string;
  /** Free-text narrative of what happened in the session and why, beyond auto-generated commits. */
  narrative?: string;
  agent?: string;
  agentId?: string;
  autoReflect?: boolean;
  autoRelease?: boolean;
  reflectHandoff?: boolean;
  dispatchReview?: boolean;
  reviewer?: string;
  /** Include structured reflection questions in the result for the agent to answer. */
  reflect?: boolean;
  json?: boolean;
  cwd?: string;
}

export const REFLECTION_QUESTIONS = [
  'What was the biggest time waste in this session, and how could it have been avoided?',
  'What should have been done differently (design, process, or approach)?',
  'What should brainclaw itself improve based on this session?',
] as const;

export interface SessionEndResult {
  session_id: string;
  agent: string;
  notes_in_session: number;
  candidates_created: number;
  context_diff?: string;
  summary: string;
  open_work_warning?: OpenWorkWarning;
  session_stats?: SessionStatsSummary;
  /** When reflect=true, these questions should be answered by the agent via bclaw_write_note with tag [reflection]. */
  reflection_prompt?: {
    questions: string[];
    instruction: string;
  };
  /** Hint about memory compaction opportunities. */
  compaction_hint?: string;
  handoff?: {
    handoff_id: string;
    plan_id?: string;
    review_dispatched: boolean;
    reviewer?: string;
    review_message_id?: string;
    review_skip_reason?: string;
  };
}

export interface OpenWorkWarning {
  active_claims: { id: string; scope: string; description: string }[];
  in_progress_plans: { id: string; text: string }[];
  auto_released: boolean;
}

export interface SessionStatsSummary {
  session_duration_minutes: number;
  file_edits_count: number;
  claims_created: number;
  memory_writes: number;
  plan_updates: number;
  candidates_created: number;
  last_brainclaw_write?: string;
  warnings: string[];
}

interface MaterializedSessionHandoff {
  handoff_id: string;
  plan_id?: string;
}

export function runSessionEnd(options: SessionEndOptions = {}): void {
  try {
    const result = endSession(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.open_work_warning) {
      const w = result.open_work_warning;
      console.log('⚠ Open work detected at session end:');
      for (const c of w.active_claims) {
        console.log(`  claim [${c.id}] ${c.description}`);
        console.log(`    scope: ${c.scope}`);
      }
      for (const p of w.in_progress_plans) {
        console.log(`  plan  [${p.id}] ${p.text}`);
      }
      if (w.auto_released) {
        console.log('  → Claims auto-released and plans left for manual update.');
      } else {
        console.log('  → Run `brainclaw claim release <id>` and `brainclaw plan update <id> --status done` to clean up.');
      }
    }

    console.log(`✔ Session ended: ${result.session_id} (${result.agent})`);
    console.log(`  Runtime notes in session: ${result.notes_in_session}`);
    if (options.autoReflect) {
      console.log(`  Candidates created from auto-reflect: ${result.candidates_created}`);
    }
    if (result.handoff) {
      console.log(`  Reflected handoff: ${result.handoff.handoff_id}${result.handoff.plan_id ? ` (${result.handoff.plan_id})` : ''}`);
      if (result.handoff.review_dispatched) {
        console.log(`  Review dispatched: ${result.handoff.reviewer}${result.handoff.review_message_id ? ` [${result.handoff.review_message_id}]` : ''}`);
      } else if (result.handoff.review_skip_reason) {
        console.log(`  Review not dispatched: ${result.handoff.review_skip_reason}`);
      }
    }
    if (result.context_diff) {
      console.log(`  ${result.context_diff}`);
    }
    if (result.session_stats) {
      console.log('  Session stats:');
      console.log(`    duration: ${result.session_stats.session_duration_minutes} min`);
      console.log(`    file edits: ${result.session_stats.file_edits_count}`);
      console.log(`    claims created: ${result.session_stats.claims_created}`);
      console.log(`    memory writes: ${result.session_stats.memory_writes}`);
      console.log(`    plan updates: ${result.session_stats.plan_updates}`);
      console.log(`    candidates created: ${result.session_stats.candidates_created}`);
      if (result.session_stats.last_brainclaw_write) {
        console.log(`    last brainclaw write: ${result.session_stats.last_brainclaw_write}`);
      }
      for (const warning of result.session_stats.warnings) {
        console.log(`    warning: ${warning}`);
      }
    }
    if (result.compaction_hint) {
      console.log(`  💡 ${result.compaction_hint}`);
    }
    if (result.reflection_prompt) {
      console.log('\n📝 Session reflection:');
      for (let i = 0; i < result.reflection_prompt.questions.length; i++) {
        console.log(`  ${i + 1}. ${result.reflection_prompt.questions[i]}`);
      }
      console.log(`\n  → Answer with: brainclaw note "your reflection" --tag reflection --tag session:${result.session_id}`);
    }
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function endSession(options: SessionEndOptions = {}): SessionEndResult {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const registered = requireRegisteredAgentIdentity({
    agentName: options.agent,
    agentId: options.agentId,
    cwd: options.cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(registered, 'contributor');
  const actor = buildOperationalIdentity(registered.agent_name, options.cwd, { agentId: registered.agent_id });

  const sessionId = options.session ?? actor.session_id;
  if (!sessionId) {
    throw new Error('no session ID provided. Use --session <id> or set BRAINCLAW_SESSION_ID.');
  }

  // Hygiene check: find open work belonging to this agent
  const allClaims = listClaims(options.cwd);
  const activeClaims = allClaims.filter(
    (c) => c.status === 'active' && (registered.agent_id ? c.agent_id === registered.agent_id : c.agent === registered.agent_name)
  );
  const state = loadState(options.cwd);
  const claimPlanIds = new Set(activeClaims.map((c) => c.plan_id).filter(Boolean) as string[]);
  const inProgressPlans = state.plan_items.filter(
    (p) => p.status === 'in_progress' && (p.assignee === registered.agent_name || claimPlanIds.has(p.id))
  );

  let openWorkWarning: OpenWorkWarning | undefined;
  if (activeClaims.length > 0 || inProgressPlans.length > 0) {
    if (options.autoRelease) {
      for (const c of activeClaims) {
        releaseClaim(c.id, options.cwd);
      }
    }
    openWorkWarning = {
      active_claims: activeClaims.map(({ id, scope, description }) => ({ id, scope, description })),
      in_progress_plans: inProgressPlans.map(({ id, text }) => ({ id, text })),
      auto_released: options.autoRelease ?? false,
    };
  }

  // Get session notes for summary
  const agentNotes = listRuntimeNotes(actor.agent, options.cwd);
  const sessionNotes = agentNotes.filter(n => n.session_id === sessionId);

  const diff = buildContextDiff({
    session: sessionId,
    cwd: options.cwd,
    includeItems: true,
  });
  const contextDiff = diff?.summary;

  const summaryText = options.summary
    ? options.summary
    : `Session ended — ${sessionNotes.length} runtime note(s) created`;

  // Write session_end runtime note
  const noteId = generateRuntimeNoteId();
  saveRuntimeNote({
    id: noteId,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: sessionId,
    text: summaryText + (contextDiff ? `\n${contextDiff}` : ''),
    created_at: nowISO(),
    tags: ['session'],
    visibility: 'shared',
    note_type: 'session_end',
  }, options.cwd);

  // Reflect-handoff: materialize an open handoff from git commits since session start
  let reflectedHandoff: SessionEndResult['handoff'];
  if (options.reflectHandoff) {
    try {
      const snapshot = loadSessionSnapshot(sessionId, options.cwd);
      const startSha = snapshot?.git_sha;
      const ref = startSha ?? 'HEAD~10';
      const cwd = options.cwd ?? process.cwd();

      const commits = execSync(`git log --oneline ${ref}..HEAD`, { encoding: 'utf-8', cwd }).trim();
      const diffStat = execSync(`git diff --stat ${ref}..HEAD`, { encoding: 'utf-8', cwd }).trim();

      if (commits) {
        const releasedClaims = listClaims(options.cwd)
          .filter((c) => c.status === 'released' && c.agent === registered.agent_name);
        const releasedScopes = releasedClaims.map((c) => c.scope).join(', ');

        // Extract files touched from the full diff for the contract
        let filesTouched: string[] = [];
        let fullDiff: string | undefined;
        try {
          fullDiff = execSync(`git diff ${ref}..HEAD`, { encoding: 'utf-8', cwd, maxBuffer: 10 * 1024 * 1024 }).trim();
          filesTouched = extractFilesFromDiff(fullDiff);
        } catch { /* fall back to empty */ }

        // Extract linked plan IDs from released claims
        const linkedPlans = [...new Set(releasedClaims.map((c) => c.plan_id).filter(Boolean) as string[])];
        const primaryPlanId = linkedPlans.length === 1 ? linkedPlans[0] : undefined;

        // Build contract metadata for the handoff text
        const contractLines: string[] = [];
        if (filesTouched.length > 0) contractLines.push(`Files touched: ${filesTouched.join(', ')}`);
        if (linkedPlans.length > 0) contractLines.push(`Linked plans: ${linkedPlans.join(', ')}`);

        const handoffText = [
          `Session ${sessionId} — auto-generated handoff`,
          options.narrative ? `\nNarrative: ${options.narrative}` : '',
          '',
          `Commits:\n${commits}`,
          diffStat ? `\nChanged files:\n${diffStat}` : '',
          releasedScopes ? `\nReleased claims: ${releasedScopes}` : '',
          contractLines.length > 0 ? `\nContract:\n${contractLines.join('\n')}` : '',
          summaryText !== `Session ended — ${sessionNotes.length} runtime note(s) created` ? `\nSummary: ${summaryText}` : '',
        ].filter(Boolean).join('\n');

        const narrativeParts = [
          options.narrative?.trim(),
          summaryText !== `Session ended — ${sessionNotes.length} runtime note(s) created` ? summaryText : undefined,
        ].filter((value): value is string => Boolean(value && value.trim().length > 0));
        const materialized = materializeSessionHandoff({
          author: actor.agent,
          authorId: actor.agent_id,
          sessionId,
          text: handoffText,
          narrative: narrativeParts.length > 0 ? narrativeParts.join('\n\n') : undefined,
          planId: primaryPlanId,
          linkedPlans,
          filesTouched,
          fullDiff,
          cwd: options.cwd,
        });
        reflectedHandoff = {
          handoff_id: materialized.handoff_id,
          plan_id: materialized.plan_id,
          review_dispatched: false,
          review_skip_reason: options.dispatchReview ? 'Reflected handoff is not reviewable yet' : undefined,
        };
        if (options.dispatchReview) {
          const reviewResult = dispatchReview({
            handoffId: materialized.handoff_id,
            reviewer: options.reviewer,
            dispatcherAgent: actor.agent,
            dispatcherAgentId: actor.agent_id,
            sessionId,
          }, options.cwd ?? process.cwd());
          const sent = reviewResult.reviews_sent.find((entry) => entry.handoff_id === materialized.handoff_id);
          const skipped = reviewResult.skipped.find((entry) => entry.handoff_id === materialized.handoff_id);
          if (sent) {
            reflectedHandoff.review_dispatched = true;
            reflectedHandoff.reviewer = sent.reviewer;
            reflectedHandoff.review_message_id = sent.message_id;
            reflectedHandoff.review_skip_reason = undefined;
            updateReflectedHandoffRecipient(materialized.handoff_id, sent.reviewer, options.cwd);
          } else if (skipped) {
            reflectedHandoff.review_skip_reason = skipped.reason;
          }
        }
      }
    } catch { /* non-fatal — no git or no commits */ }
  }

  // Auto-reflect: generate candidates from session notes
  let candidatesCreated = 0;
  if (options.autoReflect && sessionNotes.length > 0) {
    for (const note of sessionNotes) {
      if (note.note_type === 'observation' || !note.note_type) {
        try {
          const detected = suggestCandidateTypes(note.text, note.tags).find((entry) => entry.type !== 'handoff');
          if (!detected || detected.score < 4) {
            continue;
          }
          const creation = createCandidateFromInput(note.text, detected.type, {
            tag: note.tags,
            author: note.agent,
            authorId: note.agent_id,
            projectId: note.project_id,
            sessionId: note.session_id,
            source: `runtime-note:${note.agent}:${note.id}`,
            cwd: options.cwd,
          }, false, false, true);
          if (creation.candidateId) {
            candidatesCreated++;
          }
        } catch { /* skip */ }
      }
    }
  }

  const sessionStats = buildSessionStats({
    sessionId,
    sessionStartedAt: loadSessionSnapshot(sessionId, options.cwd)?.started_at,
    agent: actor.agent,
    agentId: actor.agent_id,
    notesInSession: sessionNotes,
    cwd: options.cwd,
  });

  // Memory compaction hint (best-effort, non-fatal)
  let compactionHint: string | undefined;
  try {
    compactionHint = suggestCompaction(state);
  } catch { /* non-fatal */ }

  let pushedSignals = 0;
  try {
    pushedSignals = pushSessionFederationSignals({
      sessionId,
      actor,
      sessionNotes,
      cwd: options.cwd,
    });
  } catch {
    // Non-fatal
  }
  if (pushedSignals > 0 && !options.json) {
    console.log(`✔ Pushed ${pushedSignals} signal(s) to linked projects`);
  }

  appendAuditEntry({
    action: 'session_end',
    actor: actor.agent,
    actor_id: actor.agent_id,
    item_id: sessionId,
    item_type: 'session',
    session_id: sessionId,
    host_id: actor.host_id,
    after: sessionStats,
  }, options.cwd);
  clearCurrentSession(options.cwd, sessionId);

  const result: SessionEndResult = {
    session_id: sessionId,
    agent: actor.agent,
    notes_in_session: sessionNotes.length,
    candidates_created: candidatesCreated,
    context_diff: contextDiff,
    summary: summaryText,
    open_work_warning: openWorkWarning,
    session_stats: sessionStats,
    compaction_hint: compactionHint,
    ...(reflectedHandoff ? { handoff: reflectedHandoff } : {}),
  };

  if (options.reflect) {
    result.reflection_prompt = {
      questions: [...REFLECTION_QUESTIONS],
      instruction: `Please reflect on this session and answer each question. Write your answers using bclaw_write_note with tags ["reflection", "session:${sessionId}"]. One note per question, or a single combined note.`,
    };
  }

  return result;
}

function materializeSessionHandoff(input: {
  author: string;
  authorId?: string;
  sessionId: string;
  text: string;
  narrative?: string;
  planId?: string;
  linkedPlans: string[];
  filesTouched: string[];
  fullDiff?: string;
  cwd?: string;
}): MaterializedSessionHandoff {
  const cwd = input.cwd ?? process.cwd();
  const state = loadState(cwd);
  const { id, short_label } = generateIdWithLabel('open_handoffs', cwd);
  state.open_handoffs.push({
    id,
    short_label,
    from: input.author,
    to: 'reviewer',
    text: input.text,
    created_at: nowISO(),
    author: input.author,
    author_id: input.authorId,
    session_id: input.sessionId,
    status: 'open',
    plan_id: input.planId,
    narrative: input.narrative,
    tags: ['auto-handoff', `session:${input.sessionId}`],
    related_paths: input.filesTouched.length > 0 ? input.filesTouched : undefined,
    contract: input.filesTouched.length > 0 || input.linkedPlans.length > 0
      ? {
          files_touched: input.filesTouched.length > 0 ? input.filesTouched : undefined,
          linked_plans: input.linkedPlans.length > 0 ? input.linkedPlans : undefined,
        }
      : undefined,
    snapshot: input.fullDiff ? { diff: input.fullDiff } : undefined,
  });
  persistState(state, cwd);
  return { handoff_id: id, plan_id: input.planId };
}

function updateReflectedHandoffRecipient(handoffId: string, reviewer: string, cwd?: string): void {
  const effectiveCwd = cwd ?? process.cwd();
  const state = loadState(effectiveCwd);
  const handoff = state.open_handoffs.find((entry) => entry.id === handoffId);
  if (!handoff) return;
  handoff.to = reviewer;
  persistState(state, effectiveCwd);
}

type FederationSignalEntityType = 'candidate' | 'handoff' | 'runtime_note';

function pushSessionFederationSignals(input: {
  sessionId: string;
  actor: ReturnType<typeof buildOperationalIdentity>;
  sessionNotes: ReturnType<typeof listRuntimeNotes>;
  cwd?: string;
}): number {
  const cwd = input.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const links = resolveCrossProjectLinks(cwd);
  const publisherLinks = links.filter((link) => link.role === 'publisher' && link.available);

  if (!config.cross_project_links?.length || publisherLinks.length === 0) {
    return 0;
  }

  const currentState = loadState(cwd);
  const sessionHandoffs = currentState.open_handoffs.filter((handoff) => handoff.session_id === input.sessionId);
  const sessionCandidates = [
    ...listCandidates(undefined, cwd),
    ...listArchivedCandidates('accepted', cwd),
    ...listArchivedCandidates('rejected', cwd),
  ].filter((candidate) => candidate.session_id === input.sessionId);
  const sessionRuntimeNotes = input.sessionNotes.filter((note) => note.session_id === input.sessionId);

  const fromProjectName = config.project_name ?? path.basename(cwd);
  const seen = new Set<string>();
  let pushed = 0;

  const pushEntitySignal = (entityType: FederationSignalEntityType, entity: Record<string, unknown> & { id: string }): void => {
    const target = extractCrossProjectTarget(entity);
    if (!target) return;
    const link = resolvePublisherLink(target, publisherLinks, entityType, cwd);
    if (!link) return;

    const dedupeKey = `${entityType}:${entity.id}:${link.absolutePath}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const message = createFederationMessage({
      version: 1,
      from: {
        project_id: input.actor.project_id ?? config.project_id,
        project_name: fromProjectName,
        project_path: cwd,
        agent_name: input.actor.agent,
        agent_id: input.actor.agent_id,
        host_id: input.actor.host_id,
      },
      to: {
        project_name: link.projectName,
        project_path: link.absolutePath,
      },
      type: entityType,
      payload: entity,
      causal_parent: input.sessionId,
    });

    pushSignal(link.absolutePath, message);
    pushed++;
  };

  for (const handoff of sessionHandoffs) {
    pushEntitySignal('handoff', handoff as unknown as Record<string, unknown> & { id: string });
  }
  for (const candidate of sessionCandidates) {
    pushEntitySignal('candidate', candidate as unknown as Record<string, unknown> & { id: string });
  }
  for (const note of sessionRuntimeNotes) {
    pushEntitySignal('runtime_note', note as unknown as Record<string, unknown> & { id: string });
  }

  return pushed;
}

function resolvePublisherLink(
  target: string,
  publisherLinks: ResolvedCrossProjectLink[],
  entityType: FederationSignalEntityType,
  cwd: string,
): ResolvedCrossProjectLink | undefined {
  const normalized = target.trim().toLowerCase();
  if (!normalized) return undefined;
  const absoluteTarget = path.resolve(cwd, target).toLowerCase();

  return publisherLinks.find((link) => {
    if (link.channels?.length && !link.channels.includes(entityType)) {
      return false;
    }
    const matchesByLabel = [link.projectName, link.name, link.path, link.absolutePath, path.basename(link.absolutePath)]
      .filter((entry): entry is string => Boolean(entry))
      .some((entry) => entry.toLowerCase() === normalized);
    if (matchesByLabel) return true;
    return path.resolve(link.absolutePath).toLowerCase() === absoluteTarget;
  });
}

function extractCrossProjectTarget(entity: Record<string, unknown>): string | undefined {
  const direct = extractTargetValue(entity.target_project)
    ?? extractTargetValue(entity.targetProject)
    ?? extractTargetValue(entity.cross_project)
    ?? extractTargetValue(entity.crossProject);
  if (direct) return direct;

  const metadata = entity.metadata;
  if (isRecord(metadata)) {
    const metadataTarget = extractTargetValue(metadata.target_project)
      ?? extractTargetValue(metadata.targetProject)
      ?? extractTargetValue(metadata.cross_project)
      ?? extractTargetValue(metadata.crossProject);
    if (metadataTarget) return metadataTarget;
  }

  const tags = entity.tags;
  if (Array.isArray(tags)) {
    for (const rawTag of tags) {
      if (typeof rawTag !== 'string') continue;
      const parsed = parseTargetTag(rawTag);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

function extractTargetValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['path', 'project_path', 'name', 'project_name']) {
    const nested = value[key];
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested.trim();
    }
  }
  return undefined;
}

function parseTargetTag(tag: string): string | undefined {
  const match = tag.match(/^(?:target_project|target-project|targetProject|cross_project|cross-project)\s*:\s*(.+)$/i);
  if (!match) return undefined;
  const target = match[1].trim();
  return target.length > 0 ? target : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

const SESSION_MEMORY_WRITE_ACTIONS: AuditAction[] = ['create', 'update', 'delete', 'accept', 'reject', 'trust_change', 'promote_direct', 'rollback'];

function buildSessionStats(input: {
  sessionId: string;
  sessionStartedAt?: string;
  agent: string;
  agentId?: string;
  notesInSession: ReturnType<typeof listRuntimeNotes>;
  cwd?: string;
}): SessionStatsSummary | undefined {
  if (!input.sessionStartedAt) {
    return undefined;
  }

  const startedAtMs = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }

  const auditEntries = readAuditLog({ since: input.sessionStartedAt, actor: input.agentId ?? input.agent }, input.cwd)
    .filter((entry) => belongsToSession(entry, input.sessionId));
  const runtimeWrites = input.notesInSession.filter((note) => (note.note_type ?? 'observation') === 'observation');
  const claimsCreated = auditEntries.filter((entry) => entry.action === 'claim').length;
  const planUpdates = auditEntries.filter((entry) =>
    entry.item_type === 'plan' && ['create', 'update', 'delete'].includes(entry.action)).length;
  const memoryWrites = auditEntries.filter((entry) => SESSION_MEMORY_WRITE_ACTIONS.includes(entry.action)).length + runtimeWrites.length;
  const lastBrainclawWrite = [
    ...runtimeWrites.map((note) => note.created_at),
    ...auditEntries.filter((entry) => SESSION_MEMORY_WRITE_ACTIONS.includes(entry.action)).map((entry) => entry.timestamp),
  ].sort().at(-1);
  const candidatesCreated = countSessionCandidates(input.sessionId, input.cwd);
  const fileEditsCount = countSessionEditedFiles(input.sessionId, input.cwd);

  const warnings: string[] = [];
  if (fileEditsCount > 0 && claimsCreated === 0) {
    warnings.push(`${fileEditsCount} file edit(s) with 0 claims created`);
  }
  if (fileEditsCount > 0 && memoryWrites === 0) {
    warnings.push(`${fileEditsCount} file edit(s) with 0 memory writes suggests decisions or traps may have been missed`);
  }

  return {
    session_duration_minutes: Math.max(0, Math.floor((Date.now() - startedAtMs) / 60_000)),
    file_edits_count: fileEditsCount,
    claims_created: claimsCreated,
    memory_writes: memoryWrites,
    plan_updates: planUpdates,
    candidates_created: candidatesCreated,
    last_brainclaw_write: lastBrainclawWrite,
    warnings,
  };
}

function belongsToSession(entry: AuditEntry, sessionId: string): boolean {
  return !entry.session_id || entry.session_id === sessionId;
}

function countSessionCandidates(sessionId: string, cwd?: string): number {
  const authored = [
    ...listCandidates(undefined, cwd),
    ...listArchivedCandidates('accepted', cwd),
    ...listArchivedCandidates('rejected', cwd),
  ];
  return authored.filter((candidate) => candidate.session_id === sessionId).length;
}

function countSessionEditedFiles(sessionId: string, cwd?: string): number {
  const snapshot = loadSessionSnapshot(sessionId, cwd);
  const repoCwd = cwd ?? process.cwd();

  try {
    const touched = new Set<string>();
    if (snapshot?.git_sha) {
      for (const pathEntry of execSync(`git diff --name-only ${snapshot.git_sha}..HEAD`, {
        cwd: repoCwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/).filter((entry) => Boolean(entry) && shouldCountEditedPath(entry))) {
        touched.add(pathEntry);
      }
    }
    for (const pathEntry of execSync('git diff --name-only HEAD', {
      cwd: repoCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter((entry) => Boolean(entry) && shouldCountEditedPath(entry))) {
      touched.add(pathEntry);
    }
    for (const pathEntry of execSync('git ls-files --others --exclude-standard', {
      cwd: repoCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter((entry) => Boolean(entry) && shouldCountEditedPath(entry))) {
      touched.add(pathEntry);
    }
    return touched.size;
  } catch {
    return 0;
  }
}

function shouldCountEditedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return !normalized.startsWith('.brainclaw/') && !normalized.startsWith('.git/');
}
