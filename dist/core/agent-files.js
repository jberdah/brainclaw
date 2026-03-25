import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export const BRAINCLAW_SECTION_START = '<!-- brainclaw:start -->';
export const BRAINCLAW_SECTION_END = '<!-- brainclaw:end -->';
export function buildBrainclawSection(storageDir) {
    return `${BRAINCLAW_SECTION_START}
## Brainclaw — shared project memory

This project uses brainclaw for shared coordination between humans and agents.

### Session start (required)

1. Run \`brainclaw context\` to load shared state (constraints, decisions, traps, plans, handoffs)
2. Check **Your open work** for active claims and in-progress plans assigned to you
3. Respect active claims from other agents — check \`brainclaw claim list\` before editing a claimed scope

### Before finishing (required)

1. Release claims you opened: \`brainclaw claim release <id>\` — or \`brainclaw session-end --auto-release\`
2. Update completed plan items: \`brainclaw plan update <id> --status done\`

### Recording work

\`\`\`bash
brainclaw memory create decision "<text>"          # record a decision
brainclaw memory create constraint "<text>"        # record an active constraint
brainclaw memory create trap "<text>"              # record a known trap
brainclaw claim create "<text>" --scope <path>     # claim a scope before editing
brainclaw plan create "<text>"                     # add a shared work item
\`\`\`

Memory is stored in \`${storageDir}/\`. Run \`brainclaw doctor\` to verify health.
${BRAINCLAW_SECTION_END}`;
}
export function buildHygieneSection() {
    return `## Brainclaw — required coordination

Before starting work:
1. Run \`brainclaw context\` (or \`brainclaw context --json\`) to load shared memory
2. Run \`brainclaw claim list\` — do not edit a file claimed by another agent
3. Create a plan for significant work: \`brainclaw plan create "<description>"\`
4. Claim files you will modify: \`brainclaw claim create "<description>" --scope <path>\`

Before finishing:
1. Run \`brainclaw session-end --auto-release\` — releases claims and updates plans
2. Or manually: \`brainclaw claim release <id>\` and \`brainclaw plan update <id> --status done\``;
}
export function hasBrainclawSection(content) {
    return content.includes(BRAINCLAW_SECTION_START) && content.includes(BRAINCLAW_SECTION_END);
}
export function upsertBrainclawSection(existingContent, section) {
    const start = existingContent.indexOf(BRAINCLAW_SECTION_START);
    const end = existingContent.indexOf(BRAINCLAW_SECTION_END);
    if (start !== -1 && end !== -1) {
        const before = existingContent.slice(0, start);
        const after = existingContent.slice(end + BRAINCLAW_SECTION_END.length);
        return before + section + after;
    }
    const trimmed = existingContent.trimEnd();
    return trimmed.length > 0 ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}
