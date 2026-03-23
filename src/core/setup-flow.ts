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
import { memoryExists } from './io.js';
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

  // Has content?
  const IGNORED = new Set(['.git', '.brainclaw', '.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db']);
  let hasContent = false;
  try {
    const entries = fs.readdirSync(cwd);
    hasContent = entries.some((e) => !IGNORED.has(e));
  } catch {
    // empty or unreadable
  }

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
      return 'Memory is empty. Run bclaw_bootstrap to extract initial context from this repo.';
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
    return 'Memory is empty. Run bclaw_bootstrap to extract initial context from this repo.';
  }
}
