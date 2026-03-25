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
import { type StoreRef } from './store-resolution.js';
import { type AgentCapabilityProfile } from './agent-capability.js';
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
    detectedAgent: {
        name: string;
        profile: AgentCapabilityProfile;
    } | undefined;
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
export declare function probeForQuickSetup(cwd?: string): QuickSetupProbe;
export type ProjectTypeChoice = 'standalone' | 'workspace' | 'linked';
export type TopologyChoice = 'embedded' | 'sidecar';
export interface QuickSetupChoices {
    projectType: ProjectTypeChoice;
    topology: TopologyChoice;
    linkTo?: string;
}
/**
 * Build the structured response for the initial probe step of quick setup.
 * Returns data the agent can use to present choices to the user.
 */
export declare function buildQuickSetupProbeResponse(probe: QuickSetupProbe): {
    text: string;
    structured: Record<string, unknown>;
};
/**
 * Generate a "moment aha" preview after init — shows what an agent
 * would see when calling bclaw_get_context on this project.
 */
export declare function buildOnboardingPreview(cwd: string): string;
//# sourceMappingURL=setup-flow.d.ts.map