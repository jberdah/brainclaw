import { loadAllSessions, gcStaleSessions } from '../core/identity.js';
import { loadState } from '../core/state.js';
import type { CurrentSessionState } from '../core/schema.js';

export interface WhoOptions {
  json?: boolean;
  all?: boolean;
  gc?: boolean;
  cwd?: string;
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

  // Load claims for cross-reference
  const state = loadState(cwd);
  const claims = state.open_handoffs.length > 0 ? [] : []; // placeholder
  const activeClaims = loadActiveClaims(cwd);

  if (options.json) {
    const output = sessions.map(s => ({
      session_id: s.session_id,
      user: s.user ?? 'unknown',
      agent: s.agent,
      agent_id: s.agent_id,
      host_id: s.host_id,
      project: s.active_project?.name ?? s.active_project?.path ?? null,
      claims: countClaimsForAgent(activeClaims, s.agent_id),
      started_at: s.started_at,
      last_seen_at: s.last_seen_at,
      stale: (now - Date.parse(s.last_seen_at)) > ttlMs,
      pid: s.pid,
    }));
    console.log(JSON.stringify({ sessions: output, total: output.length }, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('No active sessions.');
    return;
  }

  // Table header
  const header = ['USER', 'AGENT', 'PROJECT', 'CLAIMS', 'LAST SEEN'];
  const rows: string[][] = [];

  for (const s of sessions) {
    const age = now - Date.parse(s.last_seen_at);
    const ageStr = formatAge(age);
    const stale = age > ttlMs;
    const project = s.active_project?.name ?? s.active_project?.path ?? '(workspace root)';
    const claimCount = countClaimsForAgent(activeClaims, s.agent_id);
    rows.push([
      s.user ?? 'unknown',
      s.agent,
      project.length > 25 ? project.slice(0, 22) + '...' : project,
      String(claimCount),
      stale ? `${ageStr} (stale)` : ageStr,
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
  console.log(`\n${sessions.length} session(s).`);
}

interface ClaimInfo {
  agent_id?: string;
  scope: string;
}

function loadActiveClaims(cwd?: string): ClaimInfo[] {
  try {
    const state = loadState(cwd);
    // Claims are in coordination — extract from plan_items or dedicated claims
    // Use the existing claims loading
    const claimsDir = getClaimsDir(cwd);
    if (!claimsDir) return [];
    const fs = require('node:fs');
    const path = require('node:path');
    if (!fs.existsSync(claimsDir)) return [];
    const files = fs.readdirSync(claimsDir).filter((f: string) => f.endsWith('.json'));
    const claims: ClaimInfo[] = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(claimsDir, file), 'utf-8'));
        if (raw.status === 'active') {
          claims.push({ agent_id: raw.agent_id, scope: raw.scope });
        }
      } catch { /* skip */ }
    }
    return claims;
  } catch {
    return [];
  }
}

function getClaimsDir(cwd?: string): string | null {
  const path = require('node:path');
  const { memoryDir } = require('../core/io.js');
  try {
    return path.join(memoryDir(cwd), 'coordination', 'claims');
  } catch {
    return null;
  }
}

function countClaimsForAgent(claims: ClaimInfo[], agentId: string): number {
  return claims.filter(c => c.agent_id === agentId).length;
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
