/**
 * Sprint 1.5 — dispatch lifecycle hardening (pln#550).
 *
 * Pins the dogfooding fixes:
 *  - can_948acfd6: implicit acceptance evidence vetoes acceptance-TTL expiry;
 *    expired→completed convergence when evidence arrives late.
 *  - can_2e282880 / can_45316d5c: worktree-as-contract at creation — reused
 *    branches reset to the dispatch base (or refused when diverged), and
 *    scope-derived branch names are valid git refs.
 *  - can_c39f0961: OEM cp850 log decoding.
 *  - can_b8d53d18: runtime_note ids use rtn_ (no collision with agent_run run_).
 *  - lop_e2d566765b8b4ce3 L2: hook recognition matches command position only.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { generateId, nowISO } from '../../src/core/ids.js';
import { saveRuntimeNote, findRuntimeNoteById, migrateRuntimeNoteIdPrefixes, listRuntimeNotes } from '../../src/core/runtime.js';
import { decodeOemAwareBuffer, getWorktreeHeartbeatPath, readHeartbeat, getRuntimeSignalPath } from '../../src/core/runtime-signals.js';
import { sanitizeBranchComponent, createWorktree } from '../../src/core/worktree.js';
import { sweepAssignments } from '../../src/core/assignment-sweeper.js';
import { saveAssignment, loadAssignment, validateTransition } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import { createAgentRun } from '../../src/core/agentruns.js';
import { getDispatchStatus } from '../../src/core/dispatch-status.js';
import { integrateLaneResults, getLaneResultPath } from '../../src/commands/harvest.js';
import { __agentFilesTesting } from '../../src/core/agent-files.js';
import type { Assignment, Claim } from '../../src/core/schema.js';

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function gitInit(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'hardening@brainclaw.local');
  git(dir, 'config', 'user.name', 'Hardening Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'bootstrap');
}

function seedAssignment(ws: TestWorkspace, id: string, overrides: Partial<Assignment>): Assignment {
  const a: Assignment = {
    schema_version: 2, id, short_label: id,
    claim_id: 'clm_hard', agent: 'claude-code', dispatcher_agent: 'coordinator',
    scope: 'hardening-scope', description: 'hardening work', status: 'offered',
    created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(), last_heartbeat_at: nowISO(),
    artifacts: [], retry_count: 0, max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [],
    ...overrides,
  };
  saveAssignment(a, ws.dir);
  return a;
}

function seedClaim(ws: TestWorkspace, id: string, overrides: Partial<Claim> = {}): Claim {
  const claim: Claim = {
    schema_version: 2, id, agent: 'claude-code', scope: 'hardening-scope',
    description: 'hardening claim', created_at: nowISO(), status: 'active',
    ...overrides,
  };
  saveClaim(claim, ws.dir);
  return claim;
}

// ── can_b8d53d18: id prefixes ────────────────────────────────────────────────

describe('runtime_note id prefix (can_b8d53d18)', () => {
  it('generateId(runtime_note) uses rtn_, distinct from agent_run run_', () => {
    assert.match(generateId('runtime_note'), /^rtn_[0-9a-f]{8}$/);
    assert.match(generateId('runtime_notes'), /^rtn_[0-9a-f]{8}$/);
    assert.match(generateId('runs'), /^run_[0-9a-f]{8}$/);
  });

  it('migrateRuntimeNoteIdPrefixes renames legacy run_ notes to rtn_ losslessly', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rtn-mig-' });
    try {
      saveRuntimeNote({
        id: 'run_deadbee1', agent: 'tester', text: 'legacy-prefixed note',
        created_at: nowISO(), tags: [], visibility: 'shared', note_type: 'observation',
      }, ws.dir);
      const result = migrateRuntimeNoteIdPrefixes(ws.dir);
      assert.equal(result.errors.length, 0);
      assert.deepEqual(result.migrated, [{ from: 'run_deadbee1', to: 'rtn_deadbee1' }]);
      assert.ok(findRuntimeNoteById('rtn_deadbee1', {}, ws.dir), 'migrated note resolvable under rtn_');
      assert.equal(findRuntimeNoteById('run_deadbee1', {}, ws.dir), undefined, 'legacy id gone');
      assert.equal(listRuntimeNotes({ visibility: 'all' }, ws.dir).length, 1, 'no duplicate left behind');
    } finally {
      ws.cleanup();
    }
  });

  it('dispatch_status(run_…) still resolves real agent_runs, and names legacy notes precisely', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rtn-status-' });
    try {
      seedAssignment(ws, 'asgn_hard1', {});
      const run = createAgentRun({
        assignment_id: 'asgn_hard1', claim_id: 'clm_hard', agent: 'claude-code',
        transport: 'cli_spawn', scope: 'hardening-scope', description: 'run resolution regression',
      }, ws.dir);
      const status = getDispatchStatus({ target_id: run.id, cwd: ws.dir });
      assert.equal(status.resolved_from, 'run_id');
      assert.equal(status.entities.run_id, run.id);

      saveRuntimeNote({
        id: 'run_6c79ccbe', agent: 'tester', text: 'note that collided with run ids',
        created_at: nowISO(), tags: [], visibility: 'shared', note_type: 'observation',
      }, ws.dir);
      const legacy = getDispatchStatus({ target_id: 'run_6c79ccbe', cwd: ws.dir });
      assert.equal(legacy.resolved_from, 'unresolved');
      assert.match(legacy.diagnosis.summary, /runtime_note/);
    } finally {
      ws.cleanup();
    }
  });
});

// ── can_c39f0961: OEM log decoding ──────────────────────────────────────────

describe('decodeOemAwareBuffer (can_c39f0961)', () => {
  it('decodes cp850 OEM output from Windows-native tools', () => {
    // "opération terminée" in cp850: é = 0x82
    const cp850 = Buffer.from([
      0x6f, 0x70, 0x82, 0x72, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x20,
      0x74, 0x65, 0x72, 0x6d, 0x69, 0x6e, 0x82, 0x65,
    ]);
    assert.equal(decodeOemAwareBuffer(cp850), 'opération terminée');
  });

  it('leaves valid UTF-8 untouched', () => {
    const utf8 = Buffer.from('opération terminée — déjà vu ✓', 'utf-8');
    assert.equal(decodeOemAwareBuffer(utf8), 'opération terminée — déjà vu ✓');
  });
});

// ── can_45316d5c: branch component sanitization ─────────────────────────────

describe('sanitizeBranchComponent (can_45316d5c)', () => {
  it('strips leading dots so .github scopes produce valid refs', () => {
    const slug = sanitizeBranchComponent('.github/workflows');
    assert.ok(!slug.startsWith('.'), `no leading dot: ${slug}`);
    assert.ok(!slug.startsWith('-'), 'no leading dash');
    assert.equal(slug, 'github-workflows');
  });

  it('removes characters git check-ref-format forbids', () => {
    const slug = sanitizeBranchComponent('a b~c^d:e?f*g[h]\\i..j@{k}.lock');
    assert.ok(!/[\s~^:?*[\]\\]/.test(slug));
    assert.ok(!slug.includes('..'));
    assert.ok(!slug.includes('@{'));
    assert.ok(!slug.endsWith('.lock'));
    assert.ok(!slug.endsWith('.'));
  });

  it('falls back when the scope sanitizes to nothing', () => {
    assert.equal(sanitizeBranchComponent('...'), 'scope');
  });
});

// ── can_2e282880: worktree-as-contract at creation ──────────────────────────

describe('createWorktree branch reuse (can_2e282880)', () => {
  let ws: TestWorkspace;
  const createdWts: string[] = [];
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-wt-reuse-' }); gitInit(ws.dir); });
  afterEach(() => {
    for (const wt of createdWts.splice(0)) {
      try { git(ws.dir, 'worktree', 'remove', '--force', wt); } catch { /* */ }
      fs.rmSync(wt, { recursive: true, force: true });
    }
    ws.cleanup();
  });

  it('re-points a stale, non-diverged branch to the dispatch base (no April-base reuse)', () => {
    const staleBase = git(ws.dir, 'rev-parse', 'HEAD').stdout;
    git(ws.dir, 'branch', 'feat/stale-lane', staleBase);
    // advance master so the stale branch is BEHIND
    fs.writeFileSync(path.join(ws.dir, 'newer.txt'), 'newer\n');
    git(ws.dir, 'add', 'newer.txt');
    git(ws.dir, 'commit', '-q', '-m', 'advance master');
    const newHead = git(ws.dir, 'rev-parse', 'HEAD').stdout;

    const wt = createWorktree(ws.dir, 'feat/stale-lane');
    createdWts.push(wt);
    assert.equal(git(wt, 'rev-parse', 'HEAD').stdout, newHead, 'reused branch reset to current base');
  });

  it('REFUSES to reuse a branch carrying unharvested commits, and names them', () => {
    git(ws.dir, 'checkout', '-q', '-b', 'feat/diverged-lane');
    fs.writeFileSync(path.join(ws.dir, 'unharvested.txt'), 'work\n');
    git(ws.dir, 'add', 'unharvested.txt');
    git(ws.dir, 'commit', '-q', '-m', 'unharvested worker commit');
    git(ws.dir, 'checkout', '-q', '-');

    assert.throws(
      () => createWorktree(ws.dir, 'feat/diverged-lane'),
      /unharvested|commit\(s\) not on/,
    );
  });
});

