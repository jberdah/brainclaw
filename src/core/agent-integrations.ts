import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentIntegrationDeclaration,
  AgentIntegrationDeclarationSource,
  AgentIntegrationName,
  AgentIntegrationSurface,
  Config,
} from './schema.js';

const SUPPORTED_AGENT_INTEGRATION_NAMES = new Set<AgentIntegrationName>([
  'github-copilot',
  'claude-code',
  'cursor',
  'windsurf',
  'cline',
  'codex',
  'continue',
  'roo',
]);

const DEFAULT_SURFACES: Record<AgentIntegrationName, AgentIntegrationSurface[]> = {
  'github-copilot': [
    { kind: 'instructions', location: 'workspace', path: '.github/copilot-instructions.md' },
    { kind: 'skill', location: 'workspace', path: '.github/skills/brainclaw-context/SKILL.md' },
  ],
  'claude-code': [
    { kind: 'instructions', location: 'workspace', path: 'CLAUDE.md' },
  ],
  'cursor': [
    { kind: 'instructions', location: 'workspace', path: '.cursor/rules/brainclaw.md' },
    { kind: 'rule', location: 'workspace', path: '.cursor/rules/brainclaw-mcp-shim.mdc' },
  ],
  'windsurf': [
    { kind: 'instructions', location: 'workspace', path: '.windsurfrules' },
    { kind: 'hook', location: 'workspace', path: '.windsurfrules' },
    { kind: 'mcp', location: 'machine', path: '.codeium/windsurf/mcp_config.json' },
  ],
  'cline': [
    { kind: 'instructions', location: 'workspace', path: '.clinerules/brainclaw.md' },
    { kind: 'mcp', location: 'workspace', path: '.vscode/cline_mcp_settings.json' },
  ],
  'codex': [
    { kind: 'instructions', location: 'workspace', path: 'AGENTS.md' },
  ],
  'continue': [
    { kind: 'instructions', location: 'workspace', path: '.continue/rules/brainclaw.md' },
  ],
  'roo': [
    { kind: 'instructions', location: 'workspace', path: '.roo/rules/brainclaw.md' },
  ],
};

function mergeSurfaces(current: AgentIntegrationSurface[], next: AgentIntegrationSurface[]): AgentIntegrationSurface[] {
  const merged = [...current];
  for (const candidate of next) {
    const exists = merged.some((surface) =>
      surface.kind === candidate.kind
      && surface.location === candidate.location
      && surface.path === candidate.path,
    );
    if (!exists) {
      merged.push(candidate);
    }
  }
  return merged;
}

export function buildAgentIntegrationDeclaration(
  agentName: AgentIntegrationName,
  declarationSource: AgentIntegrationDeclarationSource = 'manual',
): AgentIntegrationDeclaration {
  return {
    agent_name: agentName,
    declaration_source: declarationSource,
    surfaces: DEFAULT_SURFACES[agentName].map((surface) => ({ ...surface })),
  };
}

export function isAgentIntegrationName(value: string): value is AgentIntegrationName {
  return SUPPORTED_AGENT_INTEGRATION_NAMES.has(value as AgentIntegrationName);
}

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

function resolveDeclaredSurfacePath(surface: AgentIntegrationSurface, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!surface.path) {
    return undefined;
  }

  if (surface.location === 'workspace') {
    return path.join(cwd, surface.path);
  }

  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(homeDir, surface.path);
}

function surfaceExists(surface: AgentIntegrationSurface, cwd: string, env: NodeJS.ProcessEnv): AgentIntegrationSurfaceReadiness {
  const expectedPath = resolveDeclaredSurfacePath(surface, cwd, env);
  return {
    ...surface,
    expected_path: expectedPath,
    exists: expectedPath ? fs.existsSync(expectedPath) : false,
  };
}

export function assessAgentIntegrationReadiness(
  config: Config,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentIntegrationReadiness[] {
  return (config.agent_integrations?.declarations ?? []).map((declaration) => {
    const surfaces = declaration.surfaces.map((surface) => surfaceExists(surface, cwd, env));
    const missingSurfaces = surfaces.filter((surface) => !surface.exists);
    return {
      agent_name: declaration.agent_name,
      declaration_source: declaration.declaration_source,
      ready: missingSurfaces.length === 0,
      missing_surfaces: missingSurfaces,
      surfaces,
    };
  });
}

export function upsertAgentIntegrationDeclaration(
  config: Config,
  agentName: AgentIntegrationName,
  declarationSource: AgentIntegrationDeclarationSource = 'manual',
): boolean {
  const declarations = config.agent_integrations?.declarations ?? [];
  const existing = declarations.find((item) => item.agent_name === agentName);
  const next = buildAgentIntegrationDeclaration(agentName, declarationSource);

  if (!config.agent_integrations) {
    config.agent_integrations = { declarations: [] };
  }

  if (!existing) {
    config.agent_integrations.declarations.push(next);
    return true;
  }

  const mergedSurfaces = mergeSurfaces(existing.surfaces ?? [], next.surfaces);
  const mergedSource: AgentIntegrationDeclarationSource = existing.declaration_source === 'manual' || declarationSource === 'manual'
    ? 'manual'
    : 'detected';

  const changed = mergedSource !== existing.declaration_source
    || mergedSurfaces.length !== (existing.surfaces?.length ?? 0);

  existing.declaration_source = mergedSource;
  existing.surfaces = mergedSurfaces;
  return changed;
}