/**
 * Project discovery — unified workspace inventory that composes existing
 * scan functions into a single structured profile.
 *
 * Boundary: discovery describes what exists in the workspace RIGHT NOW.
 * It is NOT canonical memory (decisions, traps, plans). It is NOT
 * machine profile (shells, SSH keys, WSL distros). It is the project-level
 * answer to "what MCP servers, skills, hooks, instruction files, and
 * agent integrations are available in this workspace?"
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentToolingContext } from './agent-context.js';
import { assessAgentIntegrationReadiness } from './agent-integrations.js';
import { loadConfig } from './config.js';
import { memoryDir } from './io.js';
import { nowISO } from './ids.js';
// --- Native instruction file discovery (extracted from bootstrap.ts) ---
const NATIVE_INSTRUCTION_FILES = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.windsurfrules',
    '.github/copilot-instructions.md',
];
const NATIVE_INSTRUCTION_DIRS = [
    '.cursor/rules',
    '.roo/rules',
    '.continue/rules',
    '.clinerules',
];
// MCP config files that agents use
const MCP_CONFIG_FILES = [
    '.mcp.json',
    'opencode.json',
    '.cursor/mcp.json',
    '.roo/mcp.json',
    '.continue/config.json',
];
// Hook config files
const HOOK_CONFIG_FILES = [
    '.claude/settings.local.json',
    '.cursor/rules/brainclaw-session.mdc',
];
export function buildProjectDiscovery(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    // 1. Agent tooling (AGENTS.md, skills, MCP servers)
    const agentTooling = buildAgentToolingContext({ cwd, env });
    // 2. Native instruction files
    const instructionFiles = discoverFiles(cwd, NATIVE_INSTRUCTION_FILES, NATIVE_INSTRUCTION_DIRS);
    // 3. MCP config files
    const mcpConfigs = discoverStaticFiles(cwd, MCP_CONFIG_FILES);
    // 4. Hook config files
    const hookConfigs = discoverStaticFiles(cwd, HOOK_CONFIG_FILES);
    // 5. Integration readiness
    let integrations = [];
    try {
        const config = loadConfig(cwd);
        integrations = assessAgentIntegrationReadiness(config, cwd, env);
    }
    catch {
        // config may not exist yet
    }
    const foundInstructions = instructionFiles.filter(f => f.exists);
    const foundMcpConfigs = mcpConfigs.filter(f => f.exists);
    const foundHookConfigs = hookConfigs.filter(f => f.exists);
    return {
        discovered_at: nowISO(),
        workspace_root: cwd,
        agent_tooling: agentTooling,
        instruction_files: foundInstructions,
        mcp_configs: foundMcpConfigs,
        hook_configs: foundHookConfigs,
        integrations,
        summary: {
            total_instruction_files: foundInstructions.length,
            total_mcp_servers: agentTooling.mcp_servers.length,
            total_skills: agentTooling.skills.length,
            total_mcp_configs: foundMcpConfigs.length,
            total_hook_configs: foundHookConfigs.length,
            integrations_ready: integrations.filter(i => i.ready).length,
            integrations_total: integrations.length,
        },
    };
}
// --- Persistence ---
const DISCOVERY_PROFILE_FILE = 'discovery-profile.json';
export function saveDiscoveryProfile(profile, cwd) {
    const dir = path.join(memoryDir(cwd), 'discovery');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, DISCOVERY_PROFILE_FILE);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
}
export function loadDiscoveryProfile(cwd) {
    const filePath = path.join(memoryDir(cwd), 'discovery', DISCOVERY_PROFILE_FILE);
    if (!fs.existsSync(filePath))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
// --- Rendering ---
export function renderDiscoverySummary(profile) {
    const lines = [];
    const s = profile.summary;
    lines.push('# Project Discovery');
    lines.push(`Discovered at: ${profile.discovered_at}`);
    lines.push('');
    // Instruction files
    if (profile.instruction_files.length > 0) {
        lines.push(`## Instruction Files (${s.total_instruction_files})`);
        for (const f of profile.instruction_files) {
            const managed = f.managed_by_brainclaw ? ' (managed)' : '';
            lines.push(`  ${f.path}${managed}`);
        }
        lines.push('');
    }
    // MCP configs
    if (profile.mcp_configs.length > 0) {
        lines.push(`## MCP Configs (${s.total_mcp_configs})`);
        for (const f of profile.mcp_configs) {
            lines.push(`  ${f.path}`);
        }
        lines.push('');
    }
    // MCP servers (from agent tooling)
    if (s.total_mcp_servers > 0) {
        lines.push(`## MCP Servers (${s.total_mcp_servers})`);
        for (const server of profile.agent_tooling.mcp_servers) {
            lines.push(`  ${server.name} (${server.transport}, ${server.availability})`);
        }
        lines.push('');
    }
    // Skills
    if (s.total_skills > 0) {
        lines.push(`## Skills (${s.total_skills})`);
        for (const skill of profile.agent_tooling.skills.slice(0, 10)) {
            lines.push(`  ${skill.name}${skill.description ? `: ${skill.description}` : ''}`);
        }
        if (s.total_skills > 10) {
            lines.push(`  ... and ${s.total_skills - 10} more`);
        }
        lines.push('');
    }
    // Hook configs
    if (profile.hook_configs.length > 0) {
        lines.push(`## Hook Configs (${s.total_hook_configs})`);
        for (const f of profile.hook_configs) {
            lines.push(`  ${f.path}`);
        }
        lines.push('');
    }
    // Integrations
    if (profile.integrations.length > 0) {
        lines.push(`## Agent Integrations (${s.integrations_ready}/${s.integrations_total} ready)`);
        for (const integ of profile.integrations) {
            const status = integ.ready ? '✔' : '✗';
            const missing = integ.missing_surfaces.length > 0
                ? ` — missing: ${integ.missing_surfaces.map(s => s.kind).join(', ')}`
                : '';
            lines.push(`  ${status} ${integ.agent_name}${missing}`);
        }
        lines.push('');
    }
    if (s.total_instruction_files + s.total_mcp_servers + s.total_skills === 0) {
        lines.push('No integration surfaces detected.');
    }
    return lines.join('\n');
}
// --- Helpers ---
function discoverStaticFiles(cwd, files) {
    const results = [];
    for (const relativePath of files) {
        const fullPath = path.join(cwd, relativePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const stat = fs.statSync(fullPath);
            results.push({
                path: relativePath,
                exists: true,
                size: stat.size,
                managed_by_brainclaw: isManagedByBrainclaw(fullPath),
            });
        }
    }
    return results;
}
function discoverFiles(cwd, files, dirs) {
    const results = [];
    for (const relativePath of files) {
        const fullPath = path.join(cwd, relativePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            results.push({
                path: relativePath,
                exists: true,
                size: fs.statSync(fullPath).size,
                managed_by_brainclaw: isManagedByBrainclaw(fullPath),
            });
        }
    }
    for (const relativeDir of dirs) {
        const dir = path.join(cwd, relativeDir);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
            continue;
        for (const entry of fs.readdirSync(dir).sort()) {
            if (!/\.(md|mdc)$/i.test(entry))
                continue;
            const relativePath = path.posix.join(relativeDir.replace(/\\/g, '/'), entry);
            const fullPath = path.join(cwd, relativePath);
            results.push({
                path: relativePath,
                exists: true,
                size: fs.statSync(fullPath).size,
                managed_by_brainclaw: isManagedByBrainclaw(fullPath),
            });
        }
    }
    return results;
}
function isManagedByBrainclaw(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 200);
        return content.includes('brainclaw') && (content.includes('Managed by brainclaw') ||
            content.includes('BRAINCLAW_SECTION') ||
            content.includes('brainclaw export'));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=project-discovery.js.map