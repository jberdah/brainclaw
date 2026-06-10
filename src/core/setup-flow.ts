/**
 * Setup flow logic for the new onboarding experience.
 *
 * Two modes:
 * - Quick: init the current repo (1-2 MCP calls)
 * - Batch: scan roots and init multiple repos (legacy 4-step flow)
 *
 * Quick flow:
 *   1. Auto-detect repo, agent, nearby stores → ask project type + topology
 *   2. Init + optional bootstrap → done
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { memoryDir, memoryExists } from './io.js';
import { detectAiAgent } from './ai-agent-detection.js';
import { resolveStoreChain, type StoreRef } from './store-resolution.js';
import { analyzeRepository } from './repo-analysis.js';
import { getAgentCapabilityProfile, getAllAgentCapabilityProfiles, type AgentCapabilityProfile } from './agent-capability.js';
import { describeAgentSurfaces } from './agent-capability.js';
import { loadState } from './state.js';

export interface QuickSetupProbe {
  /** Current working directory */
  cwd: string;
  /** Is a git repo */
  isGitRepo: boolean;
  /** Already initialized with brainclaw */
  alreadyInitialized: boolean;
  /** Repo name (from directory) */
  repoName: string;
  /** Detected framework/language */
  repoSummary: string;
  /** Detected AI agent in current environment */
  detectedAgent: { name: string; profile: AgentCapabilityProfile } | undefined;
  /** Other agents installed on this machine */
  otherAgents: AgentCapabilityProfile[];
  /** Nearby brainclaw stores (parent workspace, user store, etc.) */
  nearbyStores: StoreRef[];
  /** Has files (not empty workspace) */
  hasContent: boolean;
  /** Suggested project type based on analysis */
  suggestedProjectType: 'standalone' | 'workspace' | 'linked';
  /** Repo analysis reasons */
  analysisReasons: string[];
}

/** Entries that don't count as "repo content" when deciding the bootstrap route. */
const CONTENT_IGNORED = new Set(['.git', '.brainclaw', '.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db']);

/** True when cwd contains anything beyond git/brainclaw plumbing. */
export function repoHasContent(cwd: string): boolean {
  try {
    return fs.readdirSync(cwd).some((e) => !CONTENT_IGNORED.has(e));
  } catch {
    return false;
  }
}

export type EmptyMemoryRoute = 'extract' | 'ideate';

export interface EmptyMemoryRecommendation {
  route: EmptyMemoryRoute;
  reason: string;
  /** Exact MCP call to suggest, verbatim. */
  mcp_next_action: string;
  /** Exact CLI command to suggest, verbatim. */
  cli_next_action: string;
  /** The follow-up once the first route completes — the two routes are chainable. */
  chained_mcp_action: string;
  /** Shared one-line message, identical on every surface. */
  text: string;
}

/**
 * THE decision rule for "the memory store is empty — what now?", emitted
 * identically by the three onboarding surfaces (bclaw_work hint, quick_init
 * preview, init preflight):
 *
 *   - repo with existing content → bclaw_bootstrap (extract context from docs/manifests/history)
 *   - greenfield (nothing to extract) → bootstrap loop (ideate the vision first)
 *
 * The two routes are chainable: extraction first, then a bootstrap loop for
 * whatever vision the docs could not provide — or ideation first, then
 * extraction once content exists.
 * Documented in docs/concepts/workspace-bootstrapping.md ("Empty memory: one rule").
 */
export function resolveEmptyMemoryRecommendation(cwd: string = process.cwd()): EmptyMemoryRecommendation {
  if (repoHasContent(cwd)) {
    return {
      route: 'extract',
      reason: 'repo has existing content to extract from',
      mcp_next_action: 'bclaw_bootstrap()',
      cli_next_action: 'brainclaw bootstrap',
      chained_mcp_action: "bclaw_coordinate(intent='ideate', preset='bootstrap')",
      text: "Memory is empty and the repo has existing content → run bclaw_bootstrap (CLI: brainclaw bootstrap) to extract initial context. If the project vision is still missing afterwards, chain a bootstrap loop: bclaw_coordinate(intent='ideate', preset='bootstrap').",
    };
  }
  return {
    route: 'ideate',
    reason: 'greenfield repo — nothing to extract yet',
    mcp_next_action: "bclaw_coordinate(intent='ideate', preset='bootstrap')",
    cli_next_action: 'brainclaw bootstrap-loop',
    chained_mcp_action: 'bclaw_bootstrap()',
    text: "Memory is empty and the repo is greenfield → open a bootstrap loop to ideate the project vision: bclaw_coordinate(intent='ideate', preset='bootstrap') (CLI: brainclaw bootstrap-loop). Once content exists, chain bclaw_bootstrap to extract it.",
  };
}

