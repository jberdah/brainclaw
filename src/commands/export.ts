import fs from 'node:fs';
import path from 'node:path';
import { memoryExists, readProjectVision } from '../core/io.js';
import { loadState } from '../core/state.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { resolveInstructions, loadInstructions } from '../core/instructions.js';
import { detectAiAgent } from '../core/ai-agent-detection.js';
import {
  AGENT_EXPORT_REGISTRY,
  resolveExportTarget,
  resolveExportTargetByFormat,
  writeExportFile,
  buildHygieneSection,
  describeAutoConfigWrite,
  writeExportCompanionFiles,
  collectExportGitignoreEntries,
  ensureGitignoreEntries,
  BRAINCLAW_EXCLUSIVE_DIRECTORIES,
  type ExportFormat,
} from '../core/agent-files.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { listClaims } from '../core/claims.js';
import { listCandidates } from '../core/candidates.js';
import { logger } from '../core/logger.js';
import { getAgentCapabilityProfile } from '../core/agent-capability.js';
import { renderBrainclawSection, renderLiveSection } from '../core/instruction-templates.js';
import { getInstalledBrainclawVersion } from '../core/brainclaw-version.js';

export type { ExportFormat };

export interface ExportOptions {
  format?: ExportFormat;
  output?: string;
  project?: string;
  agent?: string;
  detect?: boolean;
  write?: boolean;
  shared?: boolean;
  all?: boolean;
  cwd?: string;
}

