import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { LaneResultSchema } from '../../src/core/schema.js';
import { harvestLaneResults, getLaneResultPath } from '../../src/commands/harvest.js';
import { acquireClaimScope } from '../../src/core/claims.js';
import { createAssignment } from '../../src/core/assignments.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace } from '../helpers/workspace.js';
import { setAgentTrustLevel } from '../../src/core/agent-registry.js';

// pln#526 — LANE-RESULT convention: a worker writes LANE-RESULT.json at its
// worktree root; `brainclaw harvest <assignment_id>` ingests it.

function writeLane(worktree: string, lane: unknown): void {
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(getLaneResultPath(worktree), JSON.stringify(lane), 'utf-8');
}

function markerPath(cwd: string, assignmentId: string): string {
  return path.join(cwd, '.brainclaw', 'coordination', 'runtime', 'result', `${assignmentId}.harvested`);
}

describe('LaneResultSchema (pln#526)', () => {
  it('parses a valid lane result', () => {
    const r = LaneResultSchema.parse({
      assignment_id: 'asgn_1', status: 'completed', summary: 'did the thing', files_changed: ['a.ts'],
    });
    assert.equal(r.assignment_id, 'asgn_1');
    assert.equal(r.status, 'completed');
  });

  it('rejects an invalid status', () => {
    assert.throws(() => LaneResultSchema.parse({ assignment_id: 'asgn_1', status: 'done', summary: 'x' }));
  });

  it('requires assignment_id and summary', () => {
    assert.throws(() => LaneResultSchema.parse({ status: 'completed' }));
  });

  it('accepts both legacy string refs and structured artifact objects', () => {
    const parsed = LaneResultSchema.parse({
      assignment_id: 'asgn_objects', status: 'completed', summary: 'done',
      artifacts: ['art_legacy', { type: 'file', ref: 'CRITIQUE.md', description: 'full critique' }],
    });
    assert.equal(parsed.artifacts?.length, 2);
    assert.deepEqual(parsed.artifacts?.[1], { type: 'file', ref: 'CRITIQUE.md', description: 'full critique' });
  });
});

describe('bclaw_harvest MCP parity', () => {
  it('harvests lane results through MCP and remains idempotent', async () => {
    const workspace = createTestWorkspace({ currentAgent: 'claude-code' });
    setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mcp-lane-wt-'));
    writeLane(wt, { assignment_id: 'asgn_mcp', status: 'completed', summary: 'via MCP' });
    try {
      const first = await executeMcpToolCall({
        name: 'bclaw_harvest',
        args: { assignmentId: 'asgn_mcp', worktreePaths: [wt], agent: workspace.currentAgent.agent_name, agentId: workspace.currentAgent.agent_id },
        cwd: workspace.dir,
      });
      assert.equal(first.response.isError, false);
      const firstPayload = first.response.structuredContent as { harvested: unknown[]; errors: string[] };
      assert.equal(firstPayload.harvested.length, 1);
      assert.deepEqual(firstPayload.errors, []);

      const second = await executeMcpToolCall({
        name: 'bclaw_harvest',
        args: { assignmentId: 'asgn_mcp', worktreePaths: [wt], agent: workspace.currentAgent.agent_name, agentId: workspace.currentAgent.agent_id },
        cwd: workspace.dir,
      });
      const secondPayload = second.response.structuredContent as { harvested: unknown[]; skipped: string[] };
      assert.equal(secondPayload.harvested.length, 0);
      assert.deepEqual(secondPayload.skipped, ['asgn_mcp']);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      workspace.cleanup();
    }
  });
});

