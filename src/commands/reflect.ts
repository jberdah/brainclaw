import fs from 'node:fs';
import { memoryExists } from '../core/io.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { loadConfig } from '../core/config.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { loadState, persistState } from '../core/state.js';
import { scanText } from '../core/security.js';
import { nowISO, generateId, generateIdWithLabel } from '../core/ids.js';
import { saveCandidate, generateCandidateIdWithLabel, listCandidates, archiveCandidate } from '../core/candidates.js';
import { detectDuplicates } from '../core/duplicates.js';
import { RuntimeEventSchema, type CandidateType, type Candidate, type Constraint, type Decision, type Trap, type Handoff } from '../core/schema.js';
import { listRuntimeEventsBySession } from '../core/events.js';
import { agentCanWriteDirect, requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { generateTrapIdWithLabel } from '../core/traps.js';
import { evaluateReflectionSafety } from '../core/reflection-safety.js';
import type { ContradictionReport } from '../core/contradictions.js';

export interface ReflectOptions {
  type?: CandidateType;
  tag?: string[];
  author?: string;
  authorId?: string;
  projectId?: string;
  hostId?: string;
  sessionId?: string;
  source?: string;
  severity?: string;
  from?: string;
  to?: string;
  path?: string;
  batch?: string;
  session?: string;
  cwd?: string;
}

export interface CandidateCreationResult {
  candidateId: string;
  type: CandidateType;
  writeThrough: boolean;
  promotedItemId?: string;
  contradictionsDetected?: ContradictionReport[];
  contradictionSummary?: string;
  promotionBlockedReason?: string;
}

export function runReflect(text: string | undefined, options: ReflectOptions): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (options.batch) {
    runReflectBatchFromFile(options.batch, options);
    return;
  }

  if (options.session) {
    runReflectBatchFromSession(options.session, options);
    return;
  }

  if (!text || !options.type) {
    console.error('Error: single reflect mode requires <text> and --type.');
    process.exit(1);
  }

  createCandidateFromInput(text, options.type, options);
}

function runReflectBatchFromFile(filepath: string, baseOptions: ReflectOptions): void {
  if (!fs.existsSync(filepath)) {
    console.error(`Error: batch file not found: ${filepath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: invalid JSON batch file: ${msg}`);
    process.exit(1);
  }

  const rawEvents: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown[] }).events)
      ? (parsed as { events: unknown[] }).events
      : [parsed];

  let created = 0;
  for (const rawEvent of rawEvents) {
    try {
      const event = RuntimeEventSchema.parse(rawEvent);
      const candidateType = event.candidate_type ?? mapEventTypeToCandidateType(event.event_type);
      createCandidateFromInput(event.text, candidateType, {
        ...baseOptions,
        type: candidateType,
        tag: event.tags.length ? event.tags : baseOptions.tag,
        authorId: baseOptions.authorId ?? event.agent_id,
        projectId: baseOptions.projectId ?? event.project_id,
        hostId: baseOptions.hostId ?? event.host_id,
        sessionId: baseOptions.sessionId ?? event.session_id,
        source: baseOptions.source ?? event.agent,
        severity: baseOptions.severity ?? event.severity,
        from: baseOptions.from ?? event.from,
        to: baseOptions.to ?? event.to,
        path: baseOptions.path ?? event.related_paths?.[0],
      }, false, true, true);
      created++;
    } catch {
      // skip malformed event records
    }
  }

  console.log(`✔ Created ${created} candidate(s) from batch file`);
}

function runReflectBatchFromSession(session: string, baseOptions: ReflectOptions): void {
  const events = listRuntimeEventsBySession(session);
  if (events.length === 0) {
    console.error(`Error: no runtime events found for session '${session}'.`);
    process.exit(1);
  }

  let created = 0;
  for (const event of events) {
    const candidateType = event.candidate_type ?? mapEventTypeToCandidateType(event.event_type);
    createCandidateFromInput(event.text, candidateType, {
      ...baseOptions,
      type: candidateType,
      tag: event.tags.length ? event.tags : baseOptions.tag,
      authorId: baseOptions.authorId ?? event.agent_id,
      projectId: baseOptions.projectId ?? event.project_id,
      hostId: baseOptions.hostId ?? event.host_id,
      sessionId: baseOptions.sessionId ?? event.session_id,
      source: baseOptions.source ?? event.agent,
      severity: baseOptions.severity ?? event.severity,
      from: baseOptions.from ?? event.from,
      to: baseOptions.to ?? event.to,
      path: baseOptions.path ?? event.related_paths?.[0],
    }, false, true, true);
    created++;
  }

  console.log(`✔ Created ${created} candidate(s) from session '${session}'`);
}

