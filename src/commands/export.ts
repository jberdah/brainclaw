import fs from 'node:fs';
import path from 'node:path';
import { memoryExists } from '../core/io.js';
import { loadState } from '../core/state.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { resolveInstructions, loadInstructions } from '../core/instructions.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import { resolveExportTarget, resolveExportTargetByFormat, writeExportFile, buildHygieneSection, describeAutoConfigWrite, writeExportCompanionFiles, type ExportFormat } from '../core/agent-files.js';
import { logger } from '../core/logger.js';

export type { ExportFormat };

export interface ExportOptions {
  format?: ExportFormat;
  output?: string;
  project?: string;
  agent?: string;
  detect?: boolean;
  write?: boolean;
  cwd?: string;
}

export function runExport(options: ExportOptions): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (options.detect) {
    runExportDetect(cwd, options);
    return;
  }

  if (!options.format) {
    console.error('Error: --format or --detect is required.');
    process.exit(1);
  }

  const content = generateExport(options.format, options, cwd);

  if (options.write) {
    const target = resolveExportTargetByFormat(options.format);
    const result = writeExportFile(content, target.relativePath, cwd);
    declareAgentIntegrationFromTarget(cwd, target.agentName, 'manual');
    console.log(`✔ Written to ${target.relativePath} (${result.created ? 'created' : 'updated'})`);
    for (const autoConfig of writeExportCompanionFiles(options.format, cwd)) {
      const message = describeAutoConfigWrite(autoConfig);
      if (message) {
        console.log(message);
      }
    }
  } else if (options.output) {
    const dir = path.dirname(options.output);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(options.output, content, 'utf-8');
    console.log(`✔ Exported to ${options.output}`);
  } else {
    console.log(content);
  }
}

function runExportDetect(cwd: string, options: ExportOptions): void {
  const detected = detectAiAgent();
  const target = detected ? resolveExportTarget(detected.name) : resolveExportTarget('unknown');
  const content = generateExport(target.format, options, cwd);
  const result = writeExportFile(content, target.relativePath, cwd);
  declareAgentIntegrationFromTarget(cwd, target.agentName, detected ? 'detected' : 'manual');
  const source = detected ? `${detected.name} [${detected.detection_source}]` : 'fallback (no agent detected)';
  console.log(`✔ Detected: ${source}`);
  console.log(`✔ Written to ${target.relativePath} (${result.created ? 'created' : 'updated'})`);

  for (const autoConfig of writeExportCompanionFiles(target.format, cwd)) {
    const message = describeAutoConfigWrite(autoConfig);
    if (message) {
      console.log(message);
    }
  }
}

export function writeAgentExportForAgent(
  agentName: string,
  cwd: string,
): { relativePath: string; created: boolean } | undefined {
  const target = resolveExportTarget(agentName);
  if (target.agentName === 'unknown') {
    return undefined;
  }

  const content = generateExport(target.format, {}, cwd);
  const result = writeExportFile(content, target.relativePath, cwd);
  declareAgentIntegrationFromTarget(cwd, target.agentName, 'manual');
  return { relativePath: target.relativePath, created: result.created };
}

export function writeDetectedAgentExport(detectedAgentName: string, cwd: string): { relativePath: string; created: boolean } | undefined {
  const target = resolveExportTarget(detectedAgentName);
  if (target.agentName === 'unknown') {
    return undefined;
  }
  // Skip if this is the fallback and AGENTS.md is already handled by ensureAgentFiles
  if (target.relativePath === 'AGENTS.md' || target.relativePath === '.github/copilot-instructions.md') {
    return undefined;
  }
  const content = generateExport(target.format, {}, cwd);
  const result = writeExportFile(content, target.relativePath, cwd);
  return { relativePath: target.relativePath, created: result.created };
}

function declareAgentIntegrationFromTarget(
  cwd: string,
  agentName: string,
  declarationSource: 'manual' | 'detected',
): void {
  if (!isAgentIntegrationName(agentName)) {
    return;
  }

  const config = loadConfig(cwd);
  if (upsertAgentIntegrationDeclaration(config, agentName, declarationSource)) {
    saveConfig(config, cwd);
  }
}

