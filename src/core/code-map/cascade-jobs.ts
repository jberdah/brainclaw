import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';
import { writeFileAtomic } from '../io.js';
import { codeMapDir } from './paths.js';
import { inspectNestedProjects, refreshWorkspaceCascade, type CascadeProjectResult, type CascadeResult } from './cascade.js';

export type CascadeJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface CascadeRefreshJob {
  job_id: string;
  root: string;
  scope: 'changed' | 'all';
  status: CascadeJobStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  pid?: number;
  projects_total: number;
  projects_completed: number;
  current_project: string | null;
  last_result?: CascadeProjectResult;
  result?: CascadeResult;
  error?: string;
}

export interface CascadeRefreshJobSummary extends Omit<CascadeRefreshJob, 'result'> {
  outcome_counts?: Record<string, number>;
  problem_projects?: Array<{ path: string; outcome: CascadeProjectResult['outcome']; reason?: string; error?: string }>;
}

export function summarizeCascadeRefreshJob(job: CascadeRefreshJob): CascadeRefreshJobSummary {
  const { result, ...summary } = job;
  if (!result) return summary;
  const projects = [result.root_result, ...result.children];
  const outcomeCounts: Record<string, number> = {};
  for (const project of projects) outcomeCounts[project.outcome] = (outcomeCounts[project.outcome] ?? 0) + 1;
  const problemProjects = projects
    .filter((project) => project.outcome !== 'indexed')
    .map((project) => ({ path: project.path, outcome: project.outcome, ...(project.reason ? { reason: project.reason } : {}), ...(project.error ? { error: project.error } : {}) }));
  return { ...summary, outcome_counts: outcomeCounts, ...(problemProjects.length ? { problem_projects: problemProjects } : {}) };
}

function jobsDir(root: string): string {
  return path.join(codeMapDir(root), 'cascade-jobs');
}

function jobPath(root: string, jobId: string): string {
  return path.join(jobsDir(root), `${jobId}.json`);
}

function writeJob(job: CascadeRefreshJob): void {
  const dir = jobsDir(job.root);
  fs.mkdirSync(dir, { recursive: true });
  const target = jobPath(job.root, job.job_id);
  writeFileAtomic(target, `${JSON.stringify(job, null, 2)}\n`);
}

export function readCascadeRefreshJob(root: string, jobId: string): CascadeRefreshJob | null {
  try {
    return JSON.parse(fs.readFileSync(jobPath(path.resolve(root), jobId), 'utf8')) as CascadeRefreshJob;
  } catch {
    return null;
  }
}

export function latestCascadeRefreshJob(root: string): CascadeRefreshJob | null {
  const dir = jobsDir(path.resolve(root));
  try {
    const jobs = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as CascadeRefreshJob; }
        catch { return null; }
      })
      .filter((job): job is CascadeRefreshJob => job !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return jobs[0] ?? null;
  } catch {
    return null;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function startCascadeRefreshJob(root: string, scope: 'changed' | 'all'): CascadeRefreshJob | null {
  const resolvedRoot = path.resolve(root);
  try {
    if (loadConfig(resolvedRoot).project_mode !== 'multi-project') return null;
  } catch {
    return null;
  }

  const previous = latestCascadeRefreshJob(resolvedRoot);
  if (previous && (previous.status === 'queued' || previous.status === 'running') && processAlive(previous.pid)) {
    return previous;
  }

  const now = new Date().toISOString();
  const job: CascadeRefreshJob = {
    job_id: `cmj_${crypto.randomBytes(8).toString('hex')}`,
    root: resolvedRoot,
    scope,
    status: 'queued',
    created_at: now,
    updated_at: now,
    projects_total: inspectNestedProjects(resolvedRoot).projects.length + 1,
    projects_completed: 0,
    current_project: null,
  };
  writeJob(job);

  const worker = fileURLToPath(new URL('./cascade-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, resolvedRoot, job.job_id, scope], {
    cwd: resolvedRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const markWorkerExit = (detail: string): void => {
    const current = readCascadeRefreshJob(resolvedRoot, job.job_id);
    if (!current || current.status === 'completed' || current.status === 'failed') return;
    const completed = new Date().toISOString();
    writeJob({
      ...current,
      status: 'failed',
      error: detail,
      current_project: null,
      completed_at: completed,
      updated_at: completed,
    });
  };
  child.once('error', (error) => {
    markWorkerExit(`cascade worker failed to start: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    // The worker writes its terminal state synchronously before exiting. If no
    // terminal state exists here, the launch/runtime failed outside its guard.
    markWorkerExit(`cascade worker exited before completion (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
  });
  child.unref();
  const current = readCascadeRefreshJob(resolvedRoot, job.job_id) ?? job;
  if (current.status === 'queued') {
    current.pid = child.pid;
    current.updated_at = new Date().toISOString();
    writeJob(current);
  }
  return current;
}

/** Worker entry seam, exported for deterministic tests and the tiny worker file. */
export async function runCascadeRefreshJob(root: string, jobId: string, scope: 'changed' | 'all'): Promise<void> {
  const job = readCascadeRefreshJob(root, jobId);
  if (!job) throw new Error(`cascade job not found: ${jobId}`);
  const started = new Date().toISOString();
  writeJob({ ...job, status: 'running', pid: process.pid, started_at: started, updated_at: started });
  try {
    const result = await refreshWorkspaceCascade({
      rootCwd: root,
      scope,
      onProgress: (progress) => {
        const current = readCascadeRefreshJob(root, jobId) ?? job;
        writeJob({
          ...current,
          status: 'running',
          pid: process.pid,
          projects_total: progress.total,
          projects_completed: progress.completed,
          current_project: progress.current_project,
          ...(progress.last_result ? { last_result: progress.last_result } : {}),
          updated_at: new Date().toISOString(),
        });
      },
    });
    const current = readCascadeRefreshJob(root, jobId) ?? job;
    const completed = new Date().toISOString();
    writeJob({ ...current, status: 'completed', result, current_project: null, projects_completed: current.projects_total, completed_at: completed, updated_at: completed });
  } catch (error) {
    const current = readCascadeRefreshJob(root, jobId) ?? job;
    const completed = new Date().toISOString();
    writeJob({ ...current, status: 'failed', error: error instanceof Error ? error.message : String(error), current_project: null, completed_at: completed, updated_at: completed });
  }
}
