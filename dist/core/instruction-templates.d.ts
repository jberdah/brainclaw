/**
 * Adaptive instruction file templates — generates brainclaw section content
 * based on the agent's capability profile (tier A/B/C).
 *
 * Core (static) vs Run (dynamic) separation:
 *   Core: protocol, "why brainclaw", constraints, instructions, estimation rule
 *   Run:  traps, plans, decisions, claims, handoffs, runtime notes
 *
 * Tier A (MCP + hooks): lightweight — hooks inject run content automatically
 * Tier B (MCP, no hooks): directive — includes top traps, forces MCP calls
 * Tier C (no MCP): rich — includes plans, traps, decisions (only source)
 */
import type { AgentCapabilityProfile } from './agent-capability.js';
import type { State } from './schema.js';
export interface InstructionTemplateInput {
    profile: AgentCapabilityProfile;
    state: State;
    projectName: string;
    brainclawVersion: string;
    resolvedInstructions: string[];
    /** Maximum number of traps to include for tier B (default: 5) */
    maxTraps?: number;
    /** Maximum number of plans to include for tier C (default: 10) */
    maxPlans?: number;
}
export interface InstructionTemplateOutput {
    content: string;
    tier: 'A' | 'B' | 'C';
    sectionsIncluded: string[];
}
/**
 * Render the brainclaw section content for an instruction file,
 * adapted to the agent's capability profile.
 */
export declare function renderBrainclawSection(input: InstructionTemplateInput): InstructionTemplateOutput;
//# sourceMappingURL=instruction-templates.d.ts.map