// ── can_948acfd6: acceptance-TTL implicit evidence + late convergence ───────

describe('sweepAssignments implicit evidence (can_948acfd6)', () => {
  let ws: TestWorkspace;
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-sweep-' }); });
  afterEach(() => { ws.cleanup(); });

  const MIN = 60_000;

  it('offered past TTL + ack sentinel → implicit accepted, not expired', () => {
    const offeredAt = new Date(Date.now() - 20 * MIN).toISOString();
    seedAssignment(ws, 'asgn_ack', { status: 'offered', offered_at: offeredAt });
    const ackPath = getRuntimeSignalPath(ws.dir, 'asgn_ack', 'ack');
    fs.mkdirSync(path.dirname(ackPath), { recursive: true });
    fs.writeFileSync(ackPath, '');

    const result = sweepAssignments(ws.dir);
    assert.equal(result.expired.length, 0, 'must not expire a worker that acked');
    assert.equal(result.implicitly_advanced.length, 1);
    assert.equal(result.implicitly_advanced[0].to, 'accepted');
    assert.equal(loadAssignment('asgn_ack', ws.dir)?.status, 'accepted');
  });

  it('offered past TTL + worktree heartbeat → implicit accepted', () => {
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hb-wt-'));
    try {
      const offeredAt = new Date(Date.now() - 20 * MIN).toISOString();
      seedAssignment(ws, 'asgn_hb', { status: 'offered', offered_at: offeredAt, worktree_path: wtDir });
      fs.writeFileSync(getWorktreeHeartbeatPath(wtDir, 'asgn_hb'), 'work_loop_reached asgn_hb');

      const result = sweepAssignments(ws.dir);
      assert.equal(result.expired.length, 0);
      assert.equal(loadAssignment('asgn_hb', ws.dir)?.status, 'accepted');
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
    }
  });

  it('offered past TTL with NO evidence → expired (existing behavior preserved)', () => {
    const offeredAt = new Date(Date.now() - 20 * MIN).toISOString();
    seedAssignment(ws, 'asgn_dead', { status: 'offered', offered_at: offeredAt });

    const result = sweepAssignments(ws.dir);
    assert.equal(result.expired.length, 1);
    assert.equal(loadAssignment('asgn_dead', ws.dir)?.status, 'expired');
  });

  it('started with stale MCP heartbeat but FRESH file heartbeat → not timed out', () => {
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hb-started-'));
    try {
      const past = new Date(Date.now() - 45 * MIN).toISOString();
      seedAssignment(ws, 'asgn_busy', {
        status: 'started', started_at: past, last_heartbeat_at: past, worktree_path: wtDir,
      });
      fs.writeFileSync(getWorktreeHeartbeatPath(wtDir, 'asgn_busy'), 'work_loop_reached asgn_busy');

      const result = sweepAssignments(ws.dir);
      assert.equal(result.timed_out.length, 0, 'fresh file heartbeat vetoes the administrative timeout');
      assert.equal(loadAssignment('asgn_busy', ws.dir)?.status, 'started');
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
    }
  });

  it('readHeartbeat prefers the freshest of project-root and worktree heartbeats', () => {
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hb-both-'));
    try {
      const projectPath = getRuntimeSignalPath(ws.dir, 'asgn_both', 'heartbeat');
      fs.mkdirSync(path.dirname(projectPath), { recursive: true });
      fs.writeFileSync(projectPath, '');
      const old = Date.now() - 60 * MIN;
      fs.utimesSync(projectPath, new Date(old), new Date(old));
      fs.writeFileSync(getWorktreeHeartbeatPath(wtDir, 'asgn_both'), '');

      const hb = readHeartbeat(ws.dir, 'asgn_both', wtDir);
      assert.ok(hb.exists);
      assert.ok(Date.now() - (hb.mtimeMs ?? 0) < 5 * MIN, 'freshest (worktree) mtime wins');
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
    }
  });
});