export function ensureAgentFiles(cwd, storageDir, options = {}) {
    const section = buildBrainclawSection(storageDir);
    const result = {
        agentsMdCreated: false,
        agentsMdUpdated: false,
        copilotInstructionsCreated: false,
        copilotInstructionsUpdated: false,
    };
    // AGENTS.md
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    const agentsMdExists = fs.existsSync(agentsMdPath);
    if (!options.onlyExisting || agentsMdExists) {
        const agentsMdContent = agentsMdExists
            ? fs.readFileSync(agentsMdPath, 'utf-8')
            : '# AGENTS\n\nProject guidelines for AI coding agents.\n';
        if (!options.requireExistingSection || !agentsMdExists || hasBrainclawSection(agentsMdContent)) {
            const newAgentsMd = upsertBrainclawSection(agentsMdContent, section);
            if (newAgentsMd !== agentsMdContent) {
                fs.writeFileSync(agentsMdPath, newAgentsMd, 'utf-8');
                if (agentsMdExists) {
                    result.agentsMdUpdated = true;
                }
                else {
                    result.agentsMdCreated = true;
                }
            }
        }
    }
    // .github/copilot-instructions.md
    const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
    const copilotExists = fs.existsSync(copilotPath);
    if (!options.onlyExisting || copilotExists) {
        const copilotContent = copilotExists
            ? fs.readFileSync(copilotPath, 'utf-8')
            : '# Copilot Instructions\n';
        if (!options.requireExistingSection || !copilotExists || hasBrainclawSection(copilotContent)) {
            if (!copilotExists) {
                fs.mkdirSync(path.dirname(copilotPath), { recursive: true });
            }
            const newCopilot = upsertBrainclawSection(copilotContent, section);
            if (newCopilot !== copilotContent) {
                fs.writeFileSync(copilotPath, newCopilot, 'utf-8');
                if (copilotExists) {
                    result.copilotInstructionsUpdated = true;
                }
                else {
                    result.copilotInstructionsCreated = true;
                }
            }
        }
    }
    return result;
}
export function ensureGitignoreEntries(cwd, entries) {
    const gitignorePath = path.join(cwd, '.gitignore');
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const toAdd = entries.filter((e) => !lines.has(e));
    if (toAdd.length === 0)
        return;
    const separator = current.trimEnd().length > 0 ? '\n' : '';
    const next = `${current.trimEnd()}${separator}\n# Agent instruction files (generated by brainclaw)\n${toAdd.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, next, 'utf-8');
}
export function collectWorkspaceGitignoreEntries(cwd, results) {
    const workspaceRoot = path.resolve(cwd);
    const collected = new Set();
    for (const result of results) {
        if (!result.relativePath)
            continue;
        if (result.relativePath === 'package.json')
            continue;
        const expectedWorkspacePath = path.resolve(workspaceRoot, result.relativePath);
        const actualPath = path.resolve(result.filePath);
        if (actualPath !== expectedWorkspacePath)
            continue;
        collected.add(result.relativePath.replace(/\\/g, '/'));
    }
    return [...collected];
}
export function collectExportGitignoreEntries(cwd, targetRelativePath, results, options = {}) {
    const collected = new Set();
    if (options.includeTarget !== false) {
        collected.add(targetRelativePath.replace(/\\/g, '/'));
    }
    for (const entry of collectWorkspaceGitignoreEntries(cwd, results)) {
        collected.add(entry);
    }
    return [...collected];
}
export const AGENT_EXPORT_REGISTRY = [
    { agentName: 'github-copilot', format: 'copilot-instructions', relativePath: '.github/copilot-instructions.md' },
    { agentName: 'claude-code', format: 'claude-md', relativePath: 'CLAUDE.md' },
    { agentName: 'cursor', format: 'cursor-rules', relativePath: '.cursor/rules/brainclaw.md' },
    { agentName: 'windsurf', format: 'windsurf', relativePath: '.windsurfrules' },
    { agentName: 'cline', format: 'cline', relativePath: '.clinerules/brainclaw.md' },
    { agentName: 'codex', format: 'agents-md', relativePath: 'AGENTS.md' },
    { agentName: 'continue', format: 'continue', relativePath: '.continue/rules/brainclaw.md' },
    { agentName: 'roo', format: 'roo', relativePath: '.roo/rules/brainclaw.md' },
    { agentName: 'opencode', format: 'agents-md', relativePath: 'AGENTS.md' },
    { agentName: 'antigravity', format: 'gemini-md', relativePath: 'GEMINI.md' },
];
export const FALLBACK_EXPORT_TARGET = {
    agentName: 'unknown',
    format: 'agents-md',
    relativePath: 'AGENTS.md',
};
export function resolveExportTarget(agentName) {
    return AGENT_EXPORT_REGISTRY.find((t) => t.agentName === agentName) ?? FALLBACK_EXPORT_TARGET;
}
export function resolveExportTargetByFormat(format) {
    return AGENT_EXPORT_REGISTRY.find((t) => t.format === format) ?? FALLBACK_EXPORT_TARGET;
}
export function writeExportFile(content, relativePath, cwd) {
    const fullPath = path.join(cwd, relativePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(fullPath);
    const section = `${BRAINCLAW_SECTION_START}\n${content}\n${BRAINCLAW_SECTION_END}`;
    const existing = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
    const next = upsertBrainclawSection(existing, section);
    if (next === existing) {
        return { created: false, updated: false, filePath: fullPath };
    }
    fs.writeFileSync(fullPath, next, 'utf-8');
    return { created: !existed, updated: existed, filePath: fullPath };
}
const ALL_BCLAW_TOOLS = [
    'bclaw_get_context', 'bclaw_bootstrap', 'bclaw_get_execution_context',
    'bclaw_read_handoff', 'bclaw_get_agent_board', 'bclaw_search', 'bclaw_estimation_report',
    'bclaw_list_plans', 'bclaw_list_claims', 'bclaw_list_agents', 'bclaw_list_instructions', 'bclaw_list_candidates',
    'bclaw_write_note', 'bclaw_create_candidate', 'bclaw_accept', 'bclaw_reject',
    'bclaw_claim', 'bclaw_release_claim', 'bclaw_session_start', 'bclaw_session_end',
    'bclaw_create_plan', 'bclaw_update_plan', 'bclaw_add_step', 'bclaw_complete_step',
];
const CLINE_MCP_RELATIVE_PATH = '.vscode/cline_mcp_settings.json';
const CURSOR_MDC_RELATIVE_PATH = '.cursor/rules/brainclaw-mcp-shim.mdc';
const COPILOT_SKILL_RELATIVE_PATH = '.github/skills/brainclaw-context/SKILL.md';
const WINDSURF_MCP_RELATIVE_PATH = '.codeium/windsurf/mcp_config.json';
const CLAUDE_CODE_MCP_RELATIVE_PATH = '.mcp.json';
const CLAUDE_CODE_COMMAND_RELATIVE_PATH = '.claude/commands/brainclaw.md';
const CLAUDE_CODE_SETTINGS_RELATIVE_PATH = '.claude/settings.local.json';
const CLAUDE_CODE_SESSION_MARKER_RELATIVE_PATH = '.claude/.bclaw-session';
const CURSOR_MCP_RELATIVE_PATH = '.cursor/mcp.json';
const ROO_MCP_RELATIVE_PATH = '.roo/mcp.json';
const CONTINUE_CONFIG_RELATIVE_PATH = '.continue/config.json';
const OPENCODE_CONFIG_RELATIVE_PATH = 'opencode.json';
const ANTIGRAVITY_MCP_RELATIVE_PATH = '.gemini/antigravity/mcp_config.json';
export const LOCAL_ONLY_AGENT_WORKSPACE_FILES = [
    CLINE_MCP_RELATIVE_PATH,
    CURSOR_MDC_RELATIVE_PATH,
    COPILOT_SKILL_RELATIVE_PATH,
    CLAUDE_CODE_MCP_RELATIVE_PATH,
    CLAUDE_CODE_COMMAND_RELATIVE_PATH,
    CLAUDE_CODE_SETTINGS_RELATIVE_PATH,
    CLAUDE_CODE_SESSION_MARKER_RELATIVE_PATH,
    ROO_MCP_RELATIVE_PATH,
    CONTINUE_CONFIG_RELATIVE_PATH,
    OPENCODE_CONFIG_RELATIVE_PATH,
];
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readJsonObject(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return isJsonObject(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function writeTextFileIfChanged(filePath, content) {
    const existed = fs.existsSync(filePath);
    const current = existed ? fs.readFileSync(filePath, 'utf-8') : undefined;
    if (current === content) {
        return { created: false, updated: false };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { created: !existed, updated: existed };
}
function writeJsonFileIfChanged(filePath, next) {
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    return writeTextFileIfChanged(filePath, serialized);
}
function resolveHomeDir(env) {
    return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}
function runGit(cwd, args, input) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf-8',
        input,
    });
    if (result.status !== 0) {
        return {
            ok: false,
            stdout: result.stdout ?? '',
        };
    }
    return {
        ok: true,
        stdout: result.stdout ?? '',
    };
}
export function auditLocalAgentWorkspaceFiles(cwd) {
    const auditedPaths = [...LOCAL_ONLY_AGENT_WORKSPACE_FILES];
    const presentPaths = auditedPaths
        .filter((relativePath) => fs.existsSync(path.join(cwd, relativePath)))
        .map((relativePath) => relativePath.replace(/\\/g, '/'));
    const gitRepoCheck = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!gitRepoCheck.ok || gitRepoCheck.stdout.trim() !== 'true') {
        return {
            isGitRepo: false,
            auditedPaths,
            presentPaths,
            ignoredPaths: [],
            missingGitignorePaths: [],
            trackedPaths: [],
            hasIssues: false,
        };
    }
    if (presentPaths.length === 0) {
        return {
            isGitRepo: true,
            auditedPaths,
            presentPaths,
            ignoredPaths: [],
            missingGitignorePaths: [],
            trackedPaths: [],
            hasIssues: false,
        };
    }
    const ignoredResult = runGit(cwd, ['check-ignore', '--no-index', '--stdin'], `${presentPaths.join('\n')}\n`);
    const ignoredPaths = ignoredResult.ok
        ? ignoredResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        : [];
    const ignoredSet = new Set(ignoredPaths);
    const trackedResult = runGit(cwd, ['ls-files', '--', ...presentPaths]);
    const trackedPaths = trackedResult.ok
        ? trackedResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/\\/g, '/'))
        : [];
    const missingGitignorePaths = presentPaths.filter((relativePath) => !ignoredSet.has(relativePath));
    return {
        isGitRepo: true,
        auditedPaths,
        presentPaths,
        ignoredPaths,
        missingGitignorePaths,
        trackedPaths,
        hasIssues: missingGitignorePaths.length > 0 || trackedPaths.length > 0,
    };
}
export function describeAutoConfigWrite(result) {
    if (!result.created && !result.updated) {
        return undefined;
    }
    const verb = result.created ? 'Created' : 'Updated';
    const displayPath = result.relativePath ?? result.filePath;
    return `✔ ${verb} ${result.label} at ${displayPath}`;
}
export function buildClaudeCodeCommandText() {
    return `Load brainclaw project memory and prepare for coordinated work.

Steps:
1. Run \`brainclaw context --json\` — load constraints, decisions, traps, plans, handoffs
2. Run \`brainclaw claim list\` — check what files other agents have claimed
3. Before editing any file, run \`brainclaw claim create "<description>" --scope <path>\`
4. Before finishing, run \`brainclaw session-end --auto-release\`
`;
}
export function ensureClineMcpConfig(cwd) {
    const filePath = path.join(cwd, '.vscode', 'cline_mcp_settings.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
        disabled: false,
        autoApprove: ALL_BCLAW_TOOLS,
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Cline MCP settings',
        created,
        updated,
        filePath,
        relativePath: CLINE_MCP_RELATIVE_PATH,
    };
}
export function ensureWindsurfMcpConfig(homeDir) {
    if (!homeDir) {
        return undefined;
    }
    const filePath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Windsurf MCP settings',
        created,
        updated,
        filePath,
        relativePath: WINDSURF_MCP_RELATIVE_PATH,
    };
}
export function ensureCopilotSkill(cwd) {
    const filePath = path.join(cwd, '.github', 'skills', 'brainclaw-context', 'SKILL.md');
    const content = `---
name: brainclaw-context
description: "Use this skill when you need the latest Brainclaw context, active plans, constraints, traps, or handoffs before coding. Trigger phrases: refresh project memory, load brainclaw context, inspect active plans, inspect constraints."
---

# Brainclaw Context

Use this skill to fetch live project memory before significant edits or when asked about repository rules.

## Steps

1. Run \`brainclaw context --json\`.
2. Read active plans, constraints, decisions, traps, and handoffs from the result.
3. Prefer Brainclaw state over stale assumptions from older instructions or prior sessions.
`;
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return {
        kind: 'skill',
        label: 'Copilot Brainclaw skill',
        created,
        updated,
        filePath,
        relativePath: COPILOT_SKILL_RELATIVE_PATH,
    };
}
export function ensureCursorMdc(cwd) {
    const filePath = path.join(cwd, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc');
    const content = `---
description: Use this rule when work depends on live Brainclaw memory or active project rules.
globs: "**/*"
alwaysApply: true
---

Before significant edits or when asked about project rules, run:
<run_command>
brainclaw context --json
</run_command>

If Brainclaw reports active claims or in-progress plans, follow them before editing.
`;
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return {
        kind: 'rule',
        label: 'Cursor imperative Brainclaw rule',
        created,
        updated,
        filePath,
        relativePath: CURSOR_MDC_RELATIVE_PATH,
    };
}
function buildCommandHookEntry(command) {
    return {
        matcher: '',
        hooks: [{ type: 'command', command }],
    };
}
function buildMatchedCommandHookEntry(matcher, command) {
    return {
        matcher,
        hooks: [{ type: 'command', command }],
    };
}
function containsCommandHook(entries, command) {
    return entries.some((entry) => isJsonObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => isJsonObject(h) && h.command === command));
}
export function ensureProjectDevDependency(cwd) {
    const filePath = path.join(cwd, 'package.json');
    if (!fs.existsSync(filePath))
        return undefined;
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return undefined;
    }
    // Skip if this IS the brainclaw package itself
    if (pkg.name === 'brainclaw')
        return undefined;
    const devDeps = isJsonObject(pkg.devDependencies) ? { ...pkg.devDependencies } : {};
    if (devDeps['brainclaw'])
        return undefined;
    devDeps['brainclaw'] = 'latest';
    const next = { ...pkg, devDependencies: devDeps };
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    return {
        kind: 'rule',
        label: 'brainclaw devDependency (enables npx brainclaw without global PATH)',
        created: true,
        updated: false,
        filePath,
        relativePath: 'package.json',
    };
}
export function ensureClaudeCodeMcpConfig(cwd) {
    const filePath = path.join(cwd, '.mcp.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Claude Code MCP server',
        created,
        updated,
        filePath,
        relativePath: CLAUDE_CODE_MCP_RELATIVE_PATH,
    };
}
export function ensureClaudeCodeCommand(cwd) {
    const filePath = path.join(cwd, '.claude', 'commands', 'brainclaw.md');
    const content = buildClaudeCodeCommandText();
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return {
        kind: 'skill',
        label: 'Claude Code brainclaw command',
        created,
        updated,
        filePath,
        relativePath: CLAUDE_CODE_COMMAND_RELATIVE_PATH,
    };
}
export function ensureClaudeCodeUserSettings(homeDir, env = process.env) {
    if (!homeDir)
        return undefined;
    const filePath = path.join(homeDir, '.claude', 'settings.json');
    const existing = readJsonObject(filePath);
    // MCP server
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
    };
    // Permissions
    const permissions = isJsonObject(existing.permissions) ? { ...existing.permissions } : {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
    if (!allow.includes('Bash(npx brainclaw:*)'))
        allow.push('Bash(npx brainclaw:*)');
    if (!allow.includes('mcp__brainclaw__*'))
        allow.push('mcp__brainclaw__*');
    permissions.allow = allow;
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
        permissions,
    });
    return {
        kind: 'mcp',
        label: 'Claude Code user settings — MCP + permissions (global, all projects)',
        created,
        updated,
        filePath,
    };
}
export function ensureClaudeCodeUserCommand(homeDir) {
    if (!homeDir)
        return undefined;
    const filePath = path.join(homeDir, '.claude', 'commands', 'brainclaw.md');
    const content = buildClaudeCodeCommandText();
    const { created, updated } = writeTextFileIfChanged(filePath, content);
    return {
        kind: 'skill',
        label: 'Claude Code brainclaw command (global, all projects)',
        created,
        updated,
        filePath,
    };
}
export function ensureClaudeCodeSettings(cwd) {
    const filePath = path.join(cwd, '.claude', 'settings.local.json');
    const existing = readJsonObject(filePath);
    // Merge permissions.allow
    const permissions = isJsonObject(existing.permissions) ? { ...existing.permissions } : {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
    if (!allow.includes('Bash(npx brainclaw:*)')) {
        allow.push('Bash(npx brainclaw:*)');
    }
    if (!allow.includes('mcp__brainclaw__*')) {
        allow.push('mcp__brainclaw__*');
    }
    permissions.allow = allow;
    // Merge hooks — UserPromptSubmit injects full context on first prompt, diff on subsequent
    const hooks = isJsonObject(existing.hooks) ? { ...existing.hooks } : {};
    const contextCommand = 'f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; npx brainclaw context 2>/dev/null; else npx brainclaw context-diff 2>/dev/null; fi';
    const stopCommand = 'rm -f .claude/.bclaw-session; npx brainclaw session-end --auto-release --dry-run 2>/dev/null';
    const userPromptHooks = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
    if (!containsCommandHook(userPromptHooks, contextCommand)) {
        userPromptHooks.push(buildCommandHookEntry(contextCommand));
    }
    hooks.UserPromptSubmit = userPromptHooks;
    const stopHooks = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
    if (!containsCommandHook(stopHooks, stopCommand)) {
        stopHooks.push(buildCommandHookEntry(stopCommand));
    }
    hooks.Stop = stopHooks;
    // PostToolUse — check for unseen events after any brainclaw MCP tool call
    const checkEventsCommand = 'npx brainclaw check-events 2>/dev/null';
    const postToolHooks = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse] : [];
    if (!containsCommandHook(postToolHooks, checkEventsCommand)) {
        postToolHooks.push(buildMatchedCommandHookEntry('mcp__brainclaw__', checkEventsCommand));
    }
    hooks.PostToolUse = postToolHooks;
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        permissions,
        hooks,
    });
    return {
        kind: 'rule',
        label: 'Claude Code settings (permissions + session hooks)',
        created,
        updated,
        filePath,
        relativePath: CLAUDE_CODE_SETTINGS_RELATIVE_PATH,
    };
}
export function ensureCursorMcpConfig(homeDir) {
    if (!homeDir) {
        return undefined;
    }
    const filePath = path.join(homeDir, '.cursor', 'mcp.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Cursor MCP settings',
        created,
        updated,
        filePath,
        relativePath: CURSOR_MCP_RELATIVE_PATH,
    };
}
export function ensureRooMcpConfig(cwd) {
    const filePath = path.join(cwd, '.roo', 'mcp.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
        alwaysAllow: ALL_BCLAW_TOOLS,
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Roo Code MCP settings',
        created,
        updated,
        filePath,
        relativePath: ROO_MCP_RELATIVE_PATH,
    };
}
export function ensureCodexMcpConfig(homeDir, env = process.env) {
    const codexHome = env.CODEX_HOME?.trim() || (homeDir ? path.join(homeDir, '.codex') : null);
    if (!codexHome)
        return null;
    const filePath = path.join(codexHome, 'config.toml');
    const brainclawBlock = [
        '\n[mcp_servers.brainclaw]',
        'command = "npx"',
        'args = ["brainclaw", "mcp"]',
    ].join('\n');
    let existing = '';
    let fileExisted = false;
    if (fs.existsSync(filePath)) {
        existing = fs.readFileSync(filePath, 'utf-8');
        fileExisted = true;
    }
    if (existing.includes('[mcp_servers.brainclaw]')) {
        return { kind: 'mcp', label: 'Codex MCP config', created: false, updated: false, filePath };
    }
    const newContent = existing + brainclawBlock + '\n';
    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return {
        kind: 'mcp',
        label: 'Codex MCP config',
        created: !fileExisted,
        updated: fileExisted,
        filePath,
    };
}
export function ensureContinueMcpConfig(cwd) {
    const filePath = path.join(cwd, '.continue', 'config.json');
    const existing = readJsonObject(filePath);
    // Continue uses an array for mcpServers, not a keyed object
    const mcpServers = Array.isArray(existing.mcpServers) ? [...existing.mcpServers] : [];
    const alreadyPresent = mcpServers.some((entry) => isJsonObject(entry) && entry.name === 'brainclaw');
    if (!alreadyPresent) {
        mcpServers.push({ name: 'brainclaw', command: 'npx', args: ['brainclaw', 'mcp'] });
    }
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Continue MCP settings',
        created,
        updated,
        filePath,
        relativePath: CONTINUE_CONFIG_RELATIVE_PATH,
    };
}
export function ensureContinueUserMcpConfig(homeDir) {
    if (!homeDir)
        return undefined;
    const filePath = path.join(homeDir, '.continue', 'config.json');
    const existing = readJsonObject(filePath);
    const mcpServers = Array.isArray(existing.mcpServers) ? [...existing.mcpServers] : [];
    const alreadyPresent = mcpServers.some((entry) => isJsonObject(entry) && entry.name === 'brainclaw');
    if (!alreadyPresent) {
        mcpServers.push({ name: 'brainclaw', command: 'npx', args: ['brainclaw', 'mcp'] });
    }
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Continue MCP settings (global, all projects)',
        created,
        updated,
        filePath,
    };
}
export function ensureOpenCodeMcpConfig(cwd) {
    const filePath = path.join(cwd, 'opencode.json');
    const existing = readJsonObject(filePath);
    const mcp = isJsonObject(existing.mcp) ? { ...existing.mcp } : {};
    mcp.brainclaw = {
        type: 'local',
        command: ['npx', 'brainclaw', 'mcp'],
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcp,
    });
    return {
        kind: 'mcp',
        label: 'OpenCode MCP config',
        created,
        updated,
        filePath,
        relativePath: OPENCODE_CONFIG_RELATIVE_PATH,
    };
}
export function ensureAntigravityMcpConfig(homeDir) {
    if (!homeDir) {
        return undefined;
    }
    const filePath = path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
    const existing = readJsonObject(filePath);
    const mcpServers = isJsonObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
    mcpServers.brainclaw = {
        command: 'npx',
        args: ['brainclaw', 'mcp'],
    };
    const { created, updated } = writeJsonFileIfChanged(filePath, {
        ...existing,
        mcpServers,
    });
    return {
        kind: 'mcp',
        label: 'Antigravity MCP config',
        created,
        updated,
        filePath,
        relativePath: ANTIGRAVITY_MCP_RELATIVE_PATH,
    };
}
export function writeDetectedAgentAutoConfig(agentName, cwd, env = process.env) {
    switch (agentName) {
        case 'claude-code': {
            const results = [
                ensureClaudeCodeMcpConfig(cwd),
                ensureClaudeCodeCommand(cwd),
                ensureClaudeCodeSettings(cwd),
            ];
            const userSettings = ensureClaudeCodeUserSettings(resolveHomeDir(env));
            if (userSettings)
                results.push(userSettings);
            const userCmd = ensureClaudeCodeUserCommand(resolveHomeDir(env));
            if (userCmd)
                results.push(userCmd);
            const dep = ensureProjectDevDependency(cwd);
            if (dep)
                results.push(dep);
            return results;
        }
        case 'cline':
            return [ensureClineMcpConfig(cwd)];
        case 'windsurf': {
            const result = ensureWindsurfMcpConfig(resolveHomeDir(env));
            return result ? [result] : [];
        }
        case 'github-copilot':
            return [ensureCopilotSkill(cwd)];
        case 'cursor': {
            const results = [ensureCursorMdc(cwd)];
            const mcp = ensureCursorMcpConfig(resolveHomeDir(env));
            if (mcp)
                results.push(mcp);
            return results;
        }
        case 'roo':
            return [ensureRooMcpConfig(cwd)];
        case 'codex': {
            const result = ensureCodexMcpConfig(resolveHomeDir(env), env);
            return result ? [result] : [];
        }
        case 'continue': {
            const results = [ensureContinueMcpConfig(cwd)];
            const userMcp = ensureContinueUserMcpConfig(resolveHomeDir(env));
            if (userMcp)
                results.push(userMcp);
            return results;
        }
        case 'opencode':
            return [ensureOpenCodeMcpConfig(cwd)];
        case 'antigravity': {
            const result = ensureAntigravityMcpConfig(resolveHomeDir(env));
            return result ? [result] : [];
        }
        default:
            return [];
    }
}
export function writeExportCompanionFiles(format, cwd, env = process.env) {
    switch (format) {
        case 'claude-md': {
            const results = [
                ensureClaudeCodeMcpConfig(cwd),
                ensureClaudeCodeCommand(cwd),
                ensureClaudeCodeSettings(cwd),
            ];
            const userSettings = ensureClaudeCodeUserSettings(resolveHomeDir(env));
            if (userSettings)
                results.push(userSettings);
            const userCmd = ensureClaudeCodeUserCommand(resolveHomeDir(env));
            if (userCmd)
                results.push(userCmd);
            const dep = ensureProjectDevDependency(cwd);
            if (dep)
                results.push(dep);
            return results;
        }
        case 'cline':
            return [ensureClineMcpConfig(cwd)];
        case 'windsurf': {
            const result = ensureWindsurfMcpConfig(resolveHomeDir(env));
            return result ? [result] : [];
        }
        case 'copilot-instructions':
            return [ensureCopilotSkill(cwd)];
        case 'cursor-rules': {
            const results = [ensureCursorMdc(cwd)];
            const mcp = ensureCursorMcpConfig(resolveHomeDir(env));
            if (mcp)
                results.push(mcp);
            return results;
        }
        case 'roo':
            return [ensureRooMcpConfig(cwd)];
        case 'continue': {
            const results = [ensureContinueMcpConfig(cwd)];
            const userMcp = ensureContinueUserMcpConfig(resolveHomeDir(env));
            if (userMcp)
                results.push(userMcp);
            return results;
        }
        case 'gemini-md': {
            const result = ensureAntigravityMcpConfig(resolveHomeDir(env));
            return result ? [result] : [];
        }
        default:
            return [];
    }
}
//# sourceMappingURL=agent-files.js.map