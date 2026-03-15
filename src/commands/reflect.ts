import fs from 'node:fs';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { loadState, saveState } from '../core/state.js';
import { scanText } from '../core/security.js';
import { nowISO, generateId } from '../core/ids.js';
import { saveCandidate, generateCandidateId, listCandidates, archiveCandidate } from '../core/candidates.js';
import { detectDuplicates } from '../core/duplicates.js';
import { RuntimeEventSchema, type CandidateType, type Candidate, type Constraint, type Decision, type Trap, type Handoff } from '../core/schema.js';
import { listRuntimeEventsBySession } from '../core/events.js';
import { agentCanWriteDirect } from '../core/agent-registry.js';
import { appendAuditEntry } from '../core/audit.js';
import { generateTrapId } from '../core/traps.js';

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
      }, false, true);
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
    }, false, true);
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
): void {
  const config = loadConfig(options.cwd);
  let actorIdentity;
  try {
    actorIdentity = buildOperationalIdentity(undefined, options.cwd);
  } catch {
    actorIdentity = undefined;
  }

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

  const id = generateCandidateId();
  const candidate = {
    id,
    type,
    text,
    created_at: nowISO(),
    author: options.author ?? actorIdentity?.agent ?? getDefaultAuthor(),
    author_id: options.authorId ?? actorIdentity?.agent_id,
    project_id: options.projectId ?? actorIdentity?.project_id,
    host_id: options.hostId ?? actorIdentity?.host_id,
    session_id: options.sessionId ?? actorIdentity?.session_id,
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

  // Write-through for trusted/curator agents — bypass pending inbox
  if (!forceStrict) {
    try {
      if (agentCanWriteDirect(candidate.author_id ?? candidate.author)) {
        promoteCandidateToState(candidate, options.cwd);
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
        return;
      }
    } catch { /* trust check failed — fall through to pending */ }
  }

  saveCandidate(candidate, options.cwd);
  if (printSuccess) {
    console.log(`✔ Candidate created: [${id}] (${type}) ${text}`);
  }
}

function promoteCandidateToState(candidate: Candidate, cwd?: string): void {
  const state = loadState(cwd);
  switch (candidate.type) {
    case 'constraint': {
      const entry: Constraint = { id: generateId('active_constraints'), text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, status: 'active', tags: candidate.tags };
      state.active_constraints.push(entry);
      break;
    }
    case 'decision': {
      const entry: Decision = { id: generateId('recent_decisions'), text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, related_paths: candidate.related_paths, tags: candidate.tags };
      state.recent_decisions.push(entry);
      break;
    }
    case 'trap': {
      const entry: Trap = { id: generateTrapId(), text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, severity: candidate.severity ?? 'medium', tags: candidate.tags, visibility: 'shared' };
      state.known_traps.push(entry);
      break;
    }
    case 'handoff': {
      const entry: Handoff = { id: generateId('open_handoffs'), text: candidate.text, created_at: candidate.created_at, author: candidate.author, author_id: candidate.author_id, project_id: candidate.project_id, host_id: candidate.host_id, session_id: candidate.session_id, from: candidate.from ?? '', to: candidate.to ?? '', status: 'open', tags: candidate.tags, related_paths: candidate.related_paths };
      state.open_handoffs.push(entry);
      break;
    }
  }
  saveState(state, cwd);
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

function getDefaultAuthor(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}