function generateExport(format: ExportFormat, options: ExportOptions, cwd: string): string {
  switch (format) {
    case 'copilot-instructions': return generateCopilotInstructions(options, cwd);
    case 'cursor-rules':         return generateCursorRules(options, cwd);
    case 'agents-md':            return generateAgentsMd(options, cwd);
    case 'claude-md':            return generateClaudeMd(options, cwd);
    case 'windsurf':             return generateWindsurf(options, cwd);
    case 'cline':                return generateCline(options, cwd);
    case 'roo':                  return generateRoo(options, cwd);
    case 'continue':             return generateContinueRules(options, cwd);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

function getInstructionText(options: ExportOptions, cwd: string): string[] {
  try {
    const all = loadInstructions(cwd);
    const resolved = resolveInstructions(all, {
      project: options.project,
      agent: options.agent,
    });
    return resolved.filter(i => i.active).map(i => i.text);
  } catch (err) {
    logger.debug('Failed to resolve instructions for export:', err);
    return [];
  }
}

function getConstraintsSummary(cwd: string): string {
  try {
    const state = loadState(cwd);
    const active = state.active_constraints.filter(c => c.status === 'active');
    if (active.length === 0) return '';
    return '## Active Constraints\n\n' + active.map(c => `- ${c.text}`).join('\n');
  } catch (err) {
    logger.debug('Failed to load constraints for export:', err);
    return '';
  }
}

function getDecisionsSummary(cwd: string): string {
  try {
    const state = loadState(cwd);
    if (state.recent_decisions.length === 0) return '';
    return '## Key Decisions\n\n' + state.recent_decisions.slice(-10).map(d => `- ${d.text}`).join('\n');
  } catch {
    return '';
  }
}

function getTrapsSummary(cwd: string): string {
  try {
    const state = loadState(cwd);
    const traps = state.known_traps.filter(t => t.visibility === 'shared');
    if (traps.length === 0) return '';
    return '## Known Traps\n\n' + traps.map(t => `- [${t.severity}] ${t.text}`).join('\n');
  } catch {
    return '';
  }
}

// buildHygieneSection is imported from ../core/agent-files.js

function generateCopilotInstructions(options: ExportOptions, cwd: string): string {
  const config = loadConfig(cwd);
  const lines: string[] = [
    `# Copilot Instructions — ${config.project_name}`,
    '',
    '> Generated by brainclaw. Do not edit manually — run `brainclaw export --format copilot-instructions --write` to regenerate.',
    '',
  ];

  const instructions = getInstructionText(options, cwd);
  if (instructions.length > 0) {
    lines.push('## Instructions\n');
    for (const inst of instructions) lines.push(`- ${inst}`);
    lines.push('');
  }

  const constraints = getConstraintsSummary(cwd);
  if (constraints) { lines.push(constraints); lines.push(''); }

  const decisions = getDecisionsSummary(cwd);
  if (decisions) { lines.push(decisions); lines.push(''); }

  const traps = getTrapsSummary(cwd);
  if (traps) { lines.push(traps); lines.push(''); }

  lines.push(buildHygieneSection());

  return lines.join('\n');
}

function generateCursorRules(options: ExportOptions, cwd: string): string {
  const instructions = getInstructionText(options, cwd);
  const state = loadState(cwd);
  const lines: string[] = ['# Cursor rules — generated by brainclaw', ''];

  if (instructions.length > 0) {
    lines.push('## Instructions');
    for (const inst of instructions) lines.push(`- ${inst}`);
    lines.push('');
  }

  const constraints = state.active_constraints.filter(c => c.status === 'active');
  if (constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of constraints) lines.push(`- ${c.text}`);
    lines.push('');
  }

  lines.push(buildHygieneSection());

  return lines.join('\n');
}

function generateAgentsMd(options: ExportOptions, cwd: string): string {
  const config = loadConfig(cwd);
  const instructions = getInstructionText(options, cwd);
  const state = loadState(cwd);
  const lines: string[] = [
    `# AGENTS.md — ${config.project_name}`,
    '',
    '> Generated by brainclaw.',
    '',
    '## Project Instructions',
    '',
  ];

  if (instructions.length > 0) {
    for (const inst of instructions) lines.push(`- ${inst}`);
  } else {
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

function generateClaudeMd(options: ExportOptions, cwd: string): string {
  const config = loadConfig(cwd);
  const instructions = getInstructionText(options, cwd);
  const state = loadState(cwd);
  const lines: string[] = [
    `# ${config.project_name}`,
    '',
    '> This file is generated by brainclaw. Run `brainclaw export --format claude-md --write` to regenerate.',
    '',
  ];

  if (instructions.length > 0) {
    lines.push('## Project Instructions\n');
    for (const inst of instructions) lines.push(`- ${inst}`);
    lines.push('');
  }

  const constraints = state.active_constraints.filter(c => c.status === 'active');
  if (constraints.length > 0) {
    lines.push('## Active Constraints\n');
    for (const c of constraints) lines.push(`- ${c.text}`);
    lines.push('');
  }

  const traps = state.known_traps.filter(t => t.visibility === 'shared');
  if (traps.length > 0) {
    lines.push('## Known Traps\n');
    for (const t of traps) lines.push(`- [${t.severity}] ${t.text}`);
    lines.push('');
  }

  lines.push(buildHygieneSection());

  return lines.join('\n');
}

function generateWindsurf(options: ExportOptions, cwd: string): string {
  const instructions = getInstructionText(options, cwd);
  const state = loadState(cwd);
  const lines: string[] = ['# Windsurf rules — generated by brainclaw', ''];

  if (instructions.length > 0) {
    lines.push('## Instructions');
    for (const inst of instructions) lines.push(`- ${inst}`);
    lines.push('');
  }

  const constraints = state.active_constraints.filter(c => c.status === 'active');
  if (constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of constraints) lines.push(`- ${c.text}`);
    lines.push('');
  }

  lines.push(buildHygieneSection());

  return lines.join('\n');
}

function generateCline(options: ExportOptions, cwd: string): string {
  return generateWindsurf(options, cwd).replace('Windsurf rules', 'Cline rules');
}

function generateRoo(options: ExportOptions, cwd: string): string {
  return generateWindsurf(options, cwd).replace('Windsurf rules', 'Roo rules');
}

function generateContinueRules(options: ExportOptions, cwd: string): string {
  return generateWindsurf(options, cwd).replace('Windsurf rules', 'Continue rules');
}
