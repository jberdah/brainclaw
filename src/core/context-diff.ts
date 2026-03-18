import fs from 'node:fs';
import path from 'node:path';
import { readAuditLog } from './audit.js';
import { listCandidates } from './candidates.js';
import { readContextMarker } from './freshness.js';
import { memoryDir, resolveEntityDir } from './io.js';
import { logger } from './logger.js';
import { loadVersionedJsonFile } from './migration.js';
import { SessionSnapshotSchema, type SessionSnapshot } from './schema.js';
import { loadState } from './state.js';

type DiffSection = 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate';

export interface ContextDiffItem {
  section: DiffSection;
  id: string;
  text: string;
  created_at: string;
}

export interface ContextDiffResult {
  since?: string;
  since_session?: string;
  summary: string;
  counts: {
    constraints: number;
    decisions: number;
    traps: number;
    handoffs: number;
    pending_candidates: number;
    total: number;
  };
  changed_items?: ContextDiffItem[];
}

export interface BuildContextDiffOptions {
  since?: string;
  session?: string;
  cwd?: string;
  includeItems?: boolean;
}

export function resolveContextDiffSince(options: Pick<BuildContextDiffOptions, 'since' | 'session' | 'cwd'>): {
  since?: string;
  since_session?: string;
} {
  if (options.since) {
    return { since: options.since };
  }

  if (options.session) {
    const snapshot = loadSessionSnapshot(options.session, options.cwd);
    if (snapshot?.started_at) {
      return { since: snapshot.started_at, since_session: options.session };
    }

    const sessionEntry = readAuditLog({ action: 'session_start', itemId: options.session }, options.cwd)[0];
    if (sessionEntry?.timestamp) {
      return { since: sessionEntry.timestamp, since_session: options.session };
    }

    return { since_session: options.session };
  }

  const marker = readContextMarker(options.cwd);
  if (marker?.read_at) {
    return { since: marker.read_at };
  }

  return {};
}

function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined {
  const snapshotPath = path.join(resolveEntityDir('sessions', cwd ?? process.cwd(), 'read'), `${sessionId}.json`);
  if (!fs.existsSync(snapshotPath)) {
    return undefined;
  }
  try {
    return SessionSnapshotSchema.parse(loadVersionedJsonFile<SessionSnapshot>('session_snapshot', snapshotPath).document);
  } catch {
    return undefined;
  }
}

export function buildContextDiff(options: BuildContextDiffOptions = {}): ContextDiffResult | undefined {
  const resolved = resolveContextDiffSince(options);
  if (!resolved.since) {
    return undefined;
  }

  const state = loadState(options.cwd);
  const pendingCandidates = listCandidates('pending', options.cwd).filter((item) => item.created_at >= resolved.since!);
  const constraints = state.active_constraints.filter((item) => item.created_at >= resolved.since!);
  const decisions = state.recent_decisions.filter((item) => item.created_at >= resolved.since!);
  const traps = state.known_traps.filter((item) => item.created_at >= resolved.since!);
  const handoffs = state.open_handoffs.filter((item) => item.created_at >= resolved.since!);

  const changedItems = options.includeItems
    ? [
        ...constraints.map((item) => toChangedItem('constraint', item)),
        ...decisions.map((item) => toChangedItem('decision', item)),
        ...traps.map((item) => toChangedItem('trap', item)),
        ...handoffs.map((item) => toChangedItem('handoff', item)),
        ...pendingCandidates.map((item) => toChangedItem('candidate', item)),
      ].sort((a, b) => b.created_at.localeCompare(a.created_at))
    : undefined;

  const counts = {
    constraints: constraints.length,
    decisions: decisions.length,
    traps: traps.length,
    handoffs: handoffs.length,
    pending_candidates: pendingCandidates.length,
    total: constraints.length + decisions.length + traps.length + handoffs.length + pendingCandidates.length,
  };

  return {
    since: resolved.since,
    since_session: resolved.since_session,
    summary: buildContextDiffSummary(counts),
    counts,
    changed_items: changedItems,
  };
}

export function readLastContextTimestamp(cwd?: string): string | undefined {
  const marker = readContextMarker(cwd);
  if (marker?.read_at) {
    return marker.read_at;
  }

  const markerPath = path.join(memoryDir(cwd), '.last-context');
  if (fs.existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { read_at?: string };
      return parsed.read_at;
    } catch (error) {
      logger.debug('Failed to parse context marker fallback:', error);
    }
  }

  return undefined;
}

export function buildContextDiffSummary(counts: ContextDiffResult['counts']): string {
  if (counts.total === 0) {
    return 'No memory changes detected';
  }

  const parts: string[] = [];
  if (counts.constraints > 0) parts.push(`${counts.constraints} constraint${counts.constraints > 1 ? 's' : ''}`);
  if (counts.decisions > 0) parts.push(`${counts.decisions} decision${counts.decisions > 1 ? 's' : ''}`);
  if (counts.traps > 0) parts.push(`${counts.traps} trap${counts.traps > 1 ? 's' : ''}`);
  if (counts.handoffs > 0) parts.push(`${counts.handoffs} handoff${counts.handoffs > 1 ? 's' : ''}`);
  if (counts.pending_candidates > 0) parts.push(`${counts.pending_candidates} pending candidate${counts.pending_candidates > 1 ? 's' : ''}`);
  return parts.join(', ');
}

function toChangedItem(
  section: DiffSection,
  item: { id: string; text: string; created_at: string },
): ContextDiffItem {
  return {
    section,
    id: item.id,
    text: item.text,
    created_at: item.created_at,
  };
}
