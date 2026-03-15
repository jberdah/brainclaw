import { readAuditLog } from '../core/audit.js';
import { memoryExists, memoryDir } from '../core/io.js';
import { listCandidates } from '../core/candidates.js';
import { loadState } from '../core/state.js';
import fs from 'node:fs';
import path from 'node:path';
import { nowISO } from '../core/ids.js';

export interface ContextDiffOptions {
  since?: string;
  session?: string;
  json?: boolean;
}

export function runContextDiff(options: ContextDiffOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  let sinceDate = options.since;

  // If --session provided, look up session start timestamp from audit log
  if (!sinceDate && options.session) {
    const sessionEntries = readAuditLog({ action: 'session_start' });
    const sessionEntry = sessionEntries.find(e => e.item_id === options.session || e.after === options.session);
    if (sessionEntry) {
      sinceDate = sessionEntry.timestamp;
    } else {
      console.error(`Error: session '${options.session}' not found in audit log.`);
      process.exit(1);
    }
  }

  // Fall back to .last-context marker
  if (!sinceDate) {
    const markerPath = path.join(memoryDir(), '.last-context');
    if (fs.existsSync(markerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { read_at?: string };
        sinceDate = marker.read_at;
      } catch {
        // ignore
      }
    }
  }

  if (!sinceDate) {
    console.error('Error: provide --since <ISO date> or --session <id>, or run `brainclaw context` first to seed a marker.');
    process.exit(1);
  }

  const checkedAt = nowISO();
  const state = loadState();

  const newCandidates = listCandidates('pending').filter(c => c.created_at >= sinceDate!);
  const newDecisions = state.recent_decisions.filter(d => d.created_at >= sinceDate!);
  const newConstraints = state.active_constraints.filter(c => c.created_at >= sinceDate!);
  const newTraps = state.known_traps.filter(t => t.created_at >= sinceDate!);
  const newHandoffs = state.open_handoffs.filter(h => h.created_at >= sinceDate!);

  const totalChanges = newDecisions.length + newConstraints.length + newTraps.length + newHandoffs.length + newCandidates.length;

  if (options.json) {
    console.log(JSON.stringify({
      since: sinceDate,
      checked_at: checkedAt,
      total_changes: totalChanges,
      new_decisions: newDecisions.length,
      new_constraints: newConstraints.length,
      new_traps: newTraps.length,
      new_handoffs: newHandoffs.length,
      new_candidates: newCandidates.length,
      summary: buildSummary(newDecisions.length, newConstraints.length, newTraps.length, newHandoffs.length, newCandidates.length),
    }, null, 2));
    return;
  }

  const summary = buildSummary(newDecisions.length, newConstraints.length, newTraps.length, newHandoffs.length, newCandidates.length);
  if (!summary) {
    console.log(`New since ${sinceDate}: nothing changed.`);
  } else {
    console.log(`New since ${sinceDate}: ${summary}.`);
  }
}

function buildSummary(decisions: number, constraints: number, traps: number, handoffs: number, candidates: number): string {
  const parts: string[] = [];
  if (decisions > 0) parts.push(`${decisions} decision${decisions > 1 ? 's' : ''} added`);
  if (constraints > 0) parts.push(`${constraints} constraint${constraints > 1 ? 's' : ''} added`);
  if (traps > 0) parts.push(`${traps} trap${traps > 1 ? 's' : ''} added`);
  if (handoffs > 0) parts.push(`${handoffs} handoff${handoffs > 1 ? 's' : ''} added`);
  if (candidates > 0) parts.push(`${candidates} candidate${candidates > 1 ? 's' : ''} pending`);
  return parts.join(', ');
}