export function createCandidateFromInput(
  text: string,
  type: CandidateType,
  options: ReflectOptions,
  printSuccess: boolean = true,
  forceStrict: boolean = false,
  automation: boolean = false,
): CandidateCreationResult {
  const config = loadConfig(options.cwd);
  const explicitAuthor = options.author?.trim();
  const explicitAuthorId = options.authorId?.trim();
  const registeredAuthor = requireRegisteredAgentIdentity({
    agentName: explicitAuthor,
    agentId: explicitAuthorId,
    cwd: options.cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(registeredAuthor, 'contributor');
  const actorIdentity = buildOperationalIdentity(registeredAuthor.agent_name, options.cwd, {
    agentId: registeredAuthor.agent_id,
    sessionId: options.sessionId,
  });

  // Security scan — batch/automated imports always block on sensitive content
  const rawWarnings = scanText(text, config);
  const warnings = forceStrict
    ? rawWarnings.map(w => ({ ...w, level: 'block' as const }))
    : rawWarnings;

  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error(
        forceStrict
          ? 'Blocked: sensitive content in automated import. Candidate not created.'
          : 'Blocked: strict redaction is enabled. Candidate not created.'
      );
      process.exit(1);
    }
  }

  // Duplicate detection
  const state = loadState(options.cwd);
  const pending = listCandidates('pending', options.cwd);
  const dupes = detectDuplicates(text, type, state, pending);
  if (dupes.length > 0) {
    console.warn('⚠ Possible duplicates detected:');
    for (const d of dupes) {
      console.warn(`  - [${d.id}] (${d.source}) ${d.reason}: "${d.text}"`);
    }
  }

  const { id, short_label } = generateCandidateIdWithLabel(options.cwd);
  const candidate = {
    id,
    short_label,
    type,
    text,
    created_at: nowISO(),
    author: options.author ?? actorIdentity.agent,
    author_id: options.authorId ?? actorIdentity.agent_id,
    project_id: options.projectId ?? actorIdentity.project_id,
    host_id: options.hostId ?? actorIdentity.host_id,
    session_id: options.sessionId ?? actorIdentity.session_id,
    source: options.source,
    tags: options.tag ?? [],
    status: 'pending' as const,
    severity: type === 'trap' ? (options.severity as 'low' | 'medium' | 'high' | undefined) ?? 'medium' : undefined,
    from: type === 'handoff' ? options.from : undefined,
    to: type === 'handoff' ? options.to : undefined,
    related_paths: options.path ? [options.path] : undefined,
    star_count: 0,
    starred_by: [],
    usage_count: 0,
    usage_events: [],
  };
  const safety = evaluateReflectionSafety({
    text,
    type,
    tags: candidate.tags,
    relatedPaths: candidate.related_paths,
    projectId: candidate.project_id,
    cwd: options.cwd,
    automation,
  });
  if (safety.contradiction_summary) {
    console.warn(`⚠ ${safety.contradiction_summary}`);
  }
  const candidateWithSafety = {
    ...candidate,
    contradictions_detected: safety.contradictions_detected,
    contradiction_summary: safety.contradiction_summary,
    promotion_blocked_reason: safety.promotion_blocked_reason,
  };

  // Write-through for trusted/curator agents — bypass pending inbox
  if (!forceStrict) {
    try {
      if (!safety.promotion_blocked_reason && agentCanWriteDirect(candidate.author_id ?? candidate.author, options.cwd)) {
        const promotedItemId = promoteCandidateToState(candidateWithSafety, options.cwd);
        appendAuditEntry({
          actor: candidate.author,
          actor_id: candidate.author_id,
          action: 'promote_direct',
          item_id: id,
          item_type: type,
          after: candidate,
        });
        if (printSuccess) {
          console.log(`✔ Direct write: [${id}] (${type}) ${text} (trusted agent — bypassed inbox)`);
        }
        return {
          candidateId: id,
          type,
          writeThrough: true,
          promotedItemId,
          contradictionsDetected: safety.contradictions_detected,
          contradictionSummary: safety.contradiction_summary,
        };
      }
    } catch { /* trust check failed — fall through to pending */ }
  }

  saveCandidate(candidateWithSafety, options.cwd);
  if (printSuccess) {
    console.log(`✔ Candidate created: [${id}] (${type}) ${text}`);
    if (safety.promotion_blocked_reason) {
      console.log(`  Auto-promotion blocked: ${safety.promotion_blocked_reason}`);
    }
  }
  return {
    candidateId: id,
    type,
    writeThrough: false,
    contradictionsDetected: safety.contradictions_detected,
    contradictionSummary: safety.contradiction_summary,
    promotionBlockedReason: safety.promotion_blocked_reason,
  };
}

function promoteCandidateToState(candidate: Candidate, cwd?: string): string {
  const state = loadState(cwd);
  let promotedItemId = '';
  switch (candidate.type) {
    case 'constraint': {
      const { id: cId, short_label } = generateIdWithLabel('active_constraints', cwd);
      const entry: Constraint = { id: cId, short_label, text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, status: 'active', tags: candidate.tags };
      state.active_constraints.push(entry);
      promotedItemId = entry.id;
      break;
    }
    case 'decision': {
      const { id: dId, short_label } = generateIdWithLabel('recent_decisions', cwd);
      const entry: Decision = { id: dId, short_label, text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, related_paths: candidate.related_paths, tags: candidate.tags };
      state.recent_decisions.push(entry);
      promotedItemId = entry.id;
      break;
    }
    case 'trap': {
      const { id: tId, short_label } = generateTrapIdWithLabel(cwd);
      const entry: Trap = { id: tId, short_label, text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, status: 'active', severity: candidate.severity ?? 'medium', tags: candidate.tags, visibility: 'shared' };
      state.known_traps.push(entry);
      promotedItemId = entry.id;
      break;
    }
    case 'handoff': {
      const { id: hId, short_label } = generateIdWithLabel('open_handoffs', cwd);
      const entry: Handoff = { id: hId, short_label, text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, from: candidate.from ?? '', to: candidate.to ?? '', status: 'open', tags: candidate.tags, related_paths: candidate.related_paths };
      state.open_handoffs.push(entry);
      promotedItemId = entry.id;
      break;
    }
  }
  persistState(state, cwd);
  rebuildProjectMd(loadState(cwd), cwd);
  return promotedItemId;
}

export function mapEventTypeToCandidateType(eventType: string): CandidateType {
  switch (eventType) {
    case 'risk_detected':
      return 'trap';
    case 'handoff_requested':
      return 'handoff';
    case 'task_started':
    case 'task_finished':
      return 'constraint';
    case 'observation':
    default:
      return 'decision';
  }
}
