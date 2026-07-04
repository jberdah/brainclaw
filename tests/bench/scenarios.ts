/**
 * Bench scenarios for the "time-to-first-value" harness (pln#604).
 *
 * Three scenarios map onto the four surfaces that recent optimisation plans
 * push on: latency (pln#578/pln#566), payload weight (pln#598), and
 * discovery pertinence (pln#601). Each scenario runs in-process against a
 * synthetic store — deterministic across CI runs, so budget gating in
 * scripts/bench-check.mjs is meaningful (a >20% delta is code, not noise).
 *
 * The Node-import cost that dominates real cold-start wall clock (13.7 s
 * observed 2026-07-04) is intentionally OUT of scope here: it drifts with
 * dependency bumps, not with brainclaw code. A subprocess variant can be
 * added later behind a --full flag if we ever want to publish that number.
 */
import { runScenario, type RunScenarioContext, type ScenarioResult } from '../helpers/bench-harness.js';
import {
  createSyntheticStore,
  SYNTHETIC_STORE_VOLUMES,
  type SyntheticVolume,
} from '../helpers/synthetic-store.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';

export type ScenarioName = 'cold_onboard' | 'warm_work' | 'first_edit';

interface ScenarioSpec {
  name: ScenarioName;
  volume: SyntheticVolume;
  description: string;
}

export const SCENARIO_SPECS: ScenarioSpec[] = [
  {
    name: 'cold_onboard',
    volume: 'empty',
    description: 'fresh machine → init → first useful context. Baseline for time-to-first-value.',
  },
  {
    name: 'warm_work',
    volume: 'medium',
    description: 'bclaw_work consult over a real-shaped store (~200 plans / 500 handoffs / 450 claims).',
  },
  {
    name: 'first_edit',
    volume: 'medium',
    description: 'code_find + code_brief on the fresh-agent path (missing index, first touch).',
  },
];

async function mcpCall(
  ctx: RunScenarioContext,
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const outcome = await executeMcpToolCall({ name, args, cwd });
  const structured = outcome.response.structuredContent ?? {};
  ctx.addCall(structured);
  if (outcome.response.isError) {
    const text = outcome.response.content.map((part) => part.text).join('\n');
    throw new Error(`${name} failed: ${text}`);
  }
  return structured;
}

async function runColdOnboard(): Promise<ScenarioResult> {
  const store = createSyntheticStore({ volume: 'empty', seed: 42 });
  try {
    return await runScenario('cold_onboard', 'empty', async (ctx) => {
      const work = await mcpCall(ctx, store.cwd, 'bclaw_work', { intent: 'consult', agent: 'bench-agent' });
      ctx.addExtra('sessions_started');
      const result = work.result as { plan_summary?: unknown[]; memory_density?: string } | undefined;
      ctx.addExtra('selected_items', result?.plan_summary?.length ?? 0);
      if (result?.memory_density) ctx.note(`memory_density=${result.memory_density}`);
    });
  } finally {
    store.cleanup();
  }
}

async function runWarmWork(): Promise<ScenarioResult> {
  const store = createSyntheticStore({ volume: 'medium', seed: 42 });
  try {
    return await runScenario('warm_work', 'medium', async (ctx) => {
      const work = await mcpCall(ctx, store.cwd, 'bclaw_work', {
        intent: 'consult',
        contextTarget: 'src/core/context.ts',
        agent: 'bench-agent',
      });
      ctx.addExtra('sessions_started');
      const result = work.result as { plan_summary?: unknown[] } | undefined;
      ctx.addExtra('selected_items', result?.plan_summary?.length ?? 0);
      ctx.addExtra('plans_loaded', SYNTHETIC_STORE_VOLUMES.medium.plans);
      ctx.addExtra('handoffs_loaded', SYNTHETIC_STORE_VOLUMES.medium.handoffs);
      ctx.addExtra('claims_loaded', SYNTHETIC_STORE_VOLUMES.medium.claims);
    });
  } finally {
    store.cleanup();
  }
}

async function runFirstEdit(): Promise<ScenarioResult> {
  const store = createSyntheticStore({ volume: 'medium', seed: 42 });
  try {
    return await runScenario('first_edit', 'medium', async (ctx) => {
      await mcpCall(ctx, store.cwd, 'bclaw_code_status', {});
      const findResult = await mcpCall(ctx, store.cwd, 'bclaw_code_find', { query: 'buildContext' });
      const matches = findResult.matches as unknown[] | undefined;
      ctx.addExtra('find_matches', matches?.length ?? 0);
      const briefResult = await mcpCall(ctx, store.cwd, 'bclaw_code_brief', { target: 'src/core/context.ts' });
      const files = briefResult.suggested_files_to_read as unknown[] | undefined;
      ctx.addExtra('brief_files', files?.length ?? 0);
      const freshness = findResult.freshness_badge as { status?: string } | undefined;
      if (freshness?.status) ctx.note(`freshness=${freshness.status}`);
    });
  } finally {
    store.cleanup();
  }
}

const SCENARIO_RUNNERS: Record<ScenarioName, () => Promise<ScenarioResult>> = {
  cold_onboard: runColdOnboard,
  warm_work: runWarmWork,
  first_edit: runFirstEdit,
};

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const spec of SCENARIO_SPECS) {
    const runner = SCENARIO_RUNNERS[spec.name];
    results.push(await runner());
  }
  return results;
}

export async function runSingleScenario(name: ScenarioName): Promise<ScenarioResult> {
  const runner = SCENARIO_RUNNERS[name];
  if (!runner) throw new Error(`Unknown scenario: ${name}`);
  return runner();
}
