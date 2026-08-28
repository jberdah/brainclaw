import { runCodeRefreshJob } from './refresh-jobs.js';

const [root, jobId, scope] = process.argv.slice(2);
if (!root || !jobId || (scope !== 'changed' && scope !== 'all')) {
  process.exitCode = 2;
} else {
  await runCodeRefreshJob(root, jobId, scope);
  // Dedicated detached process: no library-owned handle may keep the caller's
  // project directory busy after the durable terminal state has been written.
  process.exit(0);
}
