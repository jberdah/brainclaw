import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { memoryExists } from '../core/io.js';
import { loadState } from '../core/state.js';
import { listCandidates } from '../core/candidates.js';
import { listClaims } from '../core/claims.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { listOperationalTraps } from '../core/traps.js';
import { pullRemoteMemory, pushRemoteMemory } from '../core/sync-remote.js';

export interface SyncOptions {
  commit?: boolean;
  message?: string;
  summaryOnly?: boolean;
  scope?: string;
  includeMachineRuntime?: boolean;
  remote?: boolean;
  cwd?: string;
}

export function runSync(options: SyncOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  // --remote: pull + show summary + push
  if (options.remote) {
    console.log('Remote sync: pull → summarize → push');
    console.log('');
    const pullResult = pullRemoteMemory({});
    if (pullResult.success) {
      console.log(`  Pull: ✔ ${pullResult.message}`);
    } else {
      console.error(`  Pull: ✗ ${pullResult.message}`);
      process.exit(1);
    }
    const pushResult = pushRemoteMemory({});
    if (pushResult.success) {
      console.log(`  Push: ✔ ${pushResult.message}`);
    } else {
      console.error(`  Push: ✗ ${pushResult.message}`);
      process.exit(1);
    }
    return;
  }

  // Summarize current memory state
  const state = loadState(options.cwd);
  const pending = listCandidates('pending', options.cwd);
  const claims = listClaims(options.cwd).filter(c => c.status === 'active');
  const sharedNotes = listRuntimeNotes({ visibility: 'shared' }, options.cwd);
  const machineNotes = listRuntimeNotes({ visibility: 'machine' }, options.cwd);
  const privateNotes = listRuntimeNotes({ visibility: 'private' }, options.cwd);
  const machineTraps = listOperationalTraps({ visibility: 'machine' }, options.cwd);
  const privateTraps = listOperationalTraps({ visibility: 'private' }, options.cwd);
  const activePlans = state.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');

  console.log('Memory sync summary:');
  console.log('');
  console.log(`  State: ${activePlans.length} plans, ${state.active_constraints.length} constraints, ${state.recent_decisions.length} decisions, ${state.known_traps.length} traps, ${state.open_handoffs.length} handoffs`);
  console.log(`  Pending candidates: ${pending.length}`);
  console.log(`  Active claims: ${claims.length}`);
  console.log(`  Runtime notes: ${sharedNotes.length} shared, ${machineNotes.length} machine-local, ${privateNotes.length} private`);
  console.log(`  Local traps: ${machineTraps.length} machine-local, ${privateTraps.length} private`);

  const scopePaths = resolveScopePaths(options.scope, options.includeMachineRuntime ?? false, options.cwd);
  const pathSpec = scopePaths.join(' ');
  console.log(`  Sync scope: ${pathSpec}`);

  if (options.summaryOnly) {
    console.log('');
    console.log('  Summary-only mode enabled; skipping git status and commit checks.');
    return;
  }

  // Check git status of .brainclaw/
  let gitStatus = '';
  try {
    gitStatus = execSync(`git status --porcelain ${pathSpec}`, {
      encoding: 'utf-8',
      cwd: options.cwd ?? process.cwd(),
      timeout: 5000,
    }).trim();
  } catch {
    console.log('');
    console.log('  (not a git repo or git not available — skipping git status)');
    return;
  }

  if (!gitStatus) {
    console.log('');
    console.log('  No uncommitted changes in .brainclaw/');
    return;
  }

  const changed = gitStatus.split('\n').length;
  console.log('');
  console.log(`  ${changed} file(s) changed in .brainclaw/`);

  if (options.commit) {
    const msg = options.message ?? `chore: sync brainclaw (${new Date().toISOString().slice(0, 10)})`;

    try {
      execSync(`git add ${pathSpec}`, {
        cwd: options.cwd ?? process.cwd(),
        timeout: 5000,
      });
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8',
        cwd: options.cwd ?? process.cwd(),
        timeout: 10000,
      });

      console.log(`✔ Committed .brainclaw/ changes: "${msg}"`);
      console.log('  (not pushed — run `git push` when ready)');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: failed to commit .brainclaw/ changes. ${message}`);
      process.exit(1);
    }
  } else {
    console.log('  Run with --commit to create a local git commit.');
  }
}

export function resolveScopePaths(scope?: string, includeMachineRuntime: boolean = false, cwd?: string): string[] {
  switch ((scope ?? 'all').toLowerCase()) {
    case 'all':
      return existingScopePaths([
        '.brainclaw/config.yaml',
        '.brainclaw/project.md',
        '.brainclaw/memory/constraints/',
        '.brainclaw/memory/decisions/',
        '.brainclaw/memory/traps/',
        '.brainclaw/coordination/handoffs/',
        '.brainclaw/coordination/plans/',
        '.brainclaw/memory/instructions/',
        '.brainclaw/coordination/inbox/',
        '.brainclaw/archive/',
        '.brainclaw/coordination/claims/',
        '.brainclaw/coordination/runtime/',
        ...(includeMachineRuntime ? ['.brainclaw/coordination/runtime-hosts/', '.brainclaw/coordination/runtime-private/'] : []),
      ], cwd);
    case 'state':
      return existingScopePaths([
        '.brainclaw/memory/constraints/',
        '.brainclaw/memory/decisions/',
        '.brainclaw/memory/traps/',
        '.brainclaw/coordination/handoffs/',
      ], cwd);
    case 'config':
      return existingScopePaths(['.brainclaw/config.yaml'], cwd);
    case 'project':
      return existingScopePaths(['.brainclaw/project.md'], cwd);
    case 'inbox':
      return existingScopePaths(['.brainclaw/coordination/inbox/'], cwd);
    case 'archive':
      return existingScopePaths(['.brainclaw/archive/'], cwd);
    case 'claims':
      return existingScopePaths(['.brainclaw/coordination/claims/'], cwd);
    case 'runtime':
      return existingScopePaths(['.brainclaw/coordination/runtime/'], cwd);
    case 'runtime-local':
      return existingScopePaths(['.brainclaw/coordination/runtime-hosts/', '.brainclaw/coordination/runtime-private/'], cwd);
    case 'trap-local':
      return existingScopePaths(['.brainclaw/memory/traps-hosts/', '.brainclaw/memory/traps-private/'], cwd);
    default:
      console.warn(`⚠ Unknown sync scope "${scope}"; defaulting to .brainclaw/`);
      return resolveScopePaths('all', includeMachineRuntime, cwd);
  }
}

function existingScopePaths(paths: string[], cwd?: string): string[] {
  return paths.filter((scopePath) => fs.existsSync(cwd ? path.join(cwd, scopePath) : scopePath));
}
