import os from 'node:os';
import { loadAllSessions, gcStaleSessions } from '../core/identity.js';
import { listClaims } from '../core/claims.js';
import { resolveStoreChain } from '../core/store-resolution.js';
import type { CurrentSessionState, Claim } from '../core/schema.js';

export interface WhoOptions {
  json?: boolean;
  all?: boolean;
  gc?: boolean;
  cwd?: string;
  /** Read claims from local store only, skipping parent stores in the chain. Default: false (chain mode). */
  localOnly?: boolean;
}

export function runWho(options: WhoOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (options.gc) {
    const removed = gcStaleSessions(cwd);
    if (options.json) {
      console.log(JSON.stringify({ gc: true, removed }));
    } else {
      console.log(`✔ Removed ${removed} stale session(s).`);
    }
    return;
  }

  const allSessions = loadAllSessions(cwd);
  const ttlMs = 4 * 60 * 60 * 1000; // 4h default
  const now = Date.now();

  const sessions = options.all
    ? allSessions
    : allSessions.filter(s => (now - Date.parse(s.last_seen_at)) <= ttlMs);

  let activeClaims: Claim[];
  if (options.localOnly) {
    activeClaims = listClaims(cwd).filter(c => c.status === 'active');
  } else {
    const chain = resolveStoreChain(cwd);
    const seenIds = new Set<string>();
    activeClaims = [];
    for (const store of chain) {
      try {
        for (const claim of listClaims(store.cwd)) {
          if (claim.status === 'active' && !seenIds.has(claim.id)) {
            seenIds.add(claim.id);
            activeClaims.push(claim);
          }
        }
      } catch { /* skip unreadable stores */ }
    }
    if (activeClaims.length === 0 && chain.length === 0) {
      activeClaims = listClaims(cwd).filter(c => c.status === 'active');
    }
  }

  const enriched = sessions.map(s => {
    const age = now - Date.parse(s.last_seen_at);
    const stale = age > ttlMs;
    const dead = s.pid ? !isPidAlive(s.pid) : false;
    const status = dead ? 'dead' : stale ? 'stale' : 'active';
    return {
      session_id: s.session_id,
      user: s.user ?? 'unknown',
      agent: s.agent,
      agent_id: s.agent_id,
      host_id: s.host_id,
      model: s.model ?? null,
      project: s.active_project?.name ?? s.active_project?.path ?? null,
      branch: s.branch ?? null,
      isolation_mode: s.isolation_mode ?? 'shared-checkout',
      claims: activeClaims.filter(c => c.session_id === s.session_id || (!c.session_id && c.agent_id === s.agent_id)).length,
      started_at: s.started_at,
      last_seen_at: s.last_seen_at,
      status,
      pid: s.pid,
    };
  });

  if (options.json) {
    console.log(JSON.stringify({ sessions: enriched, total: enriched.length }, null, 2));
    return;
  }

  if (enriched.length === 0) {
    console.log('No active sessions.');
    return;
  }

  // Table header
  const header = ['USER', 'AGENT', 'MODEL', 'BRANCH', 'CLAIMS', 'STATUS', 'LAST SEEN'];
  const rows: string[][] = [];

  for (const s of enriched) {
    const age = now - Date.parse(s.last_seen_at);
    const model = s.model ?? '-';
    const branch = s.branch ?? '-';
    rows.push([
      s.user,
      s.agent,
      model.length > 20 ? model.slice(0, 17) + '...' : model,
      branch.length > 20 ? branch.slice(0, 17) + '...' : branch,
      String(s.claims),
      s.status,
      formatAge(age),
    ]);
  }

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i]!.length))
  );

  console.log('Active sessions:\n');
  console.log('  ' + header.map((h, i) => h.padEnd(widths[i]!)).join('  '));
  console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log('  ' + row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  }
  console.log(`\n${enriched.length} session(s).`);
}

function isPidAlive(pid: number): boolean {
  try {
    // process.kill(pid, 0) throws if process doesn't exist
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