describe('expired→completed late convergence (can_948acfd6)', () => {
  it('FSM allows expired→completed and nothing else out of expired', () => {
    assert.equal(validateTransition('expired', 'completed').valid, true);
    assert.equal(validateTransition('expired', 'started').valid, false);
    assert.equal(validateTransition('expired', 'rerouted').valid, false);
  });

  it('harvest --integrate converges an EXPIRED assignment whose LANE-RESULT arrived late', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-late-' });
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-late-wt-'));
    try {
      seedClaim(ws, 'clm_late', { worktree_path: wtDir });
      seedAssignment(ws, 'asgn_late', {
        status: 'expired', expired_at: nowISO(), claim_id: 'clm_late',
        agent: 'claude-code', worktree_path: wtDir,
      });
      fs.writeFileSync(getLaneResultPath(wtDir), JSON.stringify({
        assignment_id: 'asgn_late', status: 'completed',
        summary: 'work finished before the administrative expiry', files_changed: ['src/x.ts'],
      }));

      // No explicit worktreePaths: resolution must come from assignment/claim
      // worktree_path (the asgn_ab11b801 fix), not the auto-detected pool.
      const result = integrateLaneResults({ assignmentId: 'asgn_late', cwd: ws.dir });
      assert.equal(result.errors.length, 0, `errors: ${result.errors.join('; ')}`);
      assert.equal(result.integrated.length, 1);
      assert.equal(result.integrated[0].assignment_completed, true, 'expired assignment converged to completed');
      assert.equal(loadAssignment('asgn_late', ws.dir)?.status, 'completed');
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
      ws.cleanup();
    }
  });
});

