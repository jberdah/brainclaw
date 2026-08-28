import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeFileAtomic } from '../io.js';
import { codeMapDir } from './paths.js';
import type { CodeRefreshResult } from './backend.js';

export type CodeRefreshJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface CodeRefreshJob {
  job_id: string;
  root: string;
  scope: 'changed' | 'all';
  status: CodeRefreshJobStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  pid?: number;
  result?: CodeRefreshResult;
  error?: string;
}

export type CodeRefreshJobSummary = Omit<CodeRefreshJob, 'result'> & {
  result?: Pick<CodeRefreshResult, 'ran' | 'scope' | 'lock_acquired' | 'lock_status' | 'freshness_badge'>;
};

function jobsDir(root: string): string {
  return path.join(codeMapDir(root), 'refresh-jobs');
}

function jobPath(root: string, jobId: string): string {
  return path.join(jobsDir(root), `${jobId}.json`);
}

function writeJob(job: CodeRefreshJob): void {
  fs.mkdirSync(jobsDir(job.root), { recursive: true });
  writeFileAtomic(jobPath(job.root, job.job_id), `${JSON.stringify(job, null, 2)}\n`);
}

export function readCodeRefreshJob(root: string, jobId: string): CodeRefreshJob | null {
  try {
    return JSON.parse(fs.readFileSync(jobPath(path.resolve(root), jobId), 'utf8')) as CodeRefreshJob;
  } catch {
    return null;
  }
}

export function latestCodeRefreshJob(root: string): CodeRefreshJob | null {
  try {
    return fs.readdirSync(jobsDir(path.resolve(root)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(jobsDir(path.resolve(root)), name), 'utf8')) as CodeRefreshJob;
        } catch {
          return null;
        }
      })
      .filter((job): job is CodeRefreshJob => job !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  } catch {
    return null;
  }
}

export function summarizeCodeRefreshJob(job: CodeRefreshJob): CodeRefreshJobSummary {
  return {
    ...job,
    ...(job.result
      ? {
        result: {
          ran: job.result.ran,
          scope: job.result.scope,
          lock_acquired: job.result.lock_acquired,
          ...(job.result.lock_status ? { lock_status: job.result.lock_status } : {}),
          freshness_badge: job.result.freshness_badge,
        },
      }
      : {}),
  };
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start a detached, durable refresh and return before parsing begins. */
export function startCodeRefreshJob(root: string, scope: 'changed' | 'all'): CodeRefreshJob {
  const resolvedRoot = path.resolve(root);
  const previous = latestCodeRefreshJob(resolvedRoot);
  if (previous && (previous.status === 'queued' || previous.status === 'running') && processAlive(previous.pid)) {
    return previous;
  }

  const now = new Date().toISOString();
  const job: CodeRefreshJob = {
    job_id: `cmj_${crypto.randomBytes(8).toString('hex')}`,
    root: resolvedRoot,
    scope,
    status: 'queued',
    created_at: now,
    updated_at: now,
  };
  writeJob(job);

  const worker = fileURLToPath(new URL('./refresh-worker.js', import.meta.url));
  if (!fs.existsSync(worker)) {
    const failed = {
      ...job,
      status: 'failed' as const,
      error: `code refresh worker is missing: ${worker}`,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeJob(failed);
    return failed;
  }
  const child = spawn(process.execPath, [worker, resolvedRoot, job.job_id, scope], {
    cwd: resolvedRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => {
    const current = readCodeRefreshJob(resolvedRoot, job.job_id) ?? job;
    if (current.status === 'completed' || current.status === 'failed') return;
    const completed = new Date().toISOString();
    writeJob({
      ...current,
      status: 'failed',
      error: `code refresh worker failed to start: ${error.message}`,
      completed_at: completed,
      updated_at: completed,
    });
  });
  child.unref();
  const queued = readCodeRefreshJob(resolvedRoot, job.job_id) ?? job;
  queued.pid = child.pid;
  queued.updated_at = new Date().toISOString();
  writeJob(queued);
  return queued;
}

/** Worker seam exported for deterministic tests. */
export async function runCodeRefreshJob(root: string, jobId: string, scope: 'changed' | 'all'): Promise<void> {
  const job = readCodeRefreshJob(root, jobId);
  if (!job) throw new Error(`code refresh job not found: ${jobId}`);
  const started = new Date().toISOString();
  writeJob({ ...job, status: 'running', pid: process.pid, started_at: started, updated_at: started });
  try {
    // Dynamic import avoids coupling the query backend's status path to worker startup.
    const { JsonlBackend } = await import('./backend.js');
    const result = await new JsonlBackend().refresh({ cwd: root, scope });
    const completed = new Date().toISOString();
    writeJob({
      ...(readCodeRefreshJob(root, jobId) ?? job),
      status: 'completed',
      result,
      completed_at: completed,
      updated_at: completed,
    });
  } catch (error) {
    const completed = new Date().toISOString();
    writeJob({
      ...(readCodeRefreshJob(root, jobId) ?? job),
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      completed_at: completed,
      updated_at: completed,
    });
  }
}
