import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../../src/core/config.js';
import { latestCascadeRefreshJob, readCascadeRefreshJob, summarizeCascadeRefreshJob, type CascadeRefreshJob } from '../../../src/core/code-map/cascade-jobs.js';
import type { CascadeProjectResult } from '../../../src/core/code-map/cascade.js';
import { executeMcpToolCall } from '../../../src/commands/mcp.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function store(dir: string, name: string, multi = false): void {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, { projectId: `prj_${name}`, ...(multi ? { projectMode: 'multi-project', projectStrategy: 'folder' } : {}) }), dir);
}

async function waitForTerminal(root: string, jobId: string): Promise<CascadeRefreshJob> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const job = readCascadeRefreshJob(root, jobId);
    if (job?.status === 'completed' || job?.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`cascade job ${jobId} did not finish: ${JSON.stringify(readCascadeRefreshJob(root, jobId))}`);
}

async function waitForExit(pid: number | undefined): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('durable Code Map cascade jobs (CM-3/5/6)', () => {
  it('returns immediately, persists progress, and completes outside the MCP request lifetime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cascade-job-'));
    cleanup.push(root);
    store(root, 'workspace', true);
    const child = path.join(root, 'apps', 'api');
    store(child, 'api');
    fs.mkdirSync(path.join(child, 'src'), { recursive: true });
    fs.writeFileSync(path.join(child, 'src', 'api.ts'), 'export function durableCascade() { return 1; }\n');

    const startedAt = Date.now();
    const outcome = await executeMcpToolCall({
      name: 'bclaw_code_refresh', args: { scope: 'all', cascade: true }, cwd: root,
    });
    const started = outcome.response.structuredContent as unknown as CascadeRefreshJob & { started: boolean; next_actions: unknown[] };
    assert.equal(started.started, true);
    // Process startup and project discovery can be slower on a loaded Windows
    // runner. The contract is that MCP does not await the full cascade (whose
    // timeout is measured in minutes), not that admission always beats 2 s.
    assert.ok(Date.now() - startedAt < 10_000, 'admission returns promptly without awaiting the full cascade');
    assert.equal(started.projects_total, 2);
    assert.ok(started.next_actions.length > 0);

    const terminal = await waitForTerminal(root, started.job_id);
    assert.equal(terminal.status, 'completed', terminal.error ?? 'cascade job failed');
    assert.equal(terminal.projects_completed, 2);
    assert.equal(terminal.result?.children[0]?.outcome, 'indexed');
    assert.equal(latestCascadeRefreshJob(root)?.job_id, started.job_id);
    await waitForExit(terminal.pid);
  });

  it('keeps a 52-project status payload compact and only names actionable exceptions', () => {
    const indexed = (i: number): CascadeProjectResult => ({
      path: `project-${i}`, project_id: `prj_${i}`, is_root: i === 0, ran: true,
      lock_acquired: true, files_parsed: 1, files_compacted: 0, files_indexed: 1,
      freshness: 'fresh', outcome: 'indexed',
    });
    const projects = Array.from({ length: 52 }, (_, i) => indexed(i));
    projects[17] = { ...projects[17]!, files_indexed: 0, outcome: 'no_eligible_files', reason: 'no eligible source files found' };
    const job: CascadeRefreshJob = {
      job_id: 'cmj_scale', root: '/workspace', scope: 'all', status: 'completed',
      created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:01:00.000Z',
      projects_total: 52, projects_completed: 52, current_project: null,
      result: { is_cascade: true, root: '/workspace', root_result: projects[0]!, children: projects.slice(1), children_refreshed: 51, discovery_truncated: false },
    };
    const summary = summarizeCascadeRefreshJob(job);
    assert.equal('result' in summary, false, 'full per-project success rows are not echoed by status');
    assert.deepEqual(summary.outcome_counts, { indexed: 51, no_eligible_files: 1 });
    assert.deepEqual(summary.problem_projects?.map((p) => p.path), ['project-17']);
    assert.ok(JSON.stringify(summary).length < 1_500);
  });
});