describe('harvestLaneResults (pln#526)', () => {
  it('finds and returns a lane result without writing a marker on dry-run', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-wt-'));
    writeLane(wt, { assignment_id: 'asgn_a', status: 'completed', summary: 's' });
    try {
      const res = harvestLaneResults({ worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.harvested.length, 1);
      assert.equal(res.harvested[0].assignment_id, 'asgn_a');
      assert.equal(fs.existsSync(markerPath(cwd, 'asgn_a')), false, 'dry-run writes no marker');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('ingests, writes a marker, and skips on re-run (idempotent)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-wt-'));
    writeLane(wt, { assignment_id: 'asgn_b', status: 'completed', summary: 'shipped', files_changed: ['x.ts'] });
    try {
      const first = harvestLaneResults({ worktreePaths: [wt], cwd });
      assert.equal(first.harvested.length, 1);
      assert.equal(fs.existsSync(markerPath(cwd, 'asgn_b')), true, 'marker written after ingest');
      assert.notEqual(fs.readFileSync(markerPath(cwd, 'asgn_b'), 'utf-8'), new Date(0).toISOString());

      const second = harvestLaneResults({ worktreePaths: [wt], cwd });
      assert.equal(second.harvested.length, 0);
      assert.deepEqual(second.skipped, ['asgn_b']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('filters to a specific assignment id', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wtX = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-x-'));
    const wtY = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-y-'));
    writeLane(wtX, { assignment_id: 'asgn_x', status: 'completed', summary: 'x' });
    writeLane(wtY, { assignment_id: 'asgn_y', status: 'blocked', summary: 'y' });
    try {
      const res = harvestLaneResults({ assignmentId: 'asgn_x', worktreePaths: [wtX, wtY], dryRun: true, cwd });
      assert.equal(res.harvested.length, 1);
      assert.equal(res.harvested[0].assignment_id, 'asgn_x');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wtX, { recursive: true, force: true });
      fs.rmSync(wtY, { recursive: true, force: true });
    }
  });

  it('recovers one schema-valid result written under the wrong root filename', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-renamed-'));
    fs.writeFileSync(path.join(wt, 'critique-result.json'), JSON.stringify({
      assignment_id: 'asgn_renamed', status: 'completed', summary: 'valid result, wrong filename',
    }), 'utf-8');
    try {
      const res = harvestLaneResults({ assignmentId: 'asgn_renamed', worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.errors.length, 0);
      assert.equal(res.harvested[0]?.assignment_id, 'asgn_renamed');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('refuses to guess when two renamed result files match the same assignment', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-ambiguous-'));
    const lane = { assignment_id: 'asgn_ambiguous', status: 'completed', summary: 'duplicate result' };
    fs.writeFileSync(path.join(wt, 'critique.json'), JSON.stringify(lane), 'utf-8');
    fs.writeFileSync(path.join(wt, 'result.json'), JSON.stringify(lane), 'utf-8');
    try {
      const res = harvestLaneResults({ assignmentId: 'asgn_ambiguous', worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.harvested.length, 0);
      assert.match(res.errors[0] ?? '', /Ambiguous lane-result files/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('pln#636 C2 — raises a scope advisory from the lane\'s own files_changed', () => {
    // The trigger that reaches the tier C1's hook cannot: a sandboxed worker that
    // never saw MCP and reported through a file. Its `files_changed` declaration
    // is the footprint — no git diff is attempted, because by harvest time the
    // worktree may already have been reaped.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-conf-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-conf-wt-'));
    fs.mkdirSync(path.join(cwd, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    try {
      const claim = acquireClaimScope(
        { scope: 'src/core', agent: 'codex', description: 'core work' },
        cwd,
      ).claim!;
      const assignment = createAssignment({
        claim_id: claim.id,
        agent: 'codex',
        dispatcher_agent: 'coordinator',
        scope: 'src/core',
        description: 'core work',
        worktree_path: wt,
      }, cwd);
      writeLane(wt, {
        assignment_id: assignment.id,
        status: 'completed',
        summary: 'done',
        files_changed: ['src/core/a.ts', 'docs/stray.md'],
      });

      const res = harvestLaneResults({ worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.harvested.length, 1);
      assert.equal(res.warnings.length, 1, `expected one advisory, got ${JSON.stringify(res.warnings)}`);
      assert.equal(res.warnings[0].code, 'wrote_outside_claim_scope');
      assert.deepEqual(res.warnings[0].data?.unexpected_paths, ['docs/stray.md']);
      assert.ok(res.warnings[0].next_actions?.length, 'the advisory must carry a recovery path');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('pln#636 C2 — stays silent when the lane reported only in-scope files', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-conf2-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-conf2-wt-'));
    fs.mkdirSync(path.join(cwd, 'src', 'core'), { recursive: true });
    try {
      const claim = acquireClaimScope(
        { scope: 'src/core', agent: 'codex', description: 'core work' },
        cwd,
      ).claim!;
      const assignment = createAssignment({
        claim_id: claim.id,
        agent: 'codex',
        dispatcher_agent: 'coordinator',
        scope: 'src/core',
        description: 'core work',
        worktree_path: wt,
      }, cwd);
      writeLane(wt, {
        assignment_id: assignment.id,
        status: 'completed',
        summary: 'done',
        files_changed: ['src/core/a.ts', 'src/core/nested/b.ts'],
      });

      const res = harvestLaneResults({ worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.harvested.length, 1);
      assert.deepEqual(res.warnings, [], 'in-scope work must emit nothing');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('records a parse error for malformed LANE-RESULT.json', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-bad-'));
    fs.writeFileSync(getLaneResultPath(wt), '{ not valid json', 'utf-8');
    try {
      const res = harvestLaneResults({ worktreePaths: [wt], dryRun: true, cwd });
      assert.equal(res.harvested.length, 0);
      assert.equal(res.errors.length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it('returns empty when no LANE-RESULT.json exists', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-cwd-'));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-empty-'));
    try {
      const res = harvestLaneResults({ worktreePaths: [wt], dryRun: true, cwd });
      // `warnings` is the pln#636 C2 conformity channel — always present, empty
      // when nothing was ingested.
      assert.deepEqual(res, { harvested: [], skipped: [], errors: [], warnings: [], continuations: [] });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
