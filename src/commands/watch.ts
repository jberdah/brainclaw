import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, memoryPath } from '../core/io.js';
import { loadState } from '../core/state.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { listCandidates } from '../core/candidates.js';
import { readAuditLog } from '../core/audit.js';

export interface WatchOptions {
  agent?: string;
  project?: string;
  sections?: string[];
  interval?: number;
}

type WatchEvent = {
  event: string;
  section: string;
  item_id?: string;
  text?: string;
  author?: string;
  timestamp: string;
};

function emit(event: WatchEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

export function runWatch(options: WatchOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const intervalMs = (options.interval ?? 2) * 1000;
  const dir = memoryPath('');

  emit({
    event: 'watch_started',
    section: 'system',
    timestamp: new Date().toISOString(),
  });

  // Track known item counts per section for change detection
  const last = {
    constraints: 0,
    decisions: 0,
    traps: 0,
    handoffs: 0,
    plans: 0,
    notes: 0,
    candidates: 0,
    audit: 0,
  };

  // Initialise baseline without emitting
  try {
    const state = loadState();
    last.constraints = state.active_constraints.length;
    last.decisions = state.recent_decisions.length;
    last.traps = state.known_traps.length;
    last.handoffs = state.open_handoffs.length;
    last.plans = state.plan_items.length;
  } catch { /* ignore */ }
  try { last.notes = listRuntimeNotes().length; } catch { /* ignore */ }
  try { last.candidates = listCandidates().length; } catch { /* ignore */ }
  try { last.audit = readAuditLog().length; } catch { /* ignore */ }

  const tick = (): void => {
    try {
      const state = loadState();
      if (state.active_constraints.length !== last.constraints) {
        const delta = state.active_constraints.length - last.constraints;
        last.constraints = state.active_constraints.length;
        if (delta > 0) {
          const added = state.active_constraints.slice(-delta);
          for (const c of added) {
            emit({ event: 'added', section: 'constraint', item_id: c.id, text: c.text, author: c.author, timestamp: c.created_at });
          }
        } else {
          emit({ event: 'removed', section: 'constraint', timestamp: new Date().toISOString() });
        }
      }
      if (state.recent_decisions.length !== last.decisions) {
        const delta = state.recent_decisions.length - last.decisions;
        last.decisions = state.recent_decisions.length;
        if (delta > 0) {
          const added = state.recent_decisions.slice(-delta);
          for (const d of added) {
            emit({ event: 'added', section: 'decision', item_id: d.id, text: d.text, author: d.author, timestamp: d.created_at });
          }
        }
      }
      if (state.known_traps.length !== last.traps) {
        const delta = state.known_traps.length - last.traps;
        last.traps = state.known_traps.length;
        if (delta > 0) {
          const added = state.known_traps.slice(-delta);
          for (const t of added) {
            emit({ event: 'added', section: 'trap', item_id: t.id, text: t.text, author: t.author, timestamp: t.created_at });
          }
        }
      }
      if (state.open_handoffs.length !== last.handoffs) {
        last.handoffs = state.open_handoffs.length;
        emit({ event: 'changed', section: 'handoffs', timestamp: new Date().toISOString() });
      }
      if (state.plan_items.length !== last.plans) {
        last.plans = state.plan_items.length;
        emit({ event: 'changed', section: 'plans', timestamp: new Date().toISOString() });
      }
    } catch { /* state not available yet */ }

    try {
      const notes = listRuntimeNotes();
      if (notes.length !== last.notes) {
        const delta = notes.length - last.notes;
        last.notes = notes.length;
        if (delta > 0) {
          const added = notes.slice(-delta);
          for (const n of added) {
            emit({ event: 'added', section: 'runtime_note', item_id: n.id, text: n.text, author: n.agent, timestamp: n.created_at });
          }
        }
      }
    } catch { /* ignore */ }

    try {
      const candidates = listCandidates();
      if (candidates.length !== last.candidates) {
        const delta = candidates.length - last.candidates;
        last.candidates = candidates.length;
        if (delta > 0) {
          const added = candidates.slice(-delta);
          for (const c of added) {
            emit({ event: 'added', section: 'candidate', item_id: c.id, text: c.text, author: c.author, timestamp: c.created_at });
          }
        }
      }
    } catch { /* ignore */ }

    try {
      const auditEntries = readAuditLog();
      if (auditEntries.length !== last.audit) {
        const delta = auditEntries.length - last.audit;
        last.audit = auditEntries.length;
        if (delta > 0) {
          const added = auditEntries.slice(-delta);
          for (const e of added) {
            emit({ event: 'audit', section: 'audit', item_id: e.item_id, timestamp: e.timestamp });
          }
        }
      }
    } catch { /* ignore */ }
  };

  // Watch loop — poll on interval
  setInterval(tick, intervalMs);

  // Also watch the memory dir for any file changes
  try {
    fs.watch(dir, { recursive: true }, (_eventType: string, filename: string | null) => {
      if (filename && !filename.endsWith('.lock')) {
        // Just emit a raw file-change event; tick() will handle the details on next poll
        emit({
          event: 'file_changed',
          section: 'fs',
          text: filename,
          timestamp: new Date().toISOString(),
        });
      }
    });
  } catch {
    // fs.watch not available (e.g. some Docker environments) — poll only is fine
  }

  process.on('SIGINT', () => {
    emit({ event: 'watch_stopped', section: 'system', timestamp: new Date().toISOString() });
    process.exit(0);
  });
}
