/**
 * `brainclaw repair` — safe, non-destructive repair flow built on doctor's
 * structured repair candidates (pln#397 stp_b31fbe23).
 *
 * Design:
 *   1. Run the doctor JSON output and capture `repair_candidates[]`.
 *   2. Split into `safe` and `unsafe`.
 *   3. Execute safe candidates by default; unsafe stay deferred unless the
 *      caller passes `includeUnsafe`. Preservation guarantees (no lossy
 *      writes without a warning, no silent deletion of memory) are
 *      enforced in stp_7ad66f68.
 *
 * Exposed via CLI (`brainclaw repair`) and MCP (`bclaw_repair`). Always
 * returns a structured summary so agents can inspect what changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, memoryDir } from '../core/io.js';
import { runDoctor, type RepairCandidate } from './doctor.js';

export interface RepairOptions {
  cwd?: string;
  /** Print the plan but do not execute anything. Default: false. */
  dryRun?: boolean;
  /** Also execute `safe: false` candidates. Default: false. */
  includeUnsafe?: boolean;
  /** Return structured output instead of printing. Set by JSON/MCP callers. */
  json?: boolean;
}

export interface RepairOutcome {
  action: string;
  target: string;
  status: 'applied' | 'skipped' | 'failed';
  /** Populated on failure or when a candidate is intentionally skipped. */
  reason?: string;
}

export interface RepairResult {
  ok: boolean;
  dry_run: boolean;
  candidates_total: number;
  candidates_safe: number;
  candidates_unsafe: number;
  applied: RepairOutcome[];
  skipped: RepairOutcome[];
  failed: RepairOutcome[];
}

/**
 * Execute a single repair candidate. Returns the outcome; never throws.
 * Safe actions are pure creation / rename operations — see the switch cases.
 */
function executeCandidate(candidate: RepairCandidate, cwd: string): RepairOutcome {
  try {
    switch (candidate.action) {
      case 'mkdir': {
        const target = path.resolve(cwd, candidate.target);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(target, { recursive: true });
        }
        return { action: candidate.action, target: candidate.target, status: 'applied' };
      }
      case 'move_inbox_message': {
        // Orphaned messages stored under the wrong agent directory. Read the
        // message, resolve the correct destination from message.to, and
        // rename. Source file already exists; target dir is auto-created.
        const sourceAbs = path.resolve(cwd, candidate.target);
        if (!fs.existsSync(sourceAbs)) {
          return { action: candidate.action, target: candidate.target, status: 'skipped', reason: 'source file no longer exists' };
        }
        const parsed = JSON.parse(fs.readFileSync(sourceAbs, 'utf-8')) as { document?: { to?: string }; to?: string };
        const recipient = parsed.document?.to ?? parsed.to;
        if (!recipient) {
          return { action: candidate.action, target: candidate.target, status: 'skipped', reason: 'message has no recipient (to) field' };
        }
        const normalizedAgent = recipient.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const inboxRoot = path.join(memoryDir(cwd), 'coordination', 'inbox', normalizedAgent);
        if (!fs.existsSync(inboxRoot)) {
          fs.mkdirSync(inboxRoot, { recursive: true });
        }
        const destAbs = path.join(inboxRoot, path.basename(sourceAbs));
        if (fs.existsSync(destAbs) && path.resolve(destAbs) !== path.resolve(sourceAbs)) {
          return { action: candidate.action, target: candidate.target, status: 'skipped', reason: `destination already exists: ${destAbs}` };
        }
        fs.renameSync(sourceAbs, destAbs);
        return { action: candidate.action, target: candidate.target, status: 'applied' };
      }
      case 'quarantine_inbox_message': {
        // Unsafe: move malformed message to a quarantine directory so a human
        // can inspect it. Never deletes. Requires includeUnsafe.
        const sourceAbs = path.resolve(cwd, candidate.target);
        if (!fs.existsSync(sourceAbs)) {
          return { action: candidate.action, target: candidate.target, status: 'skipped', reason: 'source file no longer exists' };
        }
        const quarantineDir = path.join(memoryDir(cwd), 'coordination', 'inbox', '.quarantine');
        if (!fs.existsSync(quarantineDir)) {
          fs.mkdirSync(quarantineDir, { recursive: true });
        }
        const destAbs = path.join(quarantineDir, `${Date.now()}-${path.basename(sourceAbs)}`);
        fs.renameSync(sourceAbs, destAbs);
        return { action: candidate.action, target: candidate.target, status: 'applied' };
      }
      default:
        return {
          action: candidate.action,
          target: candidate.target,
          status: 'skipped',
          reason: `unknown action: ${candidate.action}`,
        };
    }
  } catch (err) {
    return {
      action: candidate.action,
      target: candidate.target,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Collect repair candidates by running doctor with JSON output captured.
 * We re-run doctor instead of accepting them via an argument so the caller
 * always sees the current state of the store.
 */
function collectCandidates(cwd: string): RepairCandidate[] {
  const originalLog = console.log;
  let captured = '';
  console.log = (...args: unknown[]) => { captured += args.map(String).join(' '); };
  try {
    runDoctor({ cwd, json: true });
  } finally {
    console.log = originalLog;
  }
  try {
    const parsed = JSON.parse(captured) as { repair_candidates?: RepairCandidate[] };
    return Array.isArray(parsed.repair_candidates) ? parsed.repair_candidates : [];
  } catch {
    return [];
  }
}

export function runRepair(options: RepairOptions = {}): RepairResult {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const candidates = collectCandidates(cwd);
  const safe = candidates.filter((c) => c.safe);
  const unsafe = candidates.filter((c) => !c.safe);

  const applied: RepairOutcome[] = [];
  const skipped: RepairOutcome[] = [];
  const failed: RepairOutcome[] = [];

  const toRun = [...safe, ...(options.includeUnsafe ? unsafe : [])];
  const deferred = options.includeUnsafe ? [] : unsafe;

  for (const candidate of toRun) {
    if (options.dryRun) {
      skipped.push({
        action: candidate.action,
        target: candidate.target,
        status: 'skipped',
        reason: 'dry-run',
      });
      continue;
    }
    const outcome = executeCandidate(candidate, cwd);
    if (outcome.status === 'applied') applied.push(outcome);
    else if (outcome.status === 'failed') failed.push(outcome);
    else skipped.push(outcome);
  }

  for (const candidate of deferred) {
    skipped.push({
      action: candidate.action,
      target: candidate.target,
      status: 'skipped',
      reason: 'unsafe — pass --include-unsafe to execute (preserves data, but requires confirmation)',
    });
  }

  const result: RepairResult = {
    ok: failed.length === 0,
    dry_run: Boolean(options.dryRun),
    candidates_total: candidates.length,
    candidates_safe: safe.length,
    candidates_unsafe: unsafe.length,
    applied,
    skipped,
    failed,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (candidates.length === 0) {
    console.log('Nothing to repair — doctor surfaced no candidates.');
    return result;
  }

  if (options.dryRun) {
    console.log(`Dry-run: ${candidates.length} candidate(s) (${safe.length} safe, ${unsafe.length} unsafe)`);
  } else {
    console.log(`Repair complete: ${applied.length} applied, ${skipped.length} skipped, ${failed.length} failed`);
  }
  for (const o of applied) console.log(`  ✔ ${o.action} → ${o.target}`);
  for (const o of skipped) console.log(`  ○ ${o.action} → ${o.target}${o.reason ? ` (${o.reason})` : ''}`);
  for (const o of failed) console.log(`  ✗ ${o.action} → ${o.target}${o.reason ? ` (${o.reason})` : ''}`);
  return result;
}
