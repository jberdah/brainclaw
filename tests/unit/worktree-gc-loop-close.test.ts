import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAssignment, saveAssignment, loadAssignment } from '../../src/core/assignments.js';
import { openLoop, closeLoop } from '../../src/core/loops/store.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * pln#594 — closing a review/dispatch loop should garbage-collect its sub-agent
 * worktrees (completed only), via the closeLoop cascade. Wires a real git
 * worktree to a loop slot's assignment and asserts the end-to-end behaviour.
 */
let ws: TestWorkspace;
const extraCleanup: string[] = [];
beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-gcloop-', projectId: 'prj_gcloop', currentAgent: 'tester' }); });
afterEach(() => {
  while (extraCleanup.length > 0) fs.rmSync(extraCleanup.pop() as string, { recursive: true, force: true });
  ws.cleanup();
});

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

/** Make ws.dir a git repo with one commit, and add a clean linked worktree. */
function addWorktree(branch: string): string {
  git(['init', '-b', 'master'], ws.dir);
  git(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'init'], ws.dir);
  const wt = path.join(ws.dir, '..', `${path.basename(ws.dir)}-${branch.replace(/\//g, '_')}`);
  extraCleanup.push(wt);
  git(['worktree', 'add', '-b', branch, wt, 'HEAD'], ws.dir);
  return wt;
}

function loopWithWorktreeAssignment(branch: string): { loopId: string; wt: string; asgnId: string } {
  const wt = addWorktree(branch);
  const a = createAssignment({
    claim_id: 'clm_gc', agent: 'codex', dispatcher_agent: 'bclaw_coordinate',
    scope: 'review-loop:placeholder', description: 'review', worktree_path: wt,
  }, ws.dir);
  a.status = 'started';
  saveAssignment(a, ws.dir);
  const loop = openLoop({
    kind: 'review', title: 'r', created_by: 'bclaw_coordinate', mode: 'symmetric',
    slots: [{ role: 'reviewer', agent: 'codex', assignment_id: a.id, status: 'assigned' }],
  }, ws.dir);
  return { loopId: loop.id, wt, asgnId: a.id };
}

describe('worktree GC on loop close (pln#594)', () => {
  it('completed close removes the clean sub-agent worktree', () => {
    const { loopId, wt, asgnId } = loopWithWorktreeAssignment('lane/done');
    assert.equal(fs.existsSync(wt), true, 'worktree exists before close');
    closeLoop({ id: loopId, final_status: 'completed', reason: 'lgtm', actor: 'tester' }, ws.dir);
    assert.equal(loadAssignment(asgnId, ws.dir)!.status, 'completed');
    assert.equal(fs.existsSync(wt), false, 'worktree GC-ed on completed close');
  });

  it('cancelled close keeps the worktree (forensics)', () => {
    const { loopId, wt } = loopWithWorktreeAssignment('lane/abandon');
    closeLoop({ id: loopId, final_status: 'cancelled', reason: 'abandoned', actor: 'tester' }, ws.dir);
    assert.equal(fs.existsSync(wt), true, 'cancelled close preserves the worktree');
  });

  it('completed close keeps a worktree with un-harvested edits', () => {
    const { loopId, wt } = loopWithWorktreeAssignment('lane/dirty');
    fs.writeFileSync(path.join(wt, 'work.txt'), 'uncommitted\n');
    closeLoop({ id: loopId, final_status: 'completed', reason: 'lgtm', actor: 'tester' }, ws.dir);
    assert.equal(fs.existsSync(wt), true, 'un-harvested work is not destroyed');
  });

  it('respects BRAINCLAW_NO_WORKTREE_GC=1 (opt out)', () => {
    const prev = process.env.BRAINCLAW_NO_WORKTREE_GC;
    process.env.BRAINCLAW_NO_WORKTREE_GC = '1';
    try {
      const { loopId, wt } = loopWithWorktreeAssignment('lane/optout');
      closeLoop({ id: loopId, final_status: 'completed', reason: 'lgtm', actor: 'tester' }, ws.dir);
      assert.equal(fs.existsSync(wt), true, 'GC disabled → worktree kept');
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_NO_WORKTREE_GC; else process.env.BRAINCLAW_NO_WORKTREE_GC = prev;
    }
  });
});
