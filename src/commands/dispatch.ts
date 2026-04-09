/**
 * CLI command: brainclaw dispatch
 *
 * Subcommands:
 *   brainclaw dispatch analysis    — show lane status
 *   brainclaw dispatch run         — send assignments to available agents
 *   brainclaw dispatch run --dry   — preview assignments without sending
 *
 * @module
 */
import { memoryExists } from '../core/io.js';
import { analyzeSequence, dispatch, dispatchReview } from '../core/dispatcher.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';

export interface DispatchCommandOptions {
  agents?: string;
  lanes?: string;
  max?: number;
  dry?: boolean;
  spawn?: boolean;
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export function runDispatchAnalysis(options: DispatchCommandOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const analysis = analyzeSequence(cwd ?? process.cwd());
  if (!analysis) {
    console.log('No active sequence found.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  console.log(`\nDispatch Analysis — ${analysis.sequence.name}\n`);

  // Ready
  console.log(`🟢 Ready (${analysis.ready.length}):`);
  for (const r of analysis.ready) {
    const lane = r.lane ? ` [${r.lane}]` : '';
    const assignee = r.plan.assignee ? ` → ${r.plan.assignee}` : '';
    console.log(`  ${r.plan.short_label ?? r.plan.id}${lane}${assignee}`);
    console.log(`    ${r.plan.text.slice(0, 100)}`);
    console.log(`    ${r.reason}`);
  }

  // Active
  if (analysis.active.length > 0) {
    console.log(`\n🔵 Active (${analysis.active.length}):`);
    for (const a of analysis.active) {
      const lane = a.lane ? ` [${a.lane}]` : '';
      console.log(`  ${a.plan.short_label ?? a.plan.id}${lane} — ${a.agent} working`);
    }
  }

  // Blocked
  if (analysis.blocked.length > 0) {
    console.log(`\n🔴 Blocked (${analysis.blocked.length}):`);
    for (const b of analysis.blocked) {
      const lane = b.lane ? ` [${b.lane}]` : '';
      console.log(`  ${b.item.planId}${lane} — ${b.reason}`);
    }
  }

  // Done
  if (analysis.done.length > 0) {
    console.log(`\n✅ Done (${analysis.done.length})`);
  }

  // Available agents
  console.log(`\nAvailable agents: ${analysis.available_agents.length > 0 ? analysis.available_agents.join(', ') : '(none)'}`);
  console.log('');
}

export function runDispatch(options: DispatchCommandOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const dispatcherAgent = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'brainclaw';

  const result = dispatch({
    agents: options.agents?.split(',').map(a => a.trim()),
    lanes: options.lanes?.split(',').map(l => l.trim()),
    maxAssignments: options.max,
    dryRun: options.dry,
    dispatcherAgent,
  }, effectiveCwd);

  if (!result) {
    console.log('No active sequence found.');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { analysis, result: dispatchResult } = result;

  if (options.dry) {
    console.log(`\n🔍 Dispatch dry run — ${analysis.sequence.name}\n`);
  } else {
    console.log(`\n✔ Dispatch complete — ${analysis.sequence.name}\n`);
  }

  console.log(`  Ready: ${analysis.ready.length} | Active: ${analysis.active.length} | Blocked: ${analysis.blocked.length} | Done: ${analysis.done.length}`);

  if (dispatchResult.messages_sent.length > 0) {
    console.log(`\n  ${options.dry ? 'Would assign' : 'Assigned'}:`);
    for (const msg of dispatchResult.messages_sent) {
      const lane = msg.lane ? ` (lane: ${msg.lane})` : '';
      console.log(`    → ${msg.agent}: ${msg.plan_id}${lane} [inbox]`);
    }
  }

  if (dispatchResult.skipped.length > 0) {
    console.log('\n  Skipped:');
    for (const skip of dispatchResult.skipped) {
      console.log(`    - ${skip.plan_id}: ${skip.reason}`);
    }
  }

  console.log('');
}

// ── Dispatch Review ─────────────────────────────────────────

export interface DispatchReviewCommandOptions {
  handoff?: string;
  reviewer?: string;
  spawn?: boolean;
  dry?: boolean;
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export function runDispatchReview(options: DispatchReviewCommandOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const dispatcherAgent = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'brainclaw';

  const result = dispatchReview({
    handoffId: options.handoff,
    reviewer: options.reviewer,
    dryRun: options.dry,
    dispatcherAgent,
  }, effectiveCwd);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (options.dry) {
    console.log('\n🔍 Review dispatch dry run\n');
  } else {
    console.log('\n✔ Review dispatch complete\n');
  }

  if (result.reviews_sent.length > 0) {
    for (const r of result.reviews_sent) {
      console.log(`  → ${r.reviewer} reviewing ${r.handoff_id}${r.plan_id ? ` (${r.plan_id})` : ''} [inbox]`);
    }
  } else {
    console.log('  No handoffs ready for review.');
  }

  if (result.skipped.length > 0) {
    console.log('\n  Skipped:');
    for (const s of result.skipped) {
      console.log(`    - ${s.handoff_id}: ${s.reason}`);
    }
  }

  console.log('');
}
