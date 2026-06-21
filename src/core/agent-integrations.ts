import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { getInstalledBrainclawVersion } from './brainclaw-version.js';
import { getAgentCapabilityProfile } from './agent-capability.js';
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
  'opencode',
  'antigravity',
  'continue',
  'roo',
  'kilocode',
  'mistral-vibe',
  'hermes',
  'openclaw',
  'nanoclaw',
  'nemoclaw',
  'picoclaw',
  'zeroclaw',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DEFAULT_SURFACES: Record<AgentIntegrationName, AgentIntegrationSurface[]> = {
  'github-copilot': [
    { kind: 'instructions', location: 'workspace', path: '.github/copilot-instructions.md' },
      { kind: 'hook',         location: 'workspace', path: '.github/copilot/hooks.json' },
      { kind: 'mcp',          location: 'workspace', path: '.vscode/settings.json' },
      { kind: 'skill',        location: 'workspace', path: '.github/skills/brainclaw-context/SKILL.md' },
      { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
    ],
    'claude-code': [
      { kind: 'instructions', location: 'workspace', path: 'CLAUDE.md' },
      { kind: 'hook',         location: 'machine',   path: '.claude/settings.local.json' },
      { kind: 'mcp',          location: 'workspace', path: '.mcp.json' },
      { kind: 'skill',        location: 'workspace', path: '.claude/commands/brainclaw.md' },
    ],
    'cursor': [
      { kind: 'instructions', location: 'workspace', path: '.cursor/rules/brainclaw.md' },
      { kind: 'rule',         location: 'workspace', path: '.cursor/rules/brainclaw-mcp-shim.mdc' },
      { kind: 'hook',         location: 'workspace', path: '.cursor/hooks.json' },
      { kind: 'mcp',          location: 'machine',   path: '.cursor/mcp.json' },
      { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
    ],
    'windsurf': [
      { kind: 'instructions', location: 'workspace', path: '.windsurfrules' },
      { kind: 'mcp',          location: 'machine',   path: '.codeium/windsurf/mcp_config.json' },
      { kind: 'rule',         location: 'workspace', path: '.windsurf/rules/brainclaw.md' },
    ],
    'cline': [
      { kind: 'instructions', location: 'workspace', path: '.clinerules/brainclaw.md' },
      { kind: 'mcp',          location: 'workspace', path: '.vscode/cline_mcp_settings.json' },
    ],
    'codex': [
      { kind: 'instructions', location: 'workspace', path: 'AGENTS.md' },
      { kind: 'mcp',          location: 'machine',   path: '.codex/config.toml' },
      { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
    ],
    'opencode': [
      { kind: 'instructions', location: 'workspace', path: 'AGENTS.md' },
      { kind: 'mcp',          location: 'workspace', path: 'opencode.json' },
      { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
    ],
  'antigravity': [
    { kind: 'instructions', location: 'workspace', path: 'GEMINI.md' },
    { kind: 'mcp',          location: 'machine',   path: '.gemini/antigravity/mcp_config.json' },
    { kind: 'hook',         location: 'machine',   path: '.gemini/antigravity/hooks.json' },
  ],
  'continue': [
    { kind: 'instructions', location: 'workspace', path: '.continue/rules/brainclaw.md' },
    { kind: 'mcp',          location: 'workspace', path: '.continue/config.json' },
    { kind: 'permissions',  location: 'machine',   path: '.continue/permissions.yaml' },
  ],
  'roo': [
    { kind: 'instructions', location: 'workspace', path: '.roo/rules/brainclaw.md' },
    { kind: 'mcp',          location: 'workspace', path: '.roo/mcp.json' },
    { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
  ],
  'kilocode': [
    { kind: 'instructions', location: 'workspace', path: '.kilo/rules/brainclaw.md' },
    { kind: 'mcp',          location: 'workspace', path: '.kilo/mcp.json' },
    { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
  ],
  'mistral-vibe': [
    { kind: 'instructions', location: 'workspace', path: 'AGENTS.md' },
    { kind: 'mcp',          location: 'workspace', path: '.vibe/config.toml' },
    { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
  ],
  'hermes': [
    { kind: 'instructions', location: 'workspace', path: 'AGENTS.md' },
    { kind: 'mcp',          location: 'machine',   path: '.hermes/config.yaml' },
    { kind: 'skill',        location: 'workspace', path: '.agents/skills/brainclaw/SKILL.md' },
  ],
  'openclaw': [
    { kind: 'skill', location: 'machine', path: '.openclaw/workspace/skills/brainclaw/SKILL.md' },
    { kind: 'mcp',   location: 'machine', path: '.openclaw/mcp.json' },
  ],
  'nanoclaw': [
    { kind: 'skill', location: 'workspace', path: 'skills/nanoclaw/SKILL.md' },
  ],
  'nemoclaw': [
    { kind: 'skill', location: 'workspace', path: 'skills/nemoclaw/SKILL.md' },
  ],
  'picoclaw': [
    { kind: 'skill', location: 'workspace', path: 'skills/picoclaw/SKILL.md' },
  ],
  'zeroclaw': [
    { kind: 'skill', location: 'workspace', path: 'skills/zeroclaw/SKILL.md' },
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
  drift_message?: string;
}

export type EffectiveTier = 'tier-a' | 'tier-b' | 'tier-c';

export interface AgentIntegrationReadiness {
  agent_name: AgentIntegrationName;
  declaration_source: AgentIntegrationDeclarationSource;
  ready: boolean;
  missing_surfaces: AgentIntegrationSurfaceReadiness[];
  drifting_surfaces: AgentIntegrationSurfaceReadiness[];
  surfaces: AgentIntegrationSurfaceReadiness[];
  effective_tier: EffectiveTier;
  self_healing_guidance: string[];
}

type CommandVersionProbe = (cmdPath: string, args?: string[]) => string | null;

let commandVersionProbeForTests: CommandVersionProbe | undefined;

export function setCommandVersionProbeForTests(probe?: CommandVersionProbe): void {
  commandVersionProbeForTests = probe;
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

export function extractMcpCommandVal(agentName: string, expectedPath: string): { command?: string; args?: string[]; is_valid: boolean } {
  let content: string;
  try {
    content = fs.readFileSync(expectedPath, 'utf-8');
  } catch {
    return { is_valid: false };
  }

  if (expectedPath.endsWith('.toml')) {
    const cmdMatch = content.match(/\[mcp_servers\.brainclaw\](?:[^[]*)command\s*=\s*(["'])(.+?)\1/is);
    const argsMatch = content.match(/\[mcp_servers\.brainclaw\](?:[^[]*)args\s*=\s*\[(.+?)\]/is);
    let args: string[] | undefined;
    if (argsMatch) {
      args = argsMatch[1]
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, '').replace(/\\\\/g, '\\'));
    }
    return {
      command: cmdMatch ? cmdMatch[2].replace(/\\\\/g, '\\') : undefined,
      args,
      is_valid: true,
    };
  }

  if (expectedPath.endsWith('.yaml') || expectedPath.endsWith('.yml')) {
    try {
      const parsed = yaml.parse(content);
      const root = isRecord(parsed) ? parsed : {};
      const servers = isRecord(root.mcp_servers) ? root.mcp_servers : {};
      const bc = isRecord(servers.brainclaw) ? servers.brainclaw : {};
      const cmd = bc.command;
      const args = bc.args;
      return {
        command: typeof cmd === 'string' ? cmd : undefined,
        args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : undefined,
        is_valid: true,
      };
    } catch {
      return { is_valid: false };
    }
  }

  try {
    const j = JSON.parse(content);
    let cmd: unknown;
    let args: unknown;

    if (agentName === 'github-copilot') {
      const mcpServers = j['github.copilot.chat.mcpServers'];
      cmd = mcpServers?.brainclaw?.command;
      args = mcpServers?.brainclaw?.args;
    } else if (agentName === 'continue') {
      const servers = Array.isArray(j.mcpServers) ? j.mcpServers : [];
      const bc = servers.find((s: Record<string, unknown>) => s && s.name === 'brainclaw');
      cmd = bc?.command;
      args = bc?.args;
    } else {
      cmd = j.mcpServers?.brainclaw?.command;
      args = j.mcpServers?.brainclaw?.args;
    }

    return { 
      command: typeof cmd === 'string' ? cmd : undefined, 
      args: Array.isArray(args) ? args.filter(a => typeof a === 'string') as string[] : undefined, 
      is_valid: true 
    };
  } catch {
    return { is_valid: false };
  }
}

function getCommandVersion(cmdPath: string, args?: string[]): string | null {
  if (commandVersionProbeForTests) {
    return commandVersionProbeForTests(cmdPath, args);
  }
  if (cmdPath === 'npx') return null; // dynamic
  try {
    const isNode = cmdPath.endsWith('node') || cmdPath.endsWith('node.exe');
    const spawnArgs = isNode && args && args[0] ? [args[0], '--version'] : ['--version'];
    const res = spawnSync(cmdPath, spawnArgs, { encoding: 'utf-8', timeout: 2000 });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  } catch {}
  return null;
}

function surfaceExists(surface: AgentIntegrationSurface, cwd: string, env: NodeJS.ProcessEnv, agentName?: string): AgentIntegrationSurfaceReadiness {
  const expectedPath = resolveDeclaredSurfacePath(surface, cwd, env);
  const exists = expectedPath ? fs.existsSync(expectedPath) : false;
  const result: AgentIntegrationSurfaceReadiness = {
    ...surface,
    expected_path: expectedPath,
    exists,
  };

  if (surface.kind === 'mcp' && exists && agentName && expectedPath) {
    const { command, args, is_valid } = extractMcpCommandVal(agentName, expectedPath);
    if (!is_valid) {
      result.drift_message = `MCP config file is invalid JSON/TOML`;
    } else if (!command) {
      result.drift_message = `MCP config file is missing 'brainclaw' command`;
    } else {
      if (command !== 'npx' && !fs.existsSync(command) && !['brainclaw', 'node'].includes(path.basename(command).replace(/\.exe$/, ''))) {
        result.drift_message = `MCP command points to a non-existent file: ${command}`;
      } else {
        const expectedVersion = getInstalledBrainclawVersion();
        const cmdVersion = getCommandVersion(command, args);
        if (cmdVersion && cmdVersion !== expectedVersion) {
          result.drift_message = `MCP command version drift (found ${cmdVersion}, expected ${expectedVersion})`;
        }
      }
    }
  }

  return result;
}

export function assessAgentIntegrationReadiness(
  config: Config,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentIntegrationReadiness[] {
  return (config.agent_integrations?.declarations ?? []).map((declaration) => {
    const surfaces = declaration.surfaces.map((surface) => surfaceExists(surface, cwd, env, declaration.agent_name));
    const missingSurfaces = surfaces.filter((surface) => !surface.exists);
    const driftingSurfaces = surfaces.filter((surface) => surface.drift_message != null);
      
      let effectiveTier: EffectiveTier;
      const selfHealingGuidance: string[] = [];
      
      const hasMissingMcpOrHook = missingSurfaces.some((s) => s.kind === 'mcp' || s.kind === 'hook');
      const hasDriftingMcp = driftingSurfaces.some((s) => s.kind === 'mcp');

      const profile = getAgentCapabilityProfile(declaration.agent_name);
      
      if (!profile) {
        effectiveTier = 'tier-c';
        selfHealingGuidance.push(`Agent ${declaration.agent_name} lacks a known capability profile. Defaulting to Tier C.`);
      } else {
        const isPrimaryTierA = profile.templateTier === 'A';
        if (isPrimaryTierA) {
          if (hasMissingMcpOrHook || hasDriftingMcp) {
            effectiveTier = 'tier-b';
            selfHealingGuidance.push(`Agent ${declaration.agent_name} is degraded to Tier B because MCP or hooks are missing/drifting. Run 'brainclaw doctor --fix' or check integrations.`);
          } else {
            effectiveTier = 'tier-a';
          }
        } else {
          effectiveTier = 'tier-b'; // Inherently Tier B because context relies on native rules
          if (hasMissingMcpOrHook || hasDriftingMcp) {
            selfHealingGuidance.push(`Agent ${declaration.agent_name} is missing or drifting MCP or hook configurations. Run 'brainclaw doctor --fix'.`);
          }
        }
      }

      if (missingSurfaces.length === surfaces.length && surfaces.length > 0) {
        effectiveTier = 'tier-c';
        selfHealingGuidance.push(`Agent ${declaration.agent_name} has no configured surfaces and is falling back to compact Tier C behavior.`);
      }

    return {
      agent_name: declaration.agent_name,
      declaration_source: declaration.declaration_source,
      ready: missingSurfaces.length === 0 && driftingSurfaces.length === 0,
      missing_surfaces: missingSurfaces,
      drifting_surfaces: driftingSurfaces,
      surfaces,
      effective_tier: effectiveTier,
      self_healing_guidance: selfHealingGuidance,
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
