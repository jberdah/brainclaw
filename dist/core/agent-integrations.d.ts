import type { AgentIntegrationDeclaration, AgentIntegrationDeclarationSource, AgentIntegrationName, AgentIntegrationSurface, Config } from './schema.js';
export declare function buildAgentIntegrationDeclaration(agentName: AgentIntegrationName, declarationSource?: AgentIntegrationDeclarationSource): AgentIntegrationDeclaration;
export declare function isAgentIntegrationName(value: string): value is AgentIntegrationName;
export interface AgentIntegrationSurfaceReadiness extends AgentIntegrationSurface {
    expected_path?: string;
    exists: boolean;
}
export interface AgentIntegrationReadiness {
    agent_name: AgentIntegrationName;
    declaration_source: AgentIntegrationDeclarationSource;
    ready: boolean;
    missing_surfaces: AgentIntegrationSurfaceReadiness[];
    surfaces: AgentIntegrationSurfaceReadiness[];
}
export declare function assessAgentIntegrationReadiness(config: Config, cwd: string, env?: NodeJS.ProcessEnv): AgentIntegrationReadiness[];
export declare function upsertAgentIntegrationDeclaration(config: Config, agentName: AgentIntegrationName, declarationSource?: AgentIntegrationDeclarationSource): boolean;
//# sourceMappingURL=agent-integrations.d.ts.map