// --- Composite bootstrap-need assessment (pln#557 step 3) -------------------

export type BootstrapVerdict = 'bootstrap' | 'refresh' | 'none';

export interface BootstrapNeedAssessment {
  verdict: BootstrapVerdict;
  /** Human-readable signals behind the verdict. */
  reasons: string[];
  project_md_present: boolean;
  store_density: 'empty' | 'low' | 'rich';
}

/** Event log this large reads as a mature store, not a from-scratch case. */
const RICH_EVENT_LOG_BYTES = 64 * 1024;
/** This many memory items reads as a mature store. */
const RICH_STATE_ITEMS = 25;
/** PROJECT.md this much older than the latest repo/store activity is fossil. */
const FOSSIL_GAP_MS = 30 * 86_400_000;

function lastCommitEpochMs(cwd: string): number | undefined {
  try {
    const probe = spawnSync('git', ['log', '-1', '--format=%ct'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    });
    if (probe.status !== 0) return undefined;
    const epoch = Number.parseInt(probe.stdout.trim(), 10);
    return Number.isFinite(epoch) ? epoch * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Composite replacement for the one-bit PROJECT.md stat() that backed
 * `bootstrap_recommended` (pln#513). The single bit had two failure modes on
 * a mature ("amorcé") project:
 *   - false positive: rich store, missing PROJECT.md → recommended a
 *     from-scratch bootstrap over 17k events of accumulated memory;
 *   - eternal false negative: PROJECT.md exists but fossilized — never
 *     flagged again no matter how far the repo drifted.
 *
 * Signals combined: PROJECT.md presence × its mtime vs recent activity
 * (last commit, last memory write) × store density (event-log size,
 * memory item count). 'refresh' maps to `bclaw_bootstrap(refresh: true)` —
 * coordinate with the pln#514 step 1 force-flag on the bootstrap-loop side.
 */
export function assessBootstrapNeed(cwd: string = process.cwd()): BootstrapNeedAssessment {
  const reasons: string[] = [];

  // Signal 1 — PROJECT.md presence.
  const projectMdPath = path.join(cwd, 'PROJECT.md');
  let projectMdPresent = false;
  let projectMdMtimeMs: number | undefined;
  try {
    const stat = fs.statSync(projectMdPath);
    if (stat.isFile() && stat.size > 0) {
      projectMdPresent = true;
      projectMdMtimeMs = stat.mtimeMs;
    }
  } catch { /* absent */ }

  // Signal 2 — store density.
  let eventLogBytes = 0;
  let eventLogMtimeMs: number | undefined;
  try {
    const stat = fs.statSync(path.join(memoryDir(cwd), 'events.jsonl'));
    eventLogBytes = stat.size;
    eventLogMtimeMs = stat.mtimeMs;
  } catch { /* no event log */ }
  let stateItems = 0;
  try {
    const state = loadState(cwd);
    stateItems = state.active_constraints.length + state.recent_decisions.length
      + state.known_traps.length + state.open_handoffs.length + state.plan_items.length;
  } catch { /* unreadable state → 0 */ }
  const storeDensity: BootstrapNeedAssessment['store_density'] =
    eventLogBytes >= RICH_EVENT_LOG_BYTES || stateItems >= RICH_STATE_ITEMS
      ? 'rich'
      : eventLogBytes === 0 && stateItems === 0
        ? 'empty'
        : 'low';

  if (!projectMdPresent) {
    if (storeDensity === 'rich') {
      // The store already knows this project — regenerate PROJECT.md from it
      // (scanner + memory), do NOT restart discovery from scratch.
      reasons.push(`PROJECT.md missing but the store is rich (${stateItems} items, ${Math.round(eventLogBytes / 1024)} KB events) — regenerate from existing memory instead of bootstrapping from scratch`);
      return { verdict: 'refresh', reasons, project_md_present: false, store_density: storeDensity };
    }
    reasons.push('PROJECT.md missing and the store is sparse — initial bootstrap applies');
    return { verdict: 'bootstrap', reasons, project_md_present: false, store_density: storeDensity };
  }

  // Signal 3 — fossil check: PROJECT.md much older than the latest activity.
  const lastActivityMs = Math.max(lastCommitEpochMs(cwd) ?? 0, eventLogMtimeMs ?? 0);
  if (projectMdMtimeMs !== undefined && lastActivityMs > 0 && lastActivityMs - projectMdMtimeMs > FOSSIL_GAP_MS) {
    const gapDays = Math.round((lastActivityMs - projectMdMtimeMs) / 86_400_000);
    reasons.push(`PROJECT.md is ${gapDays} days older than the latest repo/store activity — likely fossil, refresh it`);
    return { verdict: 'refresh', reasons, project_md_present: true, store_density: storeDensity };
  }

  reasons.push('PROJECT.md present and current relative to recent activity');
  return { verdict: 'none', reasons, project_md_present: true, store_density: storeDensity };
}

/**
 * Probe the current working directory to understand what we're working with.
 * This is the first step of the quick setup flow — no questions yet, just detection.
 */
export function probeForQuickSetup(cwd: string = process.cwd()): QuickSetupProbe {
  const isGitRepo = fs.existsSync(path.join(cwd, '.git'));
  const alreadyInitialized = memoryExists(cwd);
  const repoName = path.basename(cwd);

  // Detect agent
  const detectedAi = detectAiAgent();
  const detectedAgent = detectedAi
    ? { name: detectedAi.name, profile: getAgentCapabilityProfile(detectedAi.name)! }
    : undefined;

  // Find other known agent profiles (for info)
  const otherAgents = detectedAgent
    ? getAllAgentCapabilityProfiles().filter((p) => p.name !== detectedAgent.name)
    : getAllAgentCapabilityProfiles();

  // Scan nearby stores
  const nearbyStores = resolveStoreChain(cwd);

  const hasContent = repoHasContent(cwd);

  // Analyze repo for project type suggestion
  let suggestedProjectType: 'standalone' | 'workspace' | 'linked' = 'standalone';
  let analysisReasons: string[] = [];
  try {
    const analysis = analyzeRepository(cwd);
    if (analysis.recommendedMode === 'multi-project') {
      suggestedProjectType = 'workspace';
    }
    analysisReasons = analysis.reasons;
  } catch {
    // analysis failed — default to standalone
  }

  // If there are nearby stores, suggest linking
  const parentStores = nearbyStores.filter((s) => s.depth > 0 && s.role === 'workspace');
  if (parentStores.length > 0 && !alreadyInitialized) {
    suggestedProjectType = 'linked';
  }

  // Build repo summary
  const summaryParts: string[] = [];
  if (isGitRepo) summaryParts.push('git repo');
  if (hasContent) summaryParts.push(`"${repoName}"`);
  if (analysisReasons.length > 0) summaryParts.push(analysisReasons[0]);
  const repoSummary = summaryParts.join(', ') || 'empty directory';

  return {
    cwd,
    isGitRepo,
    alreadyInitialized,
    repoName,
    repoSummary,
    detectedAgent,
    otherAgents,
    nearbyStores,
    hasContent,
    suggestedProjectType,
    analysisReasons,
  };
}

export type ProjectTypeChoice = 'standalone' | 'workspace' | 'linked';
export type TopologyChoice = 'embedded' | 'sidecar';

export interface QuickSetupChoices {
  projectType: ProjectTypeChoice;
  topology: TopologyChoice;
  linkTo?: string; // store path to link to (when projectType === 'linked')
}

/**
 * Build the structured response for the initial probe step of quick setup.
 * Returns data the agent can use to present choices to the user.
 */
export function buildQuickSetupProbeResponse(probe: QuickSetupProbe): {
  text: string;
  structured: Record<string, unknown>;
} {
  const lines: string[] = [];

  if (probe.alreadyInitialized) {
    lines.push(`This project (${probe.repoName}) is already initialized with brainclaw.`);
    lines.push('Use `brainclaw export --detect --write` to regenerate agent files, or `brainclaw upgrade` to migrate.');
    return {
      text: lines.join('\n'),
      structured: {
        already_initialized: true,
        cwd: probe.cwd,
        repo_name: probe.repoName,
      },
    };
  }

  lines.push(`Detected: ${probe.repoSummary}`);
  if (probe.detectedAgent) {
    lines.push(`Agent: ${probe.detectedAgent.name} (${probe.detectedAgent.profile.templateTier === 'A' ? 'full integration' : probe.detectedAgent.profile.templateTier === 'B' ? 'standard integration' : 'limited integration'})`);
    lines.push(`Surfaces: ${describeAgentSurfaces(probe.detectedAgent.name).join(', ')}`);
  }

  if (probe.nearbyStores.length > 0) {
    lines.push('');
    lines.push('Nearby brainclaw stores:');
    for (const store of probe.nearbyStores) {
      lines.push(`  - ${store.role} at ${store.cwd} (depth ${store.depth})`);
    }
  }

  lines.push('');
  lines.push('Ask the user:');
  lines.push('');
  lines.push('1. What kind of project is this?');
  lines.push(`   - Standalone project (single .brainclaw/ for the whole repo)${probe.suggestedProjectType === 'standalone' ? ' ← suggested' : ''}`);
  lines.push(`   - Workspace with sub-projects (monorepo)${probe.suggestedProjectType === 'workspace' ? ' ← suggested' : ''}`);
  if (probe.nearbyStores.some((s) => s.role === 'workspace')) {
    lines.push(`   - Linked to an existing workspace${probe.suggestedProjectType === 'linked' ? ' ← suggested' : ''}`);
  }
  lines.push('');
  lines.push('2. Should the memory be shared with the team?');
  lines.push('   - Yes, shared via git (.brainclaw/ tracked in git) ← recommended');
  lines.push('   - No, local only (.brainclaw/ gitignored)');

  return {
    text: lines.join('\n'),
    structured: {
      pending_question: 'quick_init',
      probe: {
        cwd: probe.cwd,
        repo_name: probe.repoName,
        repo_summary: probe.repoSummary,
        is_git_repo: probe.isGitRepo,
        has_content: probe.hasContent,
        detected_agent: probe.detectedAgent?.name ?? null,
        agent_surfaces: probe.detectedAgent ? describeAgentSurfaces(probe.detectedAgent.name) : [],
        nearby_stores: probe.nearbyStores.map((s) => ({ role: s.role, path: s.cwd, depth: s.depth })),
        suggested_project_type: probe.suggestedProjectType,
      },
      choices: {
        project_type: ['standalone', 'workspace', ...(probe.nearbyStores.some((s) => s.role === 'workspace') ? ['linked'] : [])],
        topology: ['embedded', 'sidecar'],
      },
    },
  };
}

/**
 * Generate a "moment aha" preview after init — shows what an agent
 * would see when calling bclaw_get_context on this project.
 */
export function buildOnboardingPreview(cwd: string): string {
  try {
    const state = loadState(cwd);
    const constraints = state.active_constraints.filter((c) => c.status === 'active');
    const traps = state.known_traps.filter((t) => t.visibility === 'shared' && (!t.status || t.status === 'active'));
    const plans = state.plan_items.filter((p) => p.status === 'in_progress' || p.status === 'todo');

    if (constraints.length === 0 && traps.length === 0 && plans.length === 0) {
      return resolveEmptyMemoryRecommendation(cwd).text;
    }

    const lines: string[] = ['Here is what your agent will see:'];
    if (constraints.length > 0) {
      lines.push(`  Constraints: ${constraints.length} active`);
      for (const c of constraints.slice(0, 3)) lines.push(`    - ${c.text}`);
    }
    if (traps.length > 0) {
      lines.push(`  Traps: ${traps.length} known`);
      for (const t of traps.slice(0, 3)) lines.push(`    - [${t.severity}] ${t.text}`);
    }
    if (plans.length > 0) {
      lines.push(`  Plans: ${plans.length} active`);
      for (const p of plans.slice(0, 3)) lines.push(`    - [${p.status}] ${p.text}`);
    }
    return lines.join('\n');
  } catch {
    return resolveEmptyMemoryRecommendation(cwd).text;
  }
}
