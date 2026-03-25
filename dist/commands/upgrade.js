import fs from 'node:fs';
import path from 'node:path';
import { ensureMemoryDir, memoryDir, memoryExists } from '../core/io.js';
import { loadState, persistState } from '../core/state.js';
import { scanMigrationStatus } from '../core/migration.js';
import { commitMemoryChange, initMemoryRepo } from '../core/memory-git.js';
import { BRAINCLAW_SECTION_END, BRAINCLAW_SECTION_START, buildBrainclawSection, buildClaudeCodeCommandText, ensureClaudeCodeCommand, hasBrainclawSection, } from '../core/agent-files.js';
import { loadConfig } from '../core/config.js';
import { renderAgentExportForAgent, writeAgentExportForAgent } from './export.js';
import { generateCursorHook, writeHook } from './hooks.js';
/**
 * Entity directory layout mapping: legacy flat name → entity-aligned path.
 * Must match ENTITY_DIR_MAP in io.ts.
 */
const ENTITY_DIRS = [
    { legacy: 'constraints', entity: 'memory/constraints' },
    { legacy: 'decisions', entity: 'memory/decisions' },
    { legacy: 'traps', entity: 'memory/traps' },
    { legacy: 'instructions', entity: 'memory/instructions' },
    { legacy: 'plans', entity: 'coordination/plans' },
    { legacy: 'claims', entity: 'coordination/claims' },
    { legacy: 'handoffs', entity: 'coordination/handoffs' },
    { legacy: 'sessions', entity: 'coordination/sessions' },
    { legacy: 'inbox', entity: 'coordination/inbox' },
    { legacy: 'runtime', entity: 'coordination/runtime' },
];
const WORKSPACE_EXPORT_REFRESH_AGENTS = [
    { agentName: 'claude-code', relativePath: 'CLAUDE.md' },
    { agentName: 'cursor', relativePath: '.cursor/rules/brainclaw.md' },
    { agentName: 'windsurf', relativePath: '.windsurfrules' },
    { agentName: 'cline', relativePath: '.clinerules/brainclaw.md' },
    { agentName: 'roo', relativePath: '.roo/rules/brainclaw.md' },
    { agentName: 'continue', relativePath: '.continue/rules/brainclaw.md' },
    { agentName: 'antigravity', relativePath: 'GEMINI.md' },
];
export function runUpgrade(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const base = memoryDir(cwd);
    const actions = [];
    let movedFiles = 0;
    // Phase 1: Ensure entity-aligned directories exist
    ensureMemoryDir(cwd);
    // Phase 2: Detect and plan file migrations (legacy → entity)
    for (const { legacy, entity } of ENTITY_DIRS) {
        const legacyDir = path.join(base, legacy);
        const entityDir = path.join(base, entity);
        if (!fs.existsSync(legacyDir))
            continue;
        // Recursively collect all JSON files (handles subdirs like runtime/agent/, inbox/accepted/)
        const files = listJsonFilesRecursive(legacyDir);
        if (files.length === 0)
            continue;
        for (const file of files) {
            // Preserve subdirectory structure: runtime/jberdah/rtn_xxx.json → coordination/runtime/jberdah/rtn_xxx.json
            const relativeToLegacy = path.relative(legacyDir, file);
            const target = path.join(entityDir, relativeToLegacy);
            if (fs.existsSync(target)) {
                // Entity dir already has this file — skip (entity takes precedence)
                continue;
            }
            actions.push({
                type: 'move_file',
                from: path.relative(base, file),
                to: path.relative(base, target),
                description: `Move ${relativeToLegacy} from ${legacy}/ to ${entity}/`,
            });
        }
    }
    // Phase 3: Check schema migration status
    const migrationStatus = scanMigrationStatus(cwd);
    const outdated = migrationStatus.filter(e => e.status === 'outdated');
    for (const entry of outdated) {
        actions.push({
            type: 'migrate_schema',
            from: entry.path,
            description: `Migrate ${entry.documentType} from v${entry.detectedVersion} to v${entry.currentVersion}`,
        });
    }
    const agentRefreshActions = scanManagedWorkspaceAgentFileRefreshes(cwd);
    actions.push(...agentRefreshActions);
    // Report
    if (options.json) {
        outputJson(actions, options.dryRun ?? false);
        return;
    }
    if (actions.length === 0) {
        console.log('✔ Project memory is up to date. No upgrade needed.');
        return;
    }
    console.log(`Found ${actions.length} upgrade action(s):\n`);
    for (const action of actions) {
        const prefix = action.type === 'move_file' ? '→' : '↑';
        console.log(`  ${prefix} ${action.description}`);
    }
    if (options.dryRun) {
        console.log('\n(dry run — no changes made)');
        return;
    }
    // Execute file moves
    console.log('');
    for (const action of actions) {
        if (action.type === 'move_file' && action.from && action.to) {
            const src = path.join(base, action.from);
            const dst = path.join(base, action.to);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(src, dst);
            movedFiles++;
        }
    }
    // Execute schema migrations by re-saving state (loadState auto-migrates via Zod parse)
    if (outdated.length > 0) {
        const state = loadState(cwd);
        persistState(state, cwd);
    }
    const refreshedAgentFiles = refreshManagedWorkspaceAgentFiles(cwd);
    // Clean up empty legacy directories (recursively removes empty subdirs first)
    let removedDirs = 0;
    for (const { legacy } of ENTITY_DIRS) {
        const legacyDir = path.join(base, legacy);
        if (fs.existsSync(legacyDir)) {
            removedDirs += removeEmptyDirsRecursive(legacyDir);
        }
    }
    // Ensure memory git repo exists and commit the upgrade
    initMemoryRepo(cwd);
    commitMemoryChange(`upgrade: ${movedFiles} files moved, ${outdated.length} schemas migrated`, cwd);
    const parts = [
        `${movedFiles} file(s) moved`,
        `${outdated.length} schema(s) migrated`,
        `${refreshedAgentFiles.length} managed agent file(s) refreshed`,
    ];
    if (removedDirs > 0)
        parts.push(`${removedDirs} empty legacy dir(s) removed`);
    console.log(`✔ Upgrade complete: ${parts.join(', ')}.`);
}
function scanManagedWorkspaceAgentFileRefreshes(cwd) {
    const config = loadConfig(cwd);
    const storageDir = config.storage_dir ?? '.brainclaw';
    const actions = [];
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const agentsMode = getManagedInstructionMode(agentsPath);
    if (agentsMode === 'bootstrap' && needsBootstrapSectionRefresh(agentsPath, buildBrainclawSection(storageDir))) {
        actions.push({
            type: 'refresh_agent_file',
            to: 'AGENTS.md',
            description: 'Refresh managed Brainclaw section in AGENTS.md',
        });
    }
    else if (agentsMode === 'export') {
        const rendered = renderAgentExportForAgent('codex', cwd);
        if (rendered && needsExportSectionRefresh(agentsPath, rendered.content)) {
            actions.push({
                type: 'refresh_agent_file',
                to: 'AGENTS.md',
                description: 'Refresh generated Brainclaw instructions in AGENTS.md',
            });
        }
    }
    const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
    const copilotMode = getManagedInstructionMode(copilotPath);
    if (copilotMode === 'bootstrap' && needsBootstrapSectionRefresh(copilotPath, buildBrainclawSection(storageDir))) {
        actions.push({
            type: 'refresh_agent_file',
            to: '.github/copilot-instructions.md',
            description: 'Refresh managed Brainclaw section in .github/copilot-instructions.md',
        });
    }
    else if (copilotMode === 'export') {
        const rendered = renderAgentExportForAgent('github-copilot', cwd);
        if (rendered && needsExportSectionRefresh(copilotPath, rendered.content)) {
            actions.push({
                type: 'refresh_agent_file',
                to: '.github/copilot-instructions.md',
                description: 'Refresh generated Brainclaw instructions in .github/copilot-instructions.md',
            });
        }
    }
    for (const target of WORKSPACE_EXPORT_REFRESH_AGENTS) {
        const filePath = path.join(cwd, target.relativePath);
        const rendered = renderAgentExportForAgent(target.agentName, cwd);
        if (rendered && needsExportSectionRefresh(filePath, rendered.content)) {
            actions.push({
                type: 'refresh_agent_file',
                to: target.relativePath,
                description: `Refresh generated Brainclaw instructions in ${target.relativePath}`,
            });
        }
    }
    const claudeCommandPath = path.join(cwd, '.claude', 'commands', 'brainclaw.md');
    if (fs.existsSync(claudeCommandPath) && fs.readFileSync(claudeCommandPath, 'utf-8') !== buildClaudeCodeCommandText()) {
        actions.push({
            type: 'refresh_agent_file',
            to: '.claude/commands/brainclaw.md',
            description: 'Refresh Claude Code Brainclaw command instructions',
        });
    }
    const cursorHookPath = path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc');
    const expectedCursorHook = generateCursorHook(config.project_name);
    if (fs.existsSync(cursorHookPath) && fs.readFileSync(cursorHookPath, 'utf-8') !== expectedCursorHook) {
        actions.push({
            type: 'refresh_agent_file',
            to: '.cursor/rules/brainclaw-session.mdc',
            description: 'Refresh Cursor Brainclaw session hook',
        });
    }
    return actions;
}
function refreshManagedWorkspaceAgentFiles(cwd) {
    const config = loadConfig(cwd);
    const storageDir = config.storage_dir ?? '.brainclaw';
    const refreshed = new Set();
    const agentsPath = path.join(cwd, 'AGENTS.md');
    const agentsMode = getManagedInstructionMode(agentsPath);
    if (agentsMode === 'bootstrap') {
        if (writeBootstrapSectionFile(agentsPath, buildBrainclawSection(storageDir))) {
            refreshed.add('AGENTS.md');
        }
    }
    else if (agentsMode === 'export') {
        const result = writeAgentExportForAgent('codex', cwd);
        if (result && (result.created || result.updated)) {
            refreshed.add(result.relativePath);
        }
    }
    const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
    const copilotMode = getManagedInstructionMode(copilotPath);
    if (copilotMode === 'bootstrap') {
        if (writeBootstrapSectionFile(copilotPath, buildBrainclawSection(storageDir))) {
            refreshed.add('.github/copilot-instructions.md');
        }
    }
    else if (copilotMode === 'export') {
        const result = writeAgentExportForAgent('github-copilot', cwd);
        if (result && (result.created || result.updated)) {
            refreshed.add(result.relativePath);
        }
    }
    for (const target of WORKSPACE_EXPORT_REFRESH_AGENTS) {
        const filePath = path.join(cwd, target.relativePath);
        if (!fs.existsSync(filePath) || !hasBrainclawSection(fs.readFileSync(filePath, 'utf-8'))) {
            continue;
        }
        const result = writeAgentExportForAgent(target.agentName, cwd);
        if (result && (result.created || result.updated)) {
            refreshed.add(result.relativePath);
        }
    }
    if (fs.existsSync(path.join(cwd, '.claude', 'commands', 'brainclaw.md'))) {
        const result = ensureClaudeCodeCommand(cwd);
        if (result.created || result.updated) {
            refreshed.add(result.relativePath ?? '.claude/commands/brainclaw.md');
        }
    }
    if (fs.existsSync(path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc'))) {
        const expected = generateCursorHook(config.project_name);
        const filePath = path.join(cwd, '.cursor', 'rules', 'brainclaw-session.mdc');
        if (fs.readFileSync(filePath, 'utf-8') !== expected) {
            const result = writeHook(expected, '.cursor/rules/brainclaw-session.mdc', cwd);
            refreshed.add(result.relativePath);
        }
    }
    return [...refreshed];
}
function getManagedInstructionMode(filePath) {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!hasBrainclawSection(existing)) {
        return undefined;
    }
    if (existing.includes('## Brainclaw — shared project memory')) {
        return 'bootstrap';
    }
    return 'export';
}
function writeBootstrapSectionFile(filePath, section) {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!hasBrainclawSection(existing)) {
        return false;
    }
    const next = upsertSection(existing, section);
    if (next === existing) {
        return false;
    }
    fs.writeFileSync(filePath, next, 'utf-8');
    return true;
}
function needsBootstrapSectionRefresh(filePath, section) {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!hasBrainclawSection(existing)) {
        return false;
    }
    return existing !== upsertSection(existing, section);
}
function needsExportSectionRefresh(filePath, content) {
    if (!fs.existsSync(filePath)) {
        return false;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!hasBrainclawSection(existing)) {
        return false;
    }
    const section = `${BRAINCLAW_SECTION_START}\n${content}\n${BRAINCLAW_SECTION_END}`;
    return existing !== upsertSection(existing, section);
}
function upsertSection(existingContent, section) {
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
function listJsonFiles(dir) {
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(dir, f));
}
function listJsonFilesRecursive(dir) {
    if (!fs.existsSync(dir))
        return [];
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...listJsonFilesRecursive(full));
        }
        else if (entry.isFile() && entry.name.endsWith('.json')) {
            results.push(full);
        }
    }
    return results;
}
function isEmptyDir(dir) {
    try {
        return fs.readdirSync(dir).length === 0;
    }
    catch {
        return true;
    }
}
/** Recursively remove empty directories bottom-up. Returns count of dirs removed. */
function removeEmptyDirsRecursive(dir) {
    if (!fs.existsSync(dir))
        return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            removed += removeEmptyDirsRecursive(path.join(dir, entry.name));
        }
    }
    if (isEmptyDir(dir)) {
        fs.rmdirSync(dir);
        removed++;
    }
    return removed;
}
function outputJson(actions, dryRun) {
    console.log(JSON.stringify({
        upgrade_needed: actions.length > 0,
        dry_run: dryRun,
        actions_count: actions.length,
        actions,
    }, null, 2));
}
//# sourceMappingURL=upgrade.js.map