import fs from 'node:fs';
import path from 'node:path';
import { memoryExists } from '../core/io.js';
import { loadState } from '../core/state.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { resolveInstructions, loadInstructions } from '../core/instructions.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import { AGENT_EXPORT_REGISTRY, resolveExportTarget, resolveExportTargetByFormat, writeExportFile, buildHygieneSection, describeAutoConfigWrite, writeExportCompanionFiles, collectExportGitignoreEntries, ensureGitignoreEntries, } from '../core/agent-files.js';
import { logger } from '../core/logger.js';
import { getAgentCapabilityProfile } from '../core/agent-capability.js';
import { renderBrainclawSection } from '../core/instruction-templates.js';
import { getInstalledBrainclawVersion } from '../core/brainclaw-version.js';
export function runExport(options) {
    const cwd = options.cwd ?? process.cwd();
    if (!memoryExists(cwd)) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    if (options.all) {
        runExportAll(cwd, options);
        return;
    }
    if (options.detect) {
        if (options.shared) {
            console.error('Error: --shared cannot be used with --detect. Use `brainclaw export --format <format> --write --shared` to publish a specific instruction file.');
            process.exit(1);
        }
        runExportDetect(cwd, options);
        return;
    }
    if (!options.format) {
        console.error('Error: --format, --detect, or --all is required.');
        process.exit(1);
    }
    const content = generateExport(options.format, options, cwd);
    if (options.write) {
        const target = resolveExportTargetByFormat(options.format);
        const result = writeExportFile(content, target.relativePath, cwd);
        const autoConfigs = writeExportCompanionFiles(options.format, cwd);
        const gitignoreEntries = collectExportGitignoreEntries(cwd, target.relativePath, autoConfigs, {
            includeTarget: !options.shared,
        });
        if (gitignoreEntries.length > 0) {
            ensureGitignoreEntries(cwd, gitignoreEntries);
        }
        declareAgentIntegrationFromTarget(cwd, target.agentName, 'manual');
        console.log(`✔ Written to ${target.relativePath} (${result.created ? 'created' : 'updated'})`);
        if (options.shared) {
            console.log(`✔ Left ${target.relativePath} versionable (--shared); local companion config remains gitignored`);
        }
        else if (gitignoreEntries.length > 0) {
            console.log('✔ Added generated local agent files to .gitignore');
        }
        for (const autoConfig of autoConfigs) {
            const message = describeAutoConfigWrite(autoConfig);
            if (message) {
                console.log(message);
            }
        }
    }
    else if (options.output) {
        const dir = path.dirname(options.output);
        if (dir && !fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(options.output, content, 'utf-8');
        console.log(`✔ Exported to ${options.output}`);
    }
    else {
        console.log(content);
    }
}
function runExportDetect(cwd, options) {
    const detected = detectAiAgent();
    const target = detected ? resolveExportTarget(detected.name) : resolveExportTarget('unknown');
    const content = generateExport(target.format, options, cwd);
    const result = writeExportFile(content, target.relativePath, cwd);
    const autoConfigs = writeExportCompanionFiles(target.format, cwd);
    const gitignoreEntries = collectExportGitignoreEntries(cwd, target.relativePath, autoConfigs);
    if (gitignoreEntries.length > 0) {
        ensureGitignoreEntries(cwd, gitignoreEntries);
    }
    declareAgentIntegrationFromTarget(cwd, target.agentName, detected ? 'detected' : 'manual');
    const source = detected ? `${detected.name} [${detected.detection_source}]` : 'fallback (no agent detected)';
    console.log(`✔ Detected: ${source}`);
    console.log(`✔ Written to ${target.relativePath} (${result.created ? 'created' : 'updated'})`);
    if (gitignoreEntries.length > 0) {
        console.log('✔ Added generated local agent files to .gitignore');
    }
    for (const autoConfig of autoConfigs) {
        const message = describeAutoConfigWrite(autoConfig);
        if (message) {
            console.log(message);
        }
    }
}
function runExportAll(cwd, options) {
    // Deduplicate by format (e.g. codex and opencode both use agents-md)
    const seen = new Set();
    const targets = AGENT_EXPORT_REGISTRY.filter((t) => {
        if (seen.has(t.format))
            return false;
        seen.add(t.format);
        return true;
    });
    let written = 0;
    const allGitignoreEntries = [];
    for (const target of targets) {
        try {
            const content = generateExport(target.format, options, cwd);
            const result = writeExportFile(content, target.relativePath, cwd);
            const autoConfigs = writeExportCompanionFiles(target.format, cwd);
            const gitignoreEntries = collectExportGitignoreEntries(cwd, target.relativePath, autoConfigs);
            allGitignoreEntries.push(...gitignoreEntries);
            declareAgentIntegrationFromTarget(cwd, target.agentName, 'manual');
            console.log(`✔ ${target.relativePath} (${result.created ? 'created' : 'updated'})`);
            written++;
        }
        catch (err) {
            logger.debug(`Failed to export ${target.format}:`, err);
            console.warn(`⚠ Skipped ${target.format}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Consolidate gitignore entries
    if (allGitignoreEntries.length > 0) {
        ensureGitignoreEntries(cwd, [...new Set(allGitignoreEntries)]);
        console.log('✔ Updated .gitignore');
    }
    console.log(`✔ Exported ${written} agent file(s)`);
}
export function writeAgentExportForAgent(agentName, cwd) {
    const rendered = renderAgentExportForAgent(agentName, cwd);
    if (!rendered) {
        return undefined;
    }
    const result = writeExportFile(rendered.content, rendered.relativePath, cwd);
    declareAgentIntegrationFromTarget(cwd, rendered.agentName, 'manual');
    return { relativePath: rendered.relativePath, created: result.created, updated: result.updated };
}
export function renderAgentExportForAgent(agentName, cwd) {
    const target = resolveExportTarget(agentName);
    if (target.agentName === 'unknown') {
        return undefined;
    }
    const content = generateExport(target.format, {}, cwd);
    return { agentName: target.agentName, relativePath: target.relativePath, content };
}
export function writeDetectedAgentExport(detectedAgentName, cwd) {
    const rendered = renderAgentExportForAgent(detectedAgentName, cwd);
    if (!rendered) {
        return undefined;
    }
    // Skip if this is the fallback and AGENTS.md is already handled by ensureAgentFiles
    if (rendered.relativePath === 'AGENTS.md' || rendered.relativePath === '.github/copilot-instructions.md') {
        return undefined;
    }
    const result = writeExportFile(rendered.content, rendered.relativePath, cwd);
    return { relativePath: rendered.relativePath, created: result.created };
}
function declareAgentIntegrationFromTarget(cwd, agentName, declarationSource) {
    if (!isAgentIntegrationName(agentName)) {
        return;
    }
    const config = loadConfig(cwd);
    if (upsertAgentIntegrationDeclaration(config, agentName, declarationSource)) {
        saveConfig(config, cwd);
    }
}
function formatToAgentName(format) {
    const map = {
        'claude-md': 'claude-code',
        'cursor-rules': 'cursor',
        'copilot-instructions': 'github-copilot',
        'agents-md': 'codex',
        'gemini-md': 'antigravity',
        'windsurf': 'windsurf',
        'cline': 'cline',
        'roo': 'roo',
        'continue': 'continue',
    };
    return map[format];
}
function generateExport(format, options, cwd) {
    const agentName = formatToAgentName(format);
    if (agentName) {
        const adaptive = generateAdaptiveExport(agentName, options, cwd);
        if (adaptive)
            return adaptive;
    }
    // Fallback to legacy generators for unknown formats
    switch (format) {
        case 'copilot-instructions': return generateCopilotInstructions(options, cwd);
        case 'cursor-rules': return generateCursorRules(options, cwd);
        case 'agents-md': return generateAgentsMd(options, cwd);
        case 'claude-md': return generateClaudeMd(options, cwd);
        case 'windsurf': return generateWindsurf(options, cwd);
        case 'cline': return generateCline(options, cwd);
        case 'roo': return generateRoo(options, cwd);
        case 'continue': return generateContinueRules(options, cwd);
        case 'gemini-md': return generateGeminiMd(options, cwd);
        default:
            throw new Error(`Unknown export format: ${format}`);
    }
}
/**
 * Generate export content using adaptive templates when a capability profile
 * exists for the agent, falling back to the legacy per-format generators.
 */
function generateAdaptiveExport(agentName, options, cwd) {
    const profile = getAgentCapabilityProfile(agentName);
    if (!profile)
        return undefined;
    const state = loadState(cwd);
    const instructions = getInstructionText(options, cwd);
    const config = loadConfig(cwd);
    const result = renderBrainclawSection({
        profile,
        state,
        projectName: config.project_name,
        brainclawVersion: getInstalledBrainclawVersion(),
        resolvedInstructions: instructions,
    });
    return result.content;
}
function getInstructionText(options, cwd) {
    try {
        const all = loadInstructions(cwd);
        const resolved = resolveInstructions(all, {
            project: options.project,
            agent: options.agent,
        });
        return resolved.filter(i => i.active).map(i => i.text);
    }
    catch (err) {
        logger.debug('Failed to resolve instructions for export:', err);
        return [];
    }
}
function getConstraintsSummary(cwd) {
    try {
        const state = loadState(cwd);
        const active = state.active_constraints.filter(c => c.status === 'active');
        if (active.length === 0)
            return '';
        return '## Active Constraints\n\n' + active.map(c => `- ${c.text}`).join('\n');
    }
    catch (err) {
        logger.debug('Failed to load constraints for export:', err);
        return '';
    }
}
function getDecisionsSummary(cwd) {
    try {
        const state = loadState(cwd);
        if (state.recent_decisions.length === 0)
            return '';
        return '## Key Decisions\n\n' + state.recent_decisions.slice(-10).map(d => `- ${d.text}`).join('\n');
    }
    catch {
        return '';
    }
}
function getTrapsSummary(cwd) {
    try {
        const state = loadState(cwd);
        const traps = state.known_traps.filter(t => t.visibility === 'shared');
        if (traps.length === 0)
            return '';
        return '## Known Traps\n\n' + traps.map(t => `- [${t.severity}] ${t.text}`).join('\n');
    }
    catch {
        return '';
    }
}
// buildHygieneSection is imported from ../core/agent-files.js
function generateCopilotInstructions(options, cwd) {
    const config = loadConfig(cwd);
    const lines = [
        `# Copilot Instructions — ${config.project_name}`,
        '',
        '> Generated by brainclaw. Do not edit manually — run `brainclaw export --format copilot-instructions --write` to regenerate.',
        '',
    ];
    const instructions = getInstructionText(options, cwd);
    if (instructions.length > 0) {
        lines.push('## Instructions\n');
        for (const inst of instructions)
            lines.push(`- ${inst}`);
        lines.push('');
    }
    const constraints = getConstraintsSummary(cwd);
    if (constraints) {
        lines.push(constraints);
        lines.push('');
    }
    const decisions = getDecisionsSummary(cwd);
    if (decisions) {
        lines.push(decisions);
        lines.push('');
    }
    const traps = getTrapsSummary(cwd);
    if (traps) {
        lines.push(traps);
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
function generateCursorRules(options, cwd) {
    const instructions = getInstructionText(options, cwd);
    const state = loadState(cwd);
    const lines = ['# Cursor rules — generated by brainclaw', ''];
    if (instructions.length > 0) {
        lines.push('## Instructions');
        for (const inst of instructions)
            lines.push(`- ${inst}`);
        lines.push('');
    }
    const constraints = state.active_constraints.filter(c => c.status === 'active');
    if (constraints.length > 0) {
        lines.push('## Constraints');
        for (const c of constraints)
            lines.push(`- ${c.text}`);
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
function generateAgentsMd(options, cwd) {
    const config = loadConfig(cwd);
    const instructions = getInstructionText(options, cwd);
    const state = loadState(cwd);
    const lines = [
        `# AGENTS.md — ${config.project_name}`,
        '',
        '> Generated by brainclaw.',
        '',
        '## Project Instructions',
        '',
    ];
    if (instructions.length > 0) {
        for (const inst of instructions)
            lines.push(`- ${inst}`);
    }
    else {
        lines.push('_No project instructions defined._');
    }
    lines.push('');
    const activePlans = state.plan_items.filter(p => p.status === 'todo' || p.status === 'in_progress');
    if (activePlans.length > 0) {
        lines.push('## Active Plan Items\n');
        for (const p of activePlans.slice(0, 10)) {
            lines.push(`- [${p.status}] ${p.text}${p.assignee ? ` (@${p.assignee})` : ''}`);
        }
        lines.push('');
    }
    const traps = state.known_traps.filter(t => t.visibility === 'shared');
    if (traps.length > 0) {
        lines.push('## Known Traps\n');
        for (const t of traps.slice(0, 10)) {
            lines.push(`- [${t.severity}] ${t.text}`);
        }
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
function generateClaudeMd(options, cwd) {
    const config = loadConfig(cwd);
    const instructions = getInstructionText(options, cwd);
    const state = loadState(cwd);
    const lines = [
        `# ${config.project_name}`,
        '',
        '> This file is generated by brainclaw. Run `brainclaw export --format claude-md --write` to regenerate.',
        '',
    ];
    if (instructions.length > 0) {
        lines.push('## Project Instructions\n');
        for (const inst of instructions)
            lines.push(`- ${inst}`);
        lines.push('');
    }
    const constraints = state.active_constraints.filter(c => c.status === 'active');
    if (constraints.length > 0) {
        lines.push('## Active Constraints\n');
        for (const c of constraints)
            lines.push(`- ${c.text}`);
        lines.push('');
    }
    const traps = state.known_traps.filter(t => t.visibility === 'shared');
    if (traps.length > 0) {
        lines.push('## Known Traps\n');
        for (const t of traps)
            lines.push(`- [${t.severity}] ${t.text}`);
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
function generateWindsurf(options, cwd) {
    const instructions = getInstructionText(options, cwd);
    const state = loadState(cwd);
    const lines = ['# Windsurf rules — generated by brainclaw', ''];
    if (instructions.length > 0) {
        lines.push('## Instructions');
        for (const inst of instructions)
            lines.push(`- ${inst}`);
        lines.push('');
    }
    const constraints = state.active_constraints.filter(c => c.status === 'active');
    if (constraints.length > 0) {
        lines.push('## Constraints');
        for (const c of constraints)
            lines.push(`- ${c.text}`);
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
function generateCline(options, cwd) {
    return generateWindsurf(options, cwd).replace('Windsurf rules', 'Cline rules');
}
function generateRoo(options, cwd) {
    return generateWindsurf(options, cwd).replace('Windsurf rules', 'Roo rules');
}
function generateContinueRules(options, cwd) {
    return generateWindsurf(options, cwd).replace('Windsurf rules', 'Continue rules');
}
function generateGeminiMd(options, cwd) {
    const config = loadConfig(cwd);
    const instructions = getInstructionText(options, cwd);
    const state = loadState(cwd);
    const lines = [
        `# ${config.project_name}`,
        '',
        '> Generated by brainclaw. Run `brainclaw export --format gemini-md --write` to regenerate.',
        '',
    ];
    if (instructions.length > 0) {
        lines.push('## Project Instructions\n');
        for (const inst of instructions)
            lines.push(`- ${inst}`);
        lines.push('');
    }
    const constraints = state.active_constraints.filter(c => c.status === 'active');
    if (constraints.length > 0) {
        lines.push('## Active Constraints\n');
        for (const c of constraints)
            lines.push(`- ${c.text}`);
        lines.push('');
    }
    const traps = state.known_traps.filter(t => t.visibility === 'shared');
    if (traps.length > 0) {
        lines.push('## Known Traps\n');
        for (const t of traps)
            lines.push(`- [${t.severity}] ${t.text}`);
        lines.push('');
    }
    lines.push(buildHygieneSection());
    return lines.join('\n');
}
//# sourceMappingURL=export.js.map