// ── L2: hook recognition (lop_e2d566765b8b4ce3) ─────────────────────────────

describe('isBrainclawHookCommand (review follow-up L2)', () => {
  const { isBrainclawHookCommand } = __agentFilesTesting;

  it('matches brainclaw/bclaw invoked as a command', () => {
    assert.equal(isBrainclawHookCommand('npx brainclaw session-start'), true);
    assert.equal(isBrainclawHookCommand('/usr/local/bin/brainclaw context-diff'), true);
    assert.equal(isBrainclawHookCommand('C:\\Users\\x\\AppData\\Roaming\\npm\\bclaw.cmd check-events'), true);
    assert.equal(isBrainclawHookCommand('bclaw session-end --auto-release'), true);
    assert.equal(isBrainclawHookCommand('f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; fi'), true);
    assert.equal(isBrainclawHookCommand('node.exe check-events 2>/dev/null'), true);
  });

  it('preserves user hooks that merely MENTION the words', () => {
    assert.equal(isBrainclawHookCommand('echo "remember to read the bclawsomething docs"'), false);
    assert.equal(isBrainclawHookCommand('./scripts/my-bclaw-helper.sh'), false);
    assert.equal(isBrainclawHookCommand('echo check-events-disabled'), false);
    assert.equal(isBrainclawHookCommand('grep brainclawish notes.md'), false);
  });
});