export function runExport(options: ExportOptions): void {
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
    ensureGitignoreEntries(cwd, [...gitignoreEntries, ...BRAINCLAW_EXCLUSIVE_DIRECTORIES]);
    declareAgentIntegrationFromTarget(cwd, target.agentName, 'manual');
    console.log(`✔ Written to ${target.relativePath} (${result.created ? 'created' : 'updated'})`);
    if (options.shared) {
      console.log(`✔ Left ${target.relativePath} versionable (--shared); local companion config remains gitignored`);
    } else if (gitignoreEntries.length > 0) {
      console.log('✔ Added generated local agent files to .gitignore');
    }
    for (const autoConfig of autoConfigs) {
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
  const autoConfigs = writeExportCompanionFiles(target.format, cwd);
  const gitignoreEntries = collectExportGitignoreEntries(cwd, target.relativePath, autoConfigs);
  ensureGitignoreEntries(cwd, [...gitignoreEntries, ...BRAINCLAW_EXCLUSIVE_DIRECTORIES]);
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

function runExportAll(cwd: string, options: ExportOptions): void {
  // Deduplicate by format (e.g. codex and opencode both use agents-md)
  const seen = new Set<ExportFormat>();
  const targets = AGENT_EXPORT_REGISTRY.filter((t) => {
    if (seen.has(t.format)) return false;
    seen.add(t.format);
    return true;
  });

  let written = 0;
  const allGitignoreEntries: string[] = [];

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
    } catch (err) {
      logger.debug(`Failed to export ${target.format}:`, err);
      console.warn(`⚠ Skipped ${target.format}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Consolidate gitignore entries
  if (allGitignoreEntries.length > 0) {
    ensureGitignoreEntries(cwd, [...new Set([...allGitignoreEntries, ...BRAINCLAW_EXCLUSIVE_DIRECTORIES])]);
    console.log('✔ Updated .gitignore');
  }

  console.log(`✔ Exported ${written} agent file(s)`);
}

/**
 * Refresh live companion files for all agents.
 * These are gitignored files with current state (plans, claims, traps, sequences).
 * Only Tier B/C agents get live companions; Tier A receives live context via hooks/MCP.
 */
export function runRefresh(cwd?: string): void {
  const effectiveCwd = cwd ?? process.cwd();
  if (!memoryExists(effectiveCwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const state = loadState(effectiveCwd);
  const config = loadConfig(effectiveCwd);
  const instructions = getInstructionText({ project: undefined, agent: undefined }, effectiveCwd);
  const activeClaims = listClaims(effectiveCwd).filter((c) => c.status === 'active');
  const pendingCandidates = listCandidates('pending', effectiveCwd);
  const seen = new Set<ExportFormat>();
  const targets = AGENT_EXPORT_REGISTRY.filter((t) => {
    if (seen.has(t.format)) return false;
    seen.add(t.format);
    return true;
  });

  let written = 0;
  const liveGitignoreEntries: string[] = [];

  for (const target of targets) {
    const profile = getAgentCapabilityProfile(target.agentName);
    if (!profile) continue;

    const input = {
      profile,
      state,
      projectName: config.project_name,
      brainclawVersion: getInstalledBrainclawVersion(),
      resolvedInstructions: instructions,
      projectVision: readProjectVision(effectiveCwd),
      activeClaims,
      pendingCandidates,
    };

    const live = renderLiveSection(input);
    if (!live) continue; // Tier A — no live companion needed

    const livePath = toLivePath(target.relativePath);
    const fullPath = path.join(effectiveCwd, livePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
    if (existing !== live.content) {
      fs.writeFileSync(fullPath, live.content, 'utf-8');
      console.log(`✔ ${livePath} (refreshed)`);
      written++;
    }
    liveGitignoreEntries.push(livePath);
  }

  if (liveGitignoreEntries.length > 0) {
    ensureGitignoreEntries(effectiveCwd, liveGitignoreEntries);
  }

  if (written > 0) {
    console.log(`✔ Refreshed ${written} live companion file(s)`);
  } else {
    console.log('✔ All live companions are up to date.');
  }
}

/**
 * Convert a stable export path to its live companion path.
 * e.g. CLAUDE.md → CLAUDE.live.md, .cursor/rules/brainclaw.md → .cursor/rules/brainclaw.live.md
 */
function toLivePath(stablePath: string): string {
  const ext = path.extname(stablePath);
  const base = stablePath.slice(0, -ext.length);
  return `${base}.live${ext}`;
}

export function writeAgentExportForAgent(
  agentName: string,
  cwd: string,
): { relativePath: string; created: boolean; updated: boolean } | undefined {
  const rendered = renderAgentExportForAgent(agentName, cwd);
  if (!rendered) {
    return undefined;
  }

  const result = writeExportFile(rendered.content, rendered.relativePath, cwd);
  declareAgentIntegrationFromTarget(cwd, rendered.agentName, 'manual');
  return { relativePath: rendered.relativePath, created: result.created, updated: result.updated };
}

export function renderAgentExportForAgent(
  agentName: string,
  cwd: string,
): { agentName: string; relativePath: string; content: string } | undefined {
  const target = resolveExportTarget(agentName);
  if (target.agentName === 'unknown') {
    return undefined;
  }

  const content = generateExport(target.format, {}, cwd);
  return { agentName: target.agentName, relativePath: target.relativePath, content };
}

export function writeDetectedAgentExport(detectedAgentName: string, cwd: string): { relativePath: string; created: boolean } | undefined {
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

function formatToAgentName(format: ExportFormat): string | undefined {
  const map: Record<string, string> = {
    'claude-md': 'claude-code',
    'cursor-rules': 'cursor',
    'copilot-instructions': 'github-copilot',
    'agents-md': 'codex',
    'gemini-md': 'antigravity',
    'board-md': 'brainclaw',
    'windsurf': 'windsurf',
    'cline': 'cline',
    'roo': 'roo',
    'continue': 'continue',
  };
  return map[format];
}

function generateExport(format: ExportFormat, options: ExportOptions, cwd: string): string {
  const agentName = formatToAgentName(format);
  if (agentName) {
    const adaptive = generateAdaptiveExport(agentName, options, cwd);
    if (adaptive) return adaptive;
  }

  // Fallback to legacy generators for unknown formats
  switch (format) {
    case 'copilot-instructions': return generateCopilotInstructions(options, cwd);
    case 'cursor-rules':         return generateCursorRules(options, cwd);
    case 'agents-md':            return generateAgentsMd(options, cwd);
    case 'claude-md':            return generateClaudeMd(options, cwd);
    case 'windsurf':             return generateWindsurf(options, cwd);
    case 'cline':                return generateCline(options, cwd);
    case 'roo':                  return generateRoo(options, cwd);
    case 'continue':             return generateContinueRules(options, cwd);
    case 'gemini-md':            return generateGeminiMd(options, cwd);
    case 'board-md':             return generateBoardMd(options, cwd);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

/**
 * Generate export content using adaptive templates when a capability profile
 * exists for the agent, falling back to the legacy per-format generators.
 */
function generateAdaptiveExport(agentName: string, options: ExportOptions, cwd: string): string | undefined {
  const profile = getAgentCapabilityProfile(agentName);
  if (!profile) return undefined;

  const state = loadState(cwd);
  const instructions = getInstructionText(options, cwd);
  const config = loadConfig(cwd);

  const result = renderBrainclawSection({
    profile,
    state,
    projectName: config.project_name,
    brainclawVersion: getInstalledBrainclawVersion(),
    resolvedInstructions: instructions,
    projectVision: readProjectVision(cwd),
  });

  return result.content;
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

function generateGeminiMd(options: ExportOptions, cwd: string): string {
  const config = loadConfig(cwd);
  const instructions = getInstructionText(options, cwd);
  const state = loadState(cwd);
  const lines: string[] = [
    `# ${config.project_name}`,
    '',
    '> Generated by brainclaw. Run `brainclaw export --format gemini-md --write` to regenerate.',
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

function generateBoardMd(_options: ExportOptions, cwd: string): string {
  const config = loadConfig(cwd);
  const board = buildCoordinationSnapshot({ cwd });
  const state = loadState(cwd);
  const lines: string[] = [
    `# BOARD.md — ${config.project_name}`,
    '',
    `> Live agent board. Generated by brainclaw. Regenerate: \`brainclaw export --format board-md --write\``,
    `> Last updated: ${new Date().toISOString()}`,
    '',
  ];

  // Active plans
  if (board.active_plans.length > 0) {
    lines.push(`## Active Plans (${board.active_plans.length})\n`);
    for (const plan of board.active_plans.slice(0, 20)) {
      const tags = plan.tags?.length ? ` [${plan.tags.join(', ')}]` : '';
      const priority = plan.priority ? ` (${plan.priority})` : '';
      const assignee = plan.assignee ? ` @${plan.assignee}` : '';
      const claims = plan.claims?.length ? ` — claimed by: ${plan.claims.map((c: { agent?: string }) => c.agent ?? 'unknown').join(', ')}` : '';
      lines.push(`- **[${plan.id}]** [${plan.status}]${priority}${assignee} ${plan.text}${tags}${claims}`);
    }
    lines.push('');
  } else {
    lines.push('## Active Plans\n\n_No active plans._\n');
  }

  // Active claims
  if (board.active_claims.length > 0) {
    lines.push(`## Active Claims (${board.active_claims.length})\n`);
    for (const claim of board.active_claims.slice(0, 20)) {
      lines.push(`- **[${claim.id}]** ${claim.agent ?? 'unknown'} → \`${claim.scope}\` — ${claim.description ?? ''}`);
    }
    lines.push('');
  }

  // Other agents activity
  if (board.other_agents && board.other_agents.length > 0) {
    lines.push(`## Other Agents Active\n`);
    for (const agent of board.other_agents) {
      const scopes = agent.scopes.length > 0 ? ` (scopes: ${agent.scopes.join(', ')})` : '';
      lines.push(`- **${agent.name}** — ${agent.claim_count} claim(s)${scopes}`);
    }
    lines.push('');
  }

  // Open handoffs
  if (board.open_handoffs.length > 0) {
    lines.push(`## Open Handoffs (${board.open_handoffs.length})\n`);
    for (const handoff of board.open_handoffs.slice(0, 10)) {
      lines.push(`- **[${handoff.id}]** ${handoff.from ?? '?'} → ${handoff.to ?? '?'}: ${handoff.text ?? ''}`);
    }
    lines.push('');
  }

  // Recent decisions
  const decisions = state.recent_decisions.slice(0, 10);
  if (decisions.length > 0) {
    lines.push(`## Recent Decisions (${decisions.length})\n`);
    for (const d of decisions) {
      const tags = d.tags?.length ? ` [${d.tags.join(', ')}]` : '';
      lines.push(`- **[${d.id}]** ${d.text}${tags}`);
    }
    lines.push('');
  }

  // Known traps
  const traps = state.known_traps.filter(t => t.visibility === 'shared' && t.status === 'active');
  if (traps.length > 0) {
    lines.push(`## Known Traps (${traps.length})\n`);
    for (const t of traps.slice(0, 10)) {
      lines.push(`- **[${t.id}]** [${t.severity}] ${t.text}`);
    }
    lines.push('');
  }

  // Active constraints
  const constraints = state.active_constraints.filter(c => c.status === 'active');
  if (constraints.length > 0) {
    lines.push(`## Active Constraints (${constraints.length})\n`);
    for (const c of constraints.slice(0, 10)) {
      lines.push(`- **[${c.id}]** ${c.text}`);
    }
    lines.push('');
  }

  // Instructions
  if (board.resolved_instructions.length > 0) {
    lines.push(`## Active Instructions (${board.resolved_instructions.length})\n`);
    for (const inst of board.resolved_instructions.slice(0, 10)) {
      lines.push(`- **[${inst.id}]** ${inst.text}`);
    }
    lines.push('');
  }

  // Linked projects
  if (board.linked_projects && board.linked_projects.length > 0) {
    lines.push(`## Linked Projects (${board.linked_projects.length})\n`);
    for (const lp of board.linked_projects) {
      const status = lp.available ? 'available' : 'unavailable';
      const agents = lp.agents.length > 0 ? ` — agents: ${lp.agents.join(', ')}` : '';
      lines.push(`- **${lp.name}** (${lp.role}, ${status}) — ${lp.active_plans} plans, ${lp.active_claims} claims${agents}`);
    }
    lines.push('');
  }

  lines.push(buildHygieneSection());

  return lines.join('\n');
}
