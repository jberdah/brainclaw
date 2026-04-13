import fs from 'node:fs';
import path from 'node:path';
import { resolveEventSessionId } from './identity.js';
import { RuntimeEventSchema, type RuntimeEvent } from './schema.js';
import { readFileSync, resolveEntityDir, writeFileAtomic } from './io.js';
import { logger } from './logger.js';
import { mutate } from './mutation-pipeline.js';
import { generateId, nowISO } from './ids.js';

function runtimeDir(cwd?: string): string {
  return resolveEntityDir('runtime', cwd ?? process.cwd(), 'read');
}

function runtimeEventsDir(cwd?: string, mode: 'read' | 'write' = 'read'): string {
  return path.join(resolveEntityDir('runtime', cwd ?? process.cwd(), mode), 'agent-runtime');
}

function ensureRuntimeEventsDir(cwd?: string): void {
  const dir = runtimeEventsDir(cwd, 'write');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function collectJsonFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

export function listRuntimeEvents(cwd?: string): RuntimeEvent[] {
  const base = runtimeDir(cwd);
  if (!fs.existsSync(base)) return [];

  const events: RuntimeEvent[] = [];
  for (const file of collectJsonFiles(base)) {
    try {
      const parsed = JSON.parse(readFileSync(file));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          events.push(RuntimeEventSchema.parse(item));
        }
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
        for (const item of parsed.events) {
          events.push(RuntimeEventSchema.parse(item));
        }
      } else {
        events.push(RuntimeEventSchema.parse(parsed));
      }
    } catch (err) {
      logger.debug('Ignoring malformed runtime event file:', file, err);
    }
  }

  return events.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface RuntimeEventFilter {
  id?: string;
  agent?: string;
  session_id?: string;
  event_type?: RuntimeEvent['event_type'];
  assignment_id?: string;
  run_id?: string;
  claim_id?: string;
  plan_id?: string;
  sequence_id?: string;
  reflectableOnly?: boolean;
}

export function queryRuntimeEvents(filter: RuntimeEventFilter = {}, cwd?: string): RuntimeEvent[] {
  let events = listRuntimeEvents(cwd);

  if (filter.id) {
    events = events.filter((event) => event.id === filter.id);
  }
  if (filter.agent) {
    events = events.filter((event) => event.agent === filter.agent);
  }
  if (filter.session_id) {
    events = events.filter((event) => resolveEventSessionId(event) === filter.session_id);
  }
  if (filter.event_type) {
    events = events.filter((event) => event.event_type === filter.event_type);
  }
  if (filter.assignment_id) {
    events = events.filter((event) => event.assignment_id === filter.assignment_id);
  }
  if (filter.run_id) {
    events = events.filter((event) => event.run_id === filter.run_id);
  }
  if (filter.claim_id) {
    events = events.filter((event) => event.claim_id === filter.claim_id);
  }
  if (filter.plan_id) {
    events = events.filter((event) => event.plan_id === filter.plan_id);
  }
  if (filter.sequence_id) {
    events = events.filter((event) => event.sequence_id === filter.sequence_id);
  }
  if (filter.reflectableOnly) {
    events = events.filter((event) => isReflectableRuntimeEvent(event));
  }

  return events;
}

export function listRuntimeEventsBySession(session: string, cwd?: string): RuntimeEvent[] {
  return queryRuntimeEvents({ session_id: session }, cwd);
}

export interface CreateRuntimeEventOptions {
  id?: string;
  agent: string;
  agent_id?: string;
  project_id?: string;
  host_id?: string;
  session_id?: string;
  event_type: RuntimeEvent['event_type'];
  created_at?: string;
  text: string;
  tags?: string[];
  assignment_id?: string;
  run_id?: string;
  claim_id?: string;
  message_id?: string;
  plan_id?: string;
  sequence_id?: string;
  correlation_id?: string;
  scope?: string;
  transport?: RuntimeEvent['transport'];
  status?: string;
  status_reason?: string;
  candidate_type?: RuntimeEvent['candidate_type'];
  severity?: RuntimeEvent['severity'];
  from?: string;
  to?: string;
  related_paths?: string[];
  metadata?: Record<string, unknown>;
  model?: string;
}

export function saveRuntimeEvent(event: RuntimeEvent, cwd?: string): RuntimeEvent {
  const parsed = RuntimeEventSchema.parse(event);
  mutate({ cwd }, () => {
    ensureRuntimeEventsDir(cwd);
    const filepath = path.join(runtimeEventsDir(cwd, 'write'), `${parsed.id}.json`);
    writeFileAtomic(filepath, JSON.stringify(parsed, null, 2) + '\n');
  });
  return parsed;
}

export function createRuntimeEvent(options: CreateRuntimeEventOptions, cwd?: string): RuntimeEvent {
  const event: RuntimeEvent = RuntimeEventSchema.parse({
    id: options.id ?? generateId('runtime_events'),
    agent: options.agent,
    agent_id: options.agent_id,
    project_id: options.project_id,
    host_id: options.host_id,
    session_id: options.session_id,
    event_type: options.event_type,
    created_at: options.created_at ?? nowISO(),
    text: options.text,
    tags: options.tags ?? [],
    assignment_id: options.assignment_id,
    run_id: options.run_id,
    claim_id: options.claim_id,
    message_id: options.message_id,
    plan_id: options.plan_id,
    sequence_id: options.sequence_id,
    correlation_id: options.correlation_id,
    scope: options.scope,
    transport: options.transport,
    status: options.status,
    status_reason: options.status_reason,
    candidate_type: options.candidate_type,
    severity: options.severity,
    from: options.from,
    to: options.to,
    related_paths: options.related_paths,
    metadata: options.metadata,
    model: options.model,
  });
  return saveRuntimeEvent(event, cwd);
}

const REFLECTABLE_RUNTIME_EVENT_TYPES = new Set<RuntimeEvent['event_type']>([
  'task_started',
  'observation',
  'risk_detected',
  'handoff_requested',
  'task_finished',
  'session_start',
  'session_end',
]);

export function isReflectableRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.candidate_type) return true;
  return REFLECTABLE_RUNTIME_EVENT_TYPES.has(event.event_type);
}

export function isTaskLifecycleRuntimeEvent(event: RuntimeEvent): boolean {
  return event.event_type === 'task_started' || event.event_type === 'task_finished';
}
