import { runCascadeRefreshJob } from './cascade-jobs.js';

const [root, jobId, rawScope] = process.argv.slice(2);
if (!root || !jobId) process.exit(2);
const scope = rawScope === 'all' ? 'all' : 'changed';
try {
  await runCascadeRefreshJob(root, jobId, scope);
  // Tree-sitter/native handles can keep Node's event loop alive after the
  // durable terminal record has been flushed. This process owns no other work.
  process.exit(0);
} catch {
  process.exit(1);
}
