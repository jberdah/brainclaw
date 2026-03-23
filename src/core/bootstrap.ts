import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsonStore } from './json-store.js';
import { generateId, generateIdWithLabel, nowISO } from './ids.js';
import { memoryPath, resolveEntityDir, withStoreLock, writeFileAtomic } from './io.js';
import {
  BootstrapApplicationReceiptSchema,
  BootstrapInterviewAnswerSchema,
  BootstrapInterviewPlanSchema,
  type BootstrapInterviewAnswer,
  type BootstrapInterviewQuestion,
  BootstrapInterviewQuestionSchema,
  BootstrapImportPlanDocumentSchema,
  BootstrapProfileDocumentSchema,
  BootstrapSuggestionDocumentSchema,
  MemorySeedDocumentSchema,
  type BootstrapApplicationReceipt,
  type BootstrapInterviewPlan,
  type BootstrapImportPlanDocument,
  type BootstrapProfileDocument,
  type BootstrapSuggestionDocument,
  type Constraint,
  type ConstraintCategory,
  type Decision,
  type DecisionOutcome,
  type MemorySeedConfidence,
  type MemorySeedDocument,
  type MemorySeedKind,
  type MemorySeedSourceKind,
  type Severity,
  type Trap,
} from './schema.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { analyzeRepository } from './repo-analysis.js';
import { buildExecutionContext, compactExecutionContext } from './execution-context.js';
import { buildAgentToolingContext } from './agent-context.js';
import { createInstruction, loadInstructions, saveInstruction } from './instructions.js';
import { resolveCurrentAgentName } from './agent-registry.js';
import { loadState, persistState } from './state.js';
import { generateMarkdown } from './markdown.js';

const README_CANDIDATES = ['README.md', 'README', 'README.txt', 'README.mdx'];
const DOC_HINTS = ['docs', 'doc'];
const MAKEFILE_NAME = 'Makefile';
const PROFILE_FILE = 'profile.json';
const IMPORT_PLAN_FILE = 'import-plan.json';
const APPLICATION_FILE = 'last-application.json';
const HOTSPOT_LIMIT = 3;
const DERIVED_SCHEMA_VERSION = 2;
const EMPTY_WORKSPACE_IGNORED = new Set([
  '.git',
  '.brainclaw',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.DS_Store',
  'Thumbs.db',
  'internal-docs',
]);
const NATIVE_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.windsurfrules',
  '.github/copilot-instructions.md',
] as const;
const NATIVE_INSTRUCTION_DIRS = [
  '.cursor/rules',
  '.roo/rules',
  '.continue/rules',
  '.clinerules',
] as const;

export interface BootstrapOptions {
  target?: string;
  refresh?: boolean;
  cwd?: string;
  interviewAnswers?: BootstrapInterviewAnswer[];
}

export interface BootstrapResult {
  profile: BootstrapProfileDocument;
  seeds: MemorySeedDocument[];
  importPlan: BootstrapImportPlanDocument;
  lastApplication?: BootstrapApplicationReceipt;
  reusedProfile: boolean;
}

export interface DerivedContextSignal {
  id: string;
  text: string;
  seed_kind: MemorySeedKind;
  source_kind: MemorySeedSourceKind;
  source_ref: string;
  confidence: MemorySeedConfidence;
  related_paths?: string[];
}

interface GitProbeResult {
  available: boolean;
  repoFingerprint?: string;
  hotspotSeeds: MemorySeedDocument[];
}

interface BuildBootstrapArtifactsResult {
  profile: BootstrapProfileDocument;
  seeds: MemorySeedDocument[];
  importPlan: BootstrapImportPlanDocument;
}

export interface ApplyBootstrapOptions extends BootstrapOptions {
  force?: boolean;
}

export interface BootstrapApplyResult {
  proposal: BootstrapImportPlanDocument;
  receipt?: BootstrapApplicationReceipt;
  createdCount: number;
  skippedCount: number;
}

export interface BootstrapUninstallResult {
  receipt?: BootstrapApplicationReceipt;
  deactivatedCount: number;
  deletedCount: number;
  skippedCount: number;
}

interface WorkspaceClassification {
  kind: 'empty' | 'existing';
  visibleEntries: string[];
}

export function runBootstrapProfile(options: BootstrapOptions = {}): BootstrapResult {
  const cwd = options.cwd ?? process.cwd();
  const target = normalizeTarget(options.target);
  const interviewAnswers = normalizeBootstrapInterviewAnswers(options.interviewAnswers);
  const existing = loadBootstrapProfile(cwd);
  const existingPlan = loadBootstrapImportPlan(cwd);
  const lastApplication = loadBootstrapApplication(cwd);
  const existingFingerprint = currentRepoFingerprint(cwd);

  if (!options.refresh && existing && existingPlan && isProfileReusable(existing, target, existingFingerprint)) {
    const seeds = listBootstrapSeeds(cwd);
    const importPlan = interviewAnswers.length > 0
      ? buildBootstrapImportPlan({
        cwd,
        target,
        workspaceKind: existing.workspace_kind ?? 'existing',
        onboardingMode: existing.onboarding_mode ?? inferOnboardingMode({
          workspaceKind: existing.workspace_kind ?? 'existing',
          confidence: existing.confidence ?? 'low',
          readmePresent: existing.sources_scanned.includes('README'),
          nativeInstructionFiles: existing.native_instruction_files,
        }),
        confidence: existing.confidence ?? 'low',
        gaps: existing.gaps,
        seeds,
        interviewAnswers,
      })
      : existingPlan;
    return {
      profile: existing,
      seeds,
      importPlan,
      lastApplication,
      reusedProfile: true,
    };
  }

  const artifacts = buildBootstrapArtifacts({ cwd, target, repoFingerprint: existingFingerprint });
  persistBootstrapArtifacts(artifacts, cwd);
  const importPlan = interviewAnswers.length > 0
    ? buildBootstrapImportPlan({
      cwd,
      target,
      workspaceKind: artifacts.profile.workspace_kind ?? 'existing',
      onboardingMode: artifacts.profile.onboarding_mode ?? 'existing_sparse',
      confidence: artifacts.profile.confidence ?? 'low',
      gaps: artifacts.profile.gaps,
      seeds: artifacts.seeds,
      interviewAnswers,
    })
    : artifacts.importPlan;
  return {
    profile: artifacts.profile,
    seeds: artifacts.seeds,
    importPlan,
    lastApplication,
    reusedProfile: false,
  };
}

export function listBootstrapSeeds(cwd?: string): MemorySeedDocument[] {
  return bootstrapSeedStore(cwd).list();
}

export function loadBootstrapProfile(cwd?: string): BootstrapProfileDocument | undefined {
  const filepath = bootstrapProfilePath(cwd);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  try {
    return loadVersionedJsonFile<BootstrapProfileDocument>('bootstrap_profile', filepath).document;
  } catch {
    return undefined;
  }
}

export function hasReusableBootstrapProfile(target?: string, cwd?: string): boolean {
  const profile = loadBootstrapProfile(cwd);
  if (!profile) {
    return false;
  }
  return isProfileReusable(profile, normalizeTarget(target), currentRepoFingerprint(cwd ?? process.cwd()));
}

export function selectDerivedSignals(
  target: string | undefined,
  maxSignals: number,
  cwd?: string,
): DerivedContextSignal[] {
  const normalizedTarget = normalizeTarget(target);
  const seeds = listBootstrapSeeds(cwd);
  const ranked = seeds
    .map((seed) => ({ seed, score: scoreSeed(seed, normalizedTarget) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.seed.derived_at.localeCompare(left.seed.derived_at);
    })
    .slice(0, maxSignals)
    .map((entry) => ({
      id: entry.seed.id,
      text: entry.seed.text,
      seed_kind: entry.seed.seed_kind,
      source_kind: entry.seed.source_kind,
      source_ref: entry.seed.source_ref,
      confidence: entry.seed.confidence,
      ...(entry.seed.related_paths ? { related_paths: entry.seed.related_paths } : {}),
    }));

  return ranked;
}

export function renderBootstrapSummary(result: BootstrapResult): string {
  const lines: string[] = [result.profile.summary];
  if (result.profile.workspace_kind) {
    lines.push(`Workspace kind: ${result.profile.workspace_kind}`);
  }
  if (result.profile.onboarding_mode) {
    lines.push(`Onboarding mode: ${result.profile.onboarding_mode}`);
  }
  if (result.profile.confidence) {
    lines.push(`Confidence: ${result.profile.confidence}`);
  }
  lines.push(`Sources scanned: ${result.profile.sources_scanned.join(', ') || 'none'}`);
  lines.push(`Seed count: ${result.profile.seed_count}`);
  if ((result.profile.native_instruction_files?.length ?? 0) > 0) {
    lines.push(`Native instruction files: ${result.profile.native_instruction_files.join(', ')}`);
  }
  if ((result.profile.gaps?.length ?? 0) > 0) {
    lines.push(`Open gaps: ${result.profile.gaps.join(' | ')}`);
  }
  lines.push(`Import suggestions: ${result.importPlan.suggestion_count}`);
  if ((result.importPlan.confirmed_suggestion_count ?? 0) > 0) {
    lines.push(`Confirmed by interview: ${result.importPlan.confirmed_suggestion_count}`);
  }
  if (result.profile.repo_fingerprint) {
    lines.push(`Repo fingerprint: ${result.profile.repo_fingerprint}`);
  }
  if (result.profile.target) {
    lines.push(`Target: ${result.profile.target}`);
  }
  if (result.reusedProfile) {
    lines.push('Reused existing bootstrap profile.');
  }
  if (result.lastApplication && !result.lastApplication.uninstalled_at) {
    lines.push(`Last bootstrap import: ${result.lastApplication.managed_artifacts.length} managed artifact(s) from ${result.lastApplication.applied_at}`);
  }
  if (result.importPlan.suggestions.length > 0) {
    lines.push('');
    lines.push('Import proposal:');
    for (const suggestion of result.importPlan.suggestions.slice(0, 10)) {
      const scope = suggestion.scope ? `:${suggestion.scope}` : '';
      lines.push(`- [${suggestion.target}/${suggestion.confidence}] <${suggestion.layer ?? 'global'}${scope}> ${suggestion.text}`);
    }
  }
  if ((result.importPlan.interview?.question_count ?? 0) > 0) {
    lines.push('');
    lines.push('Adaptive interview:');
    for (const question of result.importPlan.interview!.questions.slice(0, 6)) {
      lines.push(`- [${question.priority}/${question.audience}] [${question.id}] ${question.prompt}`);
    }
  }
  if (result.seeds.length > 0) {
    lines.push('');
    lines.push('Derived signals:');
    for (const seed of result.seeds.slice(0, 10)) {
      lines.push(`- [${seed.seed_kind}/${seed.confidence}] ${seed.text}`);
    }
  }
  return lines.join('\n');
}

export function renderBootstrapInterview(
  result: BootstrapResult,
  audience: 'cli' | 'ide_chat' | 'any' = 'any',
): string {
  const interview = result.importPlan.interview;
  if (!interview || interview.question_count === 0) {
    return 'No adaptive interview questions are needed right now.';
  }

  const questions = interview.questions.filter((question) => audience === 'any' || question.audience === 'any' || question.audience === audience);
  if (questions.length === 0) {
    return `No adaptive interview questions are targeted to ${audience}.`;
  }

  const lines = [interview.summary, `Audience: ${audience}`];
  lines.push('');
  for (const [index, question] of questions.entries()) {
    lines.push(`${index + 1}. [${question.id}] ${question.prompt}`);
    lines.push(`   Why: ${question.rationale}`);
    lines.push(`   Expected answer: ${question.response_kind}`);
    if (question.target_hints.length > 0) {
      lines.push(`   Target hints: ${question.target_hints.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function buildBootstrapArtifacts(input: {
  cwd: string;
  target?: string;
  repoFingerprint?: string;
}): BuildBootstrapArtifactsResult {
  const sourcesScanned: string[] = [];
  const seeds: MemorySeedDocument[] = [];
  const workspace = classifyWorkspace(input.cwd);
  const nativeInstructionFiles = discoverNativeInstructionFiles(input.cwd);

  const readmePath = findFirstExisting(input.cwd, README_CANDIDATES);
  if (readmePath) {
    sourcesScanned.push('README');
    seeds.push(...extractReadmeSeeds(readmePath, input.target));
  }

  const agentsPath = path.join(input.cwd, 'AGENTS.md');
  const agentsPresent = fs.existsSync(agentsPath);
  if (agentsPresent) {
    sourcesScanned.push('AGENTS.md');
    seeds.push(...extractAgentsSeeds(agentsPath, input.target));
  }

  if (nativeInstructionFiles.length > 0) {
    sourcesScanned.push('native_instructions');
    seeds.push(...extractNativeInstructionSeeds(
      nativeInstructionFiles.map((relativePath) => path.join(input.cwd, relativePath)),
      input.cwd,
      input.target,
    ));
  }

  const manifestResult = extractManifestSeeds(input.cwd, input.target);
  if (manifestResult.seeds.length > 0) {
    sourcesScanned.push(...manifestResult.sources);
    seeds.push(...manifestResult.seeds);
  }

  const executionContext = compactExecutionContext(buildExecutionContext({ cwd: input.cwd }));
  sourcesScanned.push('execution_context');
  seeds.push(...extractExecutionContextSeeds(executionContext, input.target));

  const agentTooling = buildAgentToolingContext({ cwd: input.cwd });
  if (agentTooling.skills.length > 0) {
    sourcesScanned.push('skills');
    seeds.push(...extractSkillSeeds(agentTooling.skills, input.target));
  }
  if (agentTooling.mcp_servers.length > 0) {
    sourcesScanned.push('local_mcp');
    seeds.push(...extractMcpSeeds(agentTooling.mcp_servers, input.target));
  }

  const repoAnalysis = analyzeRepository(input.cwd);
  sourcesScanned.push('repo-analysis');
  seeds.push(...extractRepoAnalysisSeeds(repoAnalysis, input.target));

  // Additional brownfield sources (step 12)
  const additionalSeeds = extractAdditionalBrownfieldSeeds(input.cwd, input.target);
  if (additionalSeeds.seeds.length > 0) {
    sourcesScanned.push(...additionalSeeds.sources);
    seeds.push(...additionalSeeds.seeds);
  }

  const gitProbe = probeGit(input.cwd, input.target);
  if (gitProbe.available) {
    sourcesScanned.push('git');
    seeds.push(...gitProbe.hotspotSeeds);
  }

  const uniqueSeeds = dedupeSeeds(seeds);
  const confidence = inferBootstrapConfidence({
    workspaceKind: workspace.kind,
    readmePresent: Boolean(readmePath),
    agentsPresent,
    nativeInstructionFiles,
    seedCount: uniqueSeeds.length,
  });
  const onboardingMode = inferOnboardingMode({
    workspaceKind: workspace.kind,
    readmePresent: Boolean(readmePath),
    nativeInstructionFiles,
    confidence,
  });
  const gaps = inferBootstrapGaps({
    workspaceKind: workspace.kind,
    readmePresent: Boolean(readmePath),
    nativeInstructionFiles,
    seedCount: uniqueSeeds.length,
  });
  const summary = buildSummary({
    workspaceKind: workspace.kind,
    agentsPresent,
    nativeInstructionFiles,
    gitAvailable: gitProbe.available,
    repoAnalysis,
    seeds: uniqueSeeds,
    target: input.target,
    onboardingMode,
    confidence,
    gaps,
  });
  const importPlan = buildBootstrapImportPlan({
    cwd: input.cwd,
    target: input.target,
    workspaceKind: workspace.kind,
    onboardingMode,
    confidence,
    gaps,
    seeds: uniqueSeeds,
  });

  return {
    profile: BootstrapProfileDocumentSchema.parse({
      schema_version: DERIVED_SCHEMA_VERSION,
      derived_at: nowISO(),
      repo_fingerprint: gitProbe.repoFingerprint ?? input.repoFingerprint,
      summary,
      sources_scanned: [...new Set(sourcesScanned)],
      git_available: gitProbe.available,
      agents_md_present: agentsPresent,
      seed_count: uniqueSeeds.length,
      target: input.target,
      workspace_kind: workspace.kind,
      onboarding_mode: onboardingMode,
      confidence,
      native_instruction_files: nativeInstructionFiles,
      gaps,
    }),
    seeds: uniqueSeeds.map((seed) => MemorySeedDocumentSchema.parse({
      ...seed,
      schema_version: DERIVED_SCHEMA_VERSION,
    })),
    importPlan,
  };
}

function extractReadmeSeeds(filepath: string, target?: string): MemorySeedDocument[] {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const seeds: MemorySeedDocument[] = [];

  const firstHeading = lines.find((line) => line.trim().startsWith('#'));
  if (firstHeading) {
    seeds.push(createSeed({
      text: firstHeading.replace(/^#+\s*/, '').trim(),
      seedKind: 'convention',
      sourceKind: 'readme',
      sourceRef: path.basename(filepath),
      confidence: 'medium',
      tags: ['bootstrap', 'readme'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  for (const section of ['setup', 'install', 'build', 'test', 'run']) {
    const headingIndex = lines.findIndex((line) => line.trim().toLowerCase().includes(section));
    if (headingIndex >= 0) {
      const snippet = collectSectionSnippet(lines, headingIndex);
      if (snippet) {
        seeds.push(createSeed({
          text: `${capitalize(section)} guidance: ${snippet}`,
          seedKind: 'command',
          sourceKind: 'readme',
          sourceRef: path.basename(filepath),
          confidence: 'medium',
          tags: ['bootstrap', section],
        }));
      }
    }
  }

  return seeds;
}

function extractAgentsSeeds(filepath: string, target?: string): MemorySeedDocument[] {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const seeds: MemorySeedDocument[] = [];

  const firstHeading = lines.find((line) => line.trim().startsWith('#'));
  if (firstHeading) {
    seeds.push(createSeed({
      text: `Agent guide: ${firstHeading.replace(/^#+\s*/, '').trim()}`,
      seedKind: 'agent_rule',
      sourceKind: 'agents_md',
      sourceRef: 'AGENTS.md',
      confidence: 'high',
      tags: ['bootstrap', 'agent'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
      const text = trimmed.replace(/^([-*]|\d+\.)\s+/, '').trim();
      if (text.length > 0) {
        seeds.push(createSeed({
          text,
          seedKind: 'agent_rule',
          sourceKind: 'agents_md',
          sourceRef: 'AGENTS.md',
          confidence: 'high',
          tags: ['bootstrap', 'agent'],
          relatedPaths: target ? [target] : undefined,
        }));
      }
    }
  }

  return seeds;
}

export function loadBootstrapImportPlan(cwd?: string): BootstrapImportPlanDocument | undefined {
  const filepath = bootstrapImportPlanPath(cwd);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  try {
    return loadVersionedJsonFile<BootstrapImportPlanDocument>('bootstrap_import_plan', filepath).document;
  } catch {
    return undefined;
  }
}

export function loadBootstrapApplication(cwd?: string): BootstrapApplicationReceipt | undefined {
  const filepath = bootstrapApplicationPath(cwd);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  try {
    return loadVersionedJsonFile<BootstrapApplicationReceipt>('bootstrap_application', filepath).document;
  } catch {
    return undefined;
  }
}

function extractNativeInstructionSeeds(filepaths: string[], cwd: string, target?: string): MemorySeedDocument[] {
  const seeds: MemorySeedDocument[] = [];

  for (const filepath of filepaths) {
    if (path.basename(filepath) === 'AGENTS.md') {
      continue;
    }

    const relativePath = path.relative(cwd, filepath).replace(/\\/g, '/');
    const raw = fs.readFileSync(filepath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const heading = lines.find((line) => line.trim().startsWith('#'));
    const firstContent = lines.find((line) => line.trim().length > 0);
    const label = heading
      ? heading.replace(/^#+\s*/, '').trim()
      : firstContent?.trim().replace(/^[-*]\s+/, '') ?? relativePath;

    seeds.push(createSeed({
      text: `Native agent guidance from ${path.basename(relativePath)}: ${label}`,
      seedKind: 'agent_rule',
      sourceKind: 'native_instruction',
      sourceRef: relativePath,
      confidence: 'high',
      tags: ['bootstrap', 'agent', 'native-context'],
      relatedPaths: target ? [target] : undefined,
    }));

    let extracted = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!/^([-*]|\d+\.)\s+/.test(trimmed)) {
        continue;
      }
      const text = trimmed.replace(/^([-*]|\d+\.)\s+/, '').trim();
      if (!text) {
        continue;
      }
      seeds.push(createSeed({
        text,
        seedKind: 'agent_rule',
        sourceKind: 'native_instruction',
        sourceRef: relativePath,
        confidence: 'medium',
        tags: ['bootstrap', 'agent', 'native-context'],
        relatedPaths: target ? [target] : undefined,
      }));
      extracted++;
      if (extracted >= 5) {
        break;
      }
    }
  }

  return seeds;
}

function extractManifestSeeds(cwd: string, target?: string): { sources: string[]; seeds: MemorySeedDocument[] } {
  const sources: string[] = [];
  const seeds: MemorySeedDocument[] = [];
  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    sources.push('package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        packageManager?: string;
        scripts?: Record<string, string>;
        workspaces?: unknown;
      };
      if (parsed.packageManager) {
        seeds.push(createSeed({
          text: `Package manager: ${parsed.packageManager}`,
          seedKind: 'convention',
          sourceKind: 'manifest',
          sourceRef: 'package.json',
          confidence: 'high',
          tags: ['bootstrap', 'toolchain'],
        }));
      }
      for (const scriptName of ['build', 'test', 'dev', 'start', 'lint']) {
        const script = parsed.scripts?.[scriptName];
        if (script) {
          seeds.push(createSeed({
            text: `Use "${scriptName}" script: ${script}`,
            seedKind: 'command',
            sourceKind: 'manifest',
            sourceRef: `package.json#scripts.${scriptName}`,
            confidence: 'high',
            tags: ['bootstrap', scriptName],
          }));
        }
      }
      if (parsed.workspaces) {
        seeds.push(createSeed({
          text: 'Repository uses package workspaces.',
          seedKind: 'convention',
          sourceKind: 'manifest',
          sourceRef: 'package.json#workspaces',
          confidence: 'high',
          tags: ['bootstrap', 'workspace'],
        }));
      }
    } catch {
      seeds.push(createSeed({
        text: 'package.json is present but could not be parsed reliably.',
        seedKind: 'warning',
        sourceKind: 'manifest',
        sourceRef: 'package.json',
        confidence: 'low',
        tags: ['bootstrap', 'warning'],
      }));
    }
  }

  const makefilePath = path.join(cwd, MAKEFILE_NAME);
  if (fs.existsSync(makefilePath)) {
    sources.push(MAKEFILE_NAME);
    const targets = fs.readFileSync(makefilePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9_.-]+:\s*$/.test(line))
      .map((line) => line.replace(/:\s*$/, ''))
      .slice(0, 3);
    for (const targetName of targets) {
      seeds.push(createSeed({
        text: `Make target available: ${targetName}`,
        seedKind: 'command',
        sourceKind: 'manifest',
        sourceRef: `Makefile#${targetName}`,
        confidence: 'medium',
        tags: ['bootstrap', 'make'],
      }));
    }
  }

  for (const [filename, label] of [['pyproject.toml', 'Python toolchain detected'], ['Cargo.toml', 'Rust toolchain detected'], ['go.mod', 'Go module detected']] as const) {
    if (fs.existsSync(path.join(cwd, filename))) {
      sources.push(filename);
      seeds.push(createSeed({
        text: label,
        seedKind: 'entrypoint',
        sourceKind: 'manifest',
        sourceRef: filename,
        confidence: 'medium',
        tags: ['bootstrap', 'toolchain'],
        relatedPaths: target ? [target] : undefined,
      }));
    }
  }

  return { sources: [...new Set(sources)], seeds };
}

function extractRepoAnalysisSeeds(result: ReturnType<typeof analyzeRepository>, target?: string): MemorySeedDocument[] {
  const seeds: MemorySeedDocument[] = [];
  seeds.push(createSeed({
    text: `Recommended project mode: ${result.recommendedMode}`,
    seedKind: 'convention',
    sourceKind: 'repo_analysis',
    sourceRef: 'repo-analysis',
    confidence: 'high',
    tags: ['bootstrap', 'topology'],
    relatedPaths: target ? [target] : undefined,
  }));

  for (const reason of result.reasons) {
    seeds.push(createSeed({
      text: reason,
      seedKind: reason.toLowerCase().includes('workspace') ? 'warning' : 'convention',
      sourceKind: 'repo_analysis',
      sourceRef: 'repo-analysis',
      confidence: 'medium',
      tags: ['bootstrap', 'analysis'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  return seeds;
}

function extractExecutionContextSeeds(
  snapshot: ReturnType<typeof compactExecutionContext>,
  target?: string,
): MemorySeedDocument[] {
  const seeds: MemorySeedDocument[] = [];

  if (snapshot.branch) {
    seeds.push(createSeed({
      text: `Current branch: ${snapshot.branch}`,
      seedKind: 'environment',
      sourceKind: 'machine',
      sourceRef: 'git:branch',
      confidence: 'high',
      tags: ['bootstrap', 'execution', 'git'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  if (snapshot.git_status === 'dirty') {
    seeds.push(createSeed({
      text: 'Repository has uncommitted changes.',
      seedKind: 'warning',
      sourceKind: 'machine',
      sourceRef: 'git:status',
      confidence: 'high',
      tags: ['bootstrap', 'execution', 'git'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  for (const tool of snapshot.toolchains.slice(0, 3)) {
    seeds.push(createSeed({
      text: `Toolchain available: ${tool.name}${tool.version ? ` ${tool.version}` : ''}`,
      seedKind: 'tooling',
      sourceKind: 'machine',
      sourceRef: `tool:${tool.name}`,
      confidence: 'medium',
      tags: ['bootstrap', 'execution', 'toolchain'],
      relatedPaths: target ? [target] : undefined,
    }));
  }

  return seeds;
}

function extractSkillSeeds(
  skills: ReturnType<typeof buildAgentToolingContext>['skills'],
  target?: string,
): MemorySeedDocument[] {
  return skills.slice(0, 5).map((skill) => {
    const capabilities: string[] = [];
    if (skill.scripts_present) capabilities.push('scripts');
    if (skill.references_present) capabilities.push('references');
    if (skill.assets_present) capabilities.push('assets');
    const capabilityText = capabilities.length > 0 ? ` (${capabilities.join(', ')})` : '';
    return createSeed({
      text: `Skill available: ${skill.name}${skill.description ? ` - ${skill.description}` : ''}${capabilityText}`,
      seedKind: 'tooling',
      sourceKind: 'skill',
      sourceRef: skill.source_path,
      confidence: 'high',
      tags: ['bootstrap', 'agent', 'skill'],
      relatedPaths: target ? [target] : undefined,
    });
  });
}

function extractMcpSeeds(
  servers: ReturnType<typeof buildAgentToolingContext>['mcp_servers'],
  target?: string,
): MemorySeedDocument[] {
  return servers.slice(0, 5).map((server) => createSeed({
    text: server.availability === 'missing_command'
      ? `Local MCP server configured but unavailable: ${server.name} (${server.command ?? 'missing command'})`
      : `Local MCP server configured: ${server.name} (${server.transport}, ${server.availability})`,
    seedKind: server.availability === 'missing_command' ? 'warning' : 'tooling',
    sourceKind: 'mcp',
    sourceRef: server.config_path,
    confidence: server.availability === 'missing_command' ? 'high' : 'high',
    tags: ['bootstrap', 'agent', 'mcp'],
    relatedPaths: target ? [target] : undefined,
  }));
}

function probeGit(cwd: string, target?: string): GitProbeResult {
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (headResult.status !== 0) {
    return { available: false, hotspotSeeds: [] };
  }

  const repoFingerprint = headResult.stdout.trim();
  const logResult = spawnSync('git', ['log', '--name-only', '--pretty=format:', '-n', '50'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  const hotspotSeeds: MemorySeedDocument[] = [];
  if (logResult.status === 0) {
    const counts = new Map<string, number>();
    for (const line of logResult.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      if (line.startsWith('.brainclaw/')) {
        continue;
      }
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const hotspots = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, HOTSPOT_LIMIT);
    for (const [filepath, count] of hotspots) {
      hotspotSeeds.push(createSeed({
        text: `Recent hotspot: ${filepath} (${count} recent touches)`,
        seedKind: 'hotspot',
        sourceKind: 'git',
        sourceRef: filepath,
        confidence: 'medium',
        tags: ['bootstrap', 'git', 'hotspot'],
        relatedPaths: [filepath, ...(target ? [target] : [])],
      }));
    }
  }

  // Step 13: Active branches
  const branchResult = spawnSync('git', ['branch', '--no-merged', 'HEAD', '--format=%(refname:short)'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (branchResult.status === 0) {
    const branches = branchResult.stdout.split(/\r?\n/).map((b) => b.trim()).filter(Boolean).slice(0, 5);
    for (const branch of branches) {
      hotspotSeeds.push(createSeed({
        text: `Active branch: ${branch}`,
        seedKind: 'hotspot',
        sourceKind: 'git',
        sourceRef: `branch:${branch}`,
        confidence: 'low',
        tags: ['bootstrap', 'git', 'branch'],
      }));
    }
  }

  // Step 13: Recent tags
  const tagResult = spawnSync('git', ['tag', '--sort=-creatordate', '-l'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (tagResult.status === 0) {
    const tags = tagResult.stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).slice(0, 3);
    if (tags.length > 0) {
      hotspotSeeds.push(createSeed({
        text: `Version tags: ${tags.join(', ')} (${tags.length} most recent)`,
        seedKind: 'convention',
        sourceKind: 'git',
        sourceRef: 'tags',
        confidence: 'medium',
        tags: ['bootstrap', 'git', 'versioning'],
      }));
    }
  }

  return {
    available: true,
    repoFingerprint,
    hotspotSeeds,
  };
}

function persistBootstrapArtifacts(artifacts: BuildBootstrapArtifactsResult, cwd: string): void {
  ensureBootstrapDirs(cwd);
  saveVersionedJsonFile('bootstrap_profile', bootstrapProfilePath(cwd), artifacts.profile);
  saveVersionedJsonFile('bootstrap_import_plan', bootstrapImportPlanPath(cwd), artifacts.importPlan);

  const store = bootstrapSeedStore(cwd);
  const existingIds = new Set(store.list().map((seed) => seed.id));
  for (const seed of artifacts.seeds) {
    store.save(seed);
    existingIds.delete(seed.id);
  }
  for (const id of existingIds) {
    store.delete(id);
  }
}

function bootstrapSeedStore(cwd?: string): JsonStore<MemorySeedDocument> {
  return new JsonStore<MemorySeedDocument>({
    dirPath: bootstrapSeedsDir(cwd),
    documentType: 'memory_seed',
    getId: (seed) => seed.id,
    sort: (a, b) => a.id.localeCompare(b.id),
  });
}

function ensureBootstrapDirs(cwd?: string): void {
  for (const dir of [bootstrapDir(cwd), bootstrapSeedsDir(cwd)]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function bootstrapDir(cwd?: string): string {
  return resolveEntityDir('bootstrap', cwd ?? process.cwd(), 'read');
}

function bootstrapSeedsDir(cwd?: string): string {
  return path.join(bootstrapDir(cwd), 'seeds');
}

function bootstrapProfilePath(cwd?: string): string {
  return path.join(bootstrapDir(cwd), PROFILE_FILE);
}

function bootstrapImportPlanPath(cwd?: string): string {
  return path.join(bootstrapDir(cwd), IMPORT_PLAN_FILE);
}

function bootstrapApplicationPath(cwd?: string): string {
  return path.join(bootstrapDir(cwd), APPLICATION_FILE);
}

function isProfileReusable(
  profile: BootstrapProfileDocument,
  target: string | undefined,
  currentFingerprint?: string,
): boolean {
  if ((profile.target ?? undefined) !== target) {
    return false;
  }
  if (profile.repo_fingerprint && currentFingerprint) {
    return profile.repo_fingerprint === currentFingerprint;
  }
  return true;
}

function currentRepoFingerprint(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function createSeed(input: {
  text: string;
  seedKind: MemorySeedKind;
  sourceKind: MemorySeedSourceKind;
  sourceRef: string;
  confidence: MemorySeedConfidence;
  tags?: string[];
  relatedPaths?: string[];
  promotionHint?: 'constraint' | 'decision' | 'trap';
}): MemorySeedDocument {
  return MemorySeedDocumentSchema.parse({
    schema_version: DERIVED_SCHEMA_VERSION,
    id: generateId('bootstrap_seeds'),
    derived_at: nowISO(),
    text: input.text,
    seed_kind: input.seedKind,
    source_kind: input.sourceKind,
    source_ref: input.sourceRef,
    confidence: input.confidence,
    related_paths: input.relatedPaths,
    tags: input.tags ?? [],
    promotion_hint: input.promotionHint,
  });
}

function dedupeSeeds(seeds: MemorySeedDocument[]): MemorySeedDocument[] {
  const byKey = new Map<string, MemorySeedDocument>();
  for (const seed of seeds) {
    const key = `${seed.seed_kind}:${seed.source_kind}:${seed.source_ref}:${seed.text.toLowerCase()}`;
    if (!byKey.has(key)) {
      byKey.set(key, seed);
    }
  }
  return [...byKey.values()];
}

function buildSummary(input: {
  workspaceKind: 'empty' | 'existing';
  onboardingMode: 'empty_workspace' | 'existing_documented' | 'existing_sparse';
  agentsPresent: boolean;
  nativeInstructionFiles: string[];
  gitAvailable: boolean;
  repoAnalysis: ReturnType<typeof analyzeRepository>;
  seeds: MemorySeedDocument[];
  target?: string;
  confidence: MemorySeedConfidence;
  gaps: string[];
}): string {
  const parts: string[] = [];
  parts.push(`Bootstrap summary${input.target ? ` for ${input.target}` : ''}: ${input.workspaceKind} workspace, ${input.seeds.length} derived signal(s).`);
  parts.push(`Onboarding mode: ${input.onboardingMode}.`);
  parts.push(`Confidence: ${input.confidence}.`);
  parts.push(`Repository mode looks ${input.repoAnalysis.recommendedMode}.`);
  if (input.agentsPresent) {
    parts.push('AGENTS.md detected and summarized.');
  }
  if (input.nativeInstructionFiles.length > 0) {
    parts.push(`${input.nativeInstructionFiles.length} native instruction file(s) detected.`);
  }
  if (input.gitAvailable) {
    parts.push('Git history available for hotspot detection.');
  }
  const commandCount = input.seeds.filter((seed) => seed.seed_kind === 'command').length;
  if (commandCount > 0) {
    parts.push(`${commandCount} command-oriented hint(s) found.`);
  }
  if (input.gaps.length > 0) {
    parts.push(`Needs follow-up on: ${input.gaps.join('; ')}.`);
  }
  return parts.join(' ');
}

function buildBootstrapImportPlan(input: {
  cwd: string;
  target?: string;
  workspaceKind: 'empty' | 'existing';
  onboardingMode: 'empty_workspace' | 'existing_documented' | 'existing_sparse';
  confidence: MemorySeedConfidence;
  gaps: string[];
  seeds: MemorySeedDocument[];
  interviewAnswers?: BootstrapInterviewAnswer[];
}): BootstrapImportPlanDocument {
  const activeInstructionKeys = new Set(
    loadInstructions(input.cwd)
      .filter((entry) => entry.active)
      .map((entry) => instructionIdentityKey(entry.text, entry.layer, entry.scope)),
  );

  const suggestions: BootstrapSuggestionDocument[] = [];
  const seenSuggestionKeys = new Set<string>();
  const importedSources = new Set<string>();
  const groupedBySource = new Map<string, MemorySeedDocument[]>();

  for (const seed of input.seeds) {
    const bucket = groupedBySource.get(seed.source_ref) ?? [];
    bucket.push(seed);
    groupedBySource.set(seed.source_ref, bucket);
  }

  for (const seed of input.seeds) {
    const suggestion = seedToBootstrapSuggestion(seed, false);
    if (!suggestion) {
      continue;
    }
    const suggestionKey = genericSuggestionIdentityKey(suggestion);
    if (seenSuggestionKeys.has(suggestionKey) || activeInstructionKeys.has(suggestionKey)) {
      continue;
    }
    seenSuggestionKeys.add(suggestionKey);
    importedSources.add(seed.source_ref);
    suggestions.push(BootstrapSuggestionDocumentSchema.parse({
      ...suggestion,
      schema_version: DERIVED_SCHEMA_VERSION,
    }));
  }

  for (const [sourceRef, seeds] of groupedBySource.entries()) {
    if (importedSources.has(sourceRef)) {
      continue;
    }
    const summarySeed = seeds.find((seed) => isBootstrapSummarySeed(seed.text));
    if (!summarySeed) {
      continue;
    }
    const suggestion = seedToBootstrapSuggestion(summarySeed, true);
    if (!suggestion) {
      continue;
    }
    const suggestionKey = genericSuggestionIdentityKey(suggestion);
    if (seenSuggestionKeys.has(suggestionKey) || activeInstructionKeys.has(suggestionKey)) {
      continue;
    }
    seenSuggestionKeys.add(suggestionKey);
    suggestions.push(BootstrapSuggestionDocumentSchema.parse({
      ...suggestion,
      schema_version: DERIVED_SCHEMA_VERSION,
    }));
  }

  const interview = buildBootstrapInterviewPlan({
    workspaceKind: input.workspaceKind,
    gaps: input.gaps,
    confidence: input.confidence,
    nativeInstructionSources: [...new Set(input.seeds
      .filter((seed) => seed.source_kind === 'native_instruction')
      .map((seed) => seed.source_ref))],
  });
  const interviewSuggestions = buildBootstrapInterviewSuggestions(interview, input.interviewAnswers ?? []);
  let confirmedSuggestionCount = 0;
  for (const suggestion of interviewSuggestions) {
    const suggestionKey = genericSuggestionIdentityKey(suggestion);
    if ((suggestion.target === 'instruction' && activeInstructionKeys.has(suggestionKey)) || seenSuggestionKeys.has(suggestionKey)) {
      continue;
    }
    seenSuggestionKeys.add(suggestionKey);
    confirmedSuggestionCount++;
    suggestions.push(BootstrapSuggestionDocumentSchema.parse({
      ...suggestion,
      schema_version: DERIVED_SCHEMA_VERSION,
    }));
  }
  const summary = suggestions.length === 0
    ? 'No safe bootstrap imports are ready yet; review the gaps and use an interview/import step before promoting derived context.'
    : `${suggestions.length} bootstrap suggestion(s) are ready to import after review${confirmedSuggestionCount > 0 ? `, including ${confirmedSuggestionCount} confirmed via interview` : ''}.`;

  return BootstrapImportPlanDocumentSchema.parse({
    schema_version: DERIVED_SCHEMA_VERSION,
    derived_at: nowISO(),
    target: input.target,
    workspace_kind: input.workspaceKind,
    onboarding_mode: input.onboardingMode,
    confidence: input.confidence,
    summary,
    requires_confirmation: true,
    gaps: input.gaps,
    confirmed_suggestion_count: confirmedSuggestionCount,
    interview_answer_count: input.interviewAnswers?.length ?? 0,
    suggestion_count: suggestions.length,
    suggestions,
    interview,
  });
}

function buildBootstrapInterviewPlan(input: {
  workspaceKind: 'empty' | 'existing';
  gaps: string[];
  confidence: MemorySeedConfidence;
  nativeInstructionSources: string[];
}): BootstrapInterviewPlan {
  const questions: BootstrapInterviewPlan['questions'] = [];
  const add = (
    prompt: string,
    rationale: string,
    priority: 'high' | 'medium' | 'low',
    audience: 'cli' | 'ide_chat' | 'any',
    responseKind: 'short_text' | 'long_text' | 'boolean' | 'list',
    gapKeys: string[],
    targetHints: BootstrapInterviewQuestion['target_hints'],
  ) => {
    questions.push(BootstrapInterviewQuestionSchema.parse({
      id: bootstrapInterviewQuestionId(prompt, audience),
      prompt,
      rationale,
      priority,
      audience,
      response_kind: responseKind,
      gap_keys: gapKeys,
      target_hints: targetHints,
    }));
  };

  if (input.workspaceKind === 'empty') {
    add(
      'What is this workspace trying to build in one sentence?',
      'An empty workspace needs a product intent anchor before Brainclaw can create durable guidance.',
      'high',
      'any',
      'short_text',
      ['project intent is not documented yet'],
      ['decision'],
    );
    add(
      'Which coding agents do you expect to use here, and should they work mostly sequentially or in parallel later?',
      'Bootstrap should capture collaboration expectations early, especially before worktree isolation exists.',
      'high',
      'any',
      'list',
      ['agent workflow expectations should be captured explicitly'],
      ['constraint', 'instruction'],
    );
    add(
      'For a CLI-only agent, what should the very first safe action be after reading context?',
      'Pure CLI agents need an explicit first action because they do not benefit from rich IDE affordances.',
      'medium',
      'cli',
      'short_text',
      ['agent workflow expectations should be captured explicitly'],
      ['instruction'],
    );
    add(
      'For an IDE chat agent, what should it ask or inspect before editing code?',
      'IDE chat agents can ask targeted follow-up questions; capturing that expectation avoids drift between surfaces.',
      'medium',
      'ide_chat',
      'short_text',
      ['agent workflow expectations should be captured explicitly'],
      ['instruction'],
    );
  }

  if (input.gaps.includes('no README-level project overview detected')) {
    add(
      'What is the current purpose of this existing project, and what would you want a new agent to understand first?',
      'When README context is missing, Brainclaw needs an explicit project overview to avoid weak brownfield inference.',
      'high',
      'any',
      'long_text',
      ['no README-level project overview detected'],
      ['decision'],
    );
  }

  if (input.gaps.includes('no native agent instruction files detected')) {
    add(
      'Should Brainclaw treat this project as agent-guided even though no native agent instruction files were found?',
      'This determines whether Brainclaw should synthesize workflow guidance or stay memory-only for now.',
      'medium',
      'any',
      'boolean',
      ['no native agent instruction files detected'],
      ['decision'],
    );
  }

  if (input.gaps.includes('derived context is sparse and may need an interview')) {
    add(
      'Which constraints or conventions are important enough that every future agent should see them immediately?',
      'Sparse derived context should be turned into a small set of high-signal shared instructions or constraints.',
      'high',
      'any',
      'list',
      ['derived context is sparse and may need an interview'],
      ['constraint'],
    );
  }

  if (input.nativeInstructionSources.length > 0) {
    add(
      `Which parts of ${input.nativeInstructionSources.join(', ')} should become durable Brainclaw memory, and which parts should remain local agent guidance only?`,
      'Native agent files are derived context first; Brainclaw needs a selective import decision instead of silently promoting them.',
      'medium',
      'ide_chat',
      'long_text',
      ['native instruction import boundary'],
      ['decision', 'instruction', 'constraint'],
    );
  }

  if (questions.length === 0 && input.confidence !== 'high') {
    add(
      'What is still ambiguous enough that a future agent would likely ask you before proceeding?',
      'Fallback question when bootstrap confidence is not high but no specific gap generated a dedicated prompt.',
      'medium',
      'any',
      'long_text',
      ['confidence fallback'],
      ['instruction', 'constraint'],
    );
  }

  const summary = questions.length === 0
    ? 'No adaptive interview questions are needed right now.'
    : `${questions.length} adaptive interview question(s) are ready to turn bootstrap gaps into confirmed shared memory.`;

  return BootstrapInterviewPlanSchema.parse({
    schema_version: DERIVED_SCHEMA_VERSION,
    derived_at: nowISO(),
    workspace_kind: input.workspaceKind,
    audience: 'any',
    summary,
    question_count: questions.length,
    questions,
  });
}

function bootstrapInterviewQuestionId(prompt: string, audience: 'cli' | 'ide_chat' | 'any'): string {
  const digest = crypto.createHash('sha1').update(`${audience}:${prompt}`).digest('hex').slice(0, 8);
  return `biq_${digest}`;
}

function normalizeBootstrapInterviewAnswers(answers?: BootstrapInterviewAnswer[]): BootstrapInterviewAnswer[] {
  if (!answers || answers.length === 0) {
    return [];
  }
  return answers.map((answer) => BootstrapInterviewAnswerSchema.parse(answer));
}

function buildBootstrapInterviewSuggestions(
  interview: BootstrapInterviewPlan | undefined,
  answers: BootstrapInterviewAnswer[],
): Array<Omit<BootstrapSuggestionDocument, 'schema_version'>> {
  if (!interview || answers.length === 0) {
    return [];
  }

  const questionsById = new Map(interview.questions.map((question) => [question.id, question] as const));
  const suggestions: Array<Omit<BootstrapSuggestionDocument, 'schema_version'>> = [];
  for (const answer of answers) {
    const question = questionsById.get(answer.question_id);
    if (!question) {
      continue;
    }
    if (answer.suggestions.length > 0) {
      for (const suggestion of answer.suggestions) {
        suggestions.push({
          id: generateId('bootstrap_suggestions'),
          target: suggestion.target,
          text: suggestion.text.trim(),
          rationale: suggestion.rationale ?? renderBootstrapInterviewRationale(question),
          confidence: suggestion.confidence ?? 'high',
          source_seed_ids: [],
          source_refs: [`bootstrap-interview:${question.id}`],
          layer: suggestion.layer,
          scope: suggestion.scope,
          tags: normalizeBootstrapSuggestionTags(['bootstrap-interview', ...suggestion.tags]),
          related_paths: suggestion.related_paths,
          category: suggestion.category,
          outcome: suggestion.outcome,
          severity: suggestion.severity,
          reversible: true,
        });
      }
      continue;
    }
    suggestions.push(...deriveBootstrapSuggestionsFromAnswer(question, answer));
  }

  return suggestions.filter((suggestion) => suggestion.text.trim().length > 0);
}

function deriveBootstrapSuggestionsFromAnswer(
  question: BootstrapInterviewQuestion,
  answer: BootstrapInterviewAnswer,
): Array<Omit<BootstrapSuggestionDocument, 'schema_version'>> {
  const itemTexts = answer.response_items.map((entry) => entry.trim()).filter(Boolean);
  const text = answer.response_text?.trim();
  const base = {
    id: generateId('bootstrap_suggestions'),
    rationale: renderBootstrapInterviewRationale(question),
    confidence: 'high' as const,
    source_seed_ids: [] as string[],
    source_refs: [`bootstrap-interview:${question.id}`],
    tags: normalizeBootstrapSuggestionTags(['bootstrap-interview']),
    related_paths: undefined as string[] | undefined,
    reversible: true,
  };

  if (question.gap_keys.includes('project intent is not documented yet') && text) {
    return [{ ...base, target: 'decision', text: `Project intent: ${text}` }];
  }

  if (question.gap_keys.includes('no README-level project overview detected') && text) {
    return [{ ...base, target: 'decision', text: `Project overview: ${text}` }];
  }

  if (question.prompt.startsWith('Which coding agents do you expect to use here') && (itemTexts.length > 0 || text)) {
    const values = itemTexts.length > 0 ? itemTexts : [text as string];
    return values.map((entry) => ({
      ...base,
      id: generateId('bootstrap_suggestions'),
      target: 'constraint' as const,
      text: `Agent workflow expectation: ${entry}`,
      category: 'process' as ConstraintCategory,
    }));
  }

  if (question.prompt.startsWith('For a CLI-only agent') && text) {
    return [{ ...base, target: 'instruction', text: `CLI-only agents should first: ${text}`, layer: 'global' }];
  }

  if (question.prompt.startsWith('For an IDE chat agent') && text) {
    return [{ ...base, target: 'instruction', text: `IDE chat agents should ask or inspect: ${text}`, layer: 'global' }];
  }

  if (question.gap_keys.includes('no native agent instruction files detected') && answer.response_boolean !== undefined) {
    return [{
      ...base,
      target: 'decision',
      text: answer.response_boolean
        ? 'Brainclaw should treat this project as agent-guided.'
        : 'Brainclaw should stay memory-only until agent guidance is clarified.',
    }];
  }

  if (question.gap_keys.includes('derived context is sparse and may need an interview') && (itemTexts.length > 0 || text)) {
    const values = itemTexts.length > 0 ? itemTexts : [text as string];
    return values.map((entry) => ({
      ...base,
      id: generateId('bootstrap_suggestions'),
      target: 'constraint' as const,
      text: entry,
      category: 'process' as ConstraintCategory,
    }));
  }

  if (question.gap_keys.includes('native instruction import boundary') && text) {
    return [{ ...base, target: 'decision', text: `Native instruction import boundary: ${text}` }];
  }

  if (question.gap_keys.includes('confidence fallback') && text) {
    return [{
      ...base,
      target: question.target_hints.includes('constraint') ? 'constraint' : 'instruction',
      text,
      category: question.target_hints.includes('constraint') ? 'process' as ConstraintCategory : undefined,
      layer: question.target_hints.includes('instruction') ? 'global' : undefined,
    }];
  }

  if (itemTexts.length > 0 && question.target_hints.includes('constraint')) {
    return itemTexts.map((entry) => ({
      ...base,
      id: generateId('bootstrap_suggestions'),
      target: 'constraint' as const,
      text: entry,
      category: 'process' as ConstraintCategory,
    }));
  }

  if (text && question.target_hints.includes('instruction')) {
    return [{ ...base, target: 'instruction', text, layer: 'global' }];
  }

  if (text && question.target_hints.includes('decision')) {
    return [{ ...base, target: 'decision', text }];
  }

  return [];
}

function renderBootstrapInterviewRationale(question: BootstrapInterviewQuestion): string {
  return `Confirmed via bootstrap interview answer to ${question.id}: ${question.prompt}`;
}

function seedToBootstrapSuggestion(
  seed: MemorySeedDocument,
  allowSummaryFallback: boolean,
): Omit<BootstrapSuggestionDocument, 'schema_version'> | undefined {
  if (seed.seed_kind !== 'agent_rule' && seed.seed_kind !== 'command') {
    return undefined;
  }

  if (seed.seed_kind === 'agent_rule' && isBootstrapSummarySeed(seed.text) && !allowSummaryFallback) {
    return undefined;
  }

  const target = inferBootstrapInstructionTarget(seed);
  if (!target) {
    return undefined;
  }

  return {
    id: generateId('bootstrap_suggestions'),
    target: 'instruction',
    text: seed.text,
    rationale: renderBootstrapSuggestionRationale(seed),
    confidence: seed.confidence,
    source_seed_ids: [seed.id],
    source_refs: [seed.source_ref],
    layer: target.layer,
    scope: target.scope,
    tags: normalizeBootstrapSuggestionTags(seed.tags),
    related_paths: seed.related_paths,
    reversible: true,
  };
}

function inferBootstrapInstructionTarget(seed: MemorySeedDocument): { layer: 'global' | 'agent'; scope?: string } | undefined {
  if (seed.source_kind === 'agents_md') {
    return { layer: 'global' };
  }
  if (seed.seed_kind === 'command') {
    return { layer: 'global' };
  }
  if (seed.source_kind !== 'native_instruction') {
    return { layer: 'global' };
  }

  const ref = seed.source_ref.replace(/\\/g, '/');
  if (ref === 'CLAUDE.md') return { layer: 'agent', scope: 'claude-code' };
  if (ref === 'GEMINI.md') return { layer: 'agent', scope: 'antigravity' };
  if (ref === '.windsurfrules') return { layer: 'agent', scope: 'windsurf' };
  if (ref === '.github/copilot-instructions.md') return { layer: 'agent', scope: 'github-copilot' };
  if (ref.startsWith('.cursor/rules/')) return { layer: 'agent', scope: 'cursor' };
  if (ref.startsWith('.roo/rules/')) return { layer: 'agent', scope: 'roo' };
  if (ref.startsWith('.continue/rules/')) return { layer: 'agent', scope: 'continue' };
  if (ref.startsWith('.clinerules/')) return { layer: 'agent', scope: 'cline' };
  return { layer: 'global' };
}

function renderBootstrapSuggestionRationale(seed: MemorySeedDocument): string {
  switch (seed.source_kind) {
    case 'agents_md':
      return 'Derived from AGENTS.md';
    case 'native_instruction':
      return `Derived from native agent instruction file ${seed.source_ref}`;
    case 'readme':
      return `Derived from ${seed.source_ref}`;
    case 'manifest':
      return `Derived from ${seed.source_ref}`;
    default:
      return `Derived from ${seed.source_ref}`;
  }
}

function normalizeBootstrapSuggestionTags(tags: string[]): string[] {
  const normalized = tags.filter((tag) => tag !== 'bootstrap' && tag !== 'native-context');
  normalized.push('bootstrap-import');
  return [...new Set(normalized)];
}

function isBootstrapSummarySeed(text: string): boolean {
  return text.startsWith('Agent guide: ') || text.startsWith('Native agent guidance from ');
}

function genericSuggestionIdentityKey(
  suggestion: Pick<BootstrapSuggestionDocument, 'target' | 'text' | 'layer' | 'scope' | 'severity'>,
): string {
  if (suggestion.target === 'instruction') {
    return instructionIdentityKey(suggestion.text, suggestion.layer ?? 'global', suggestion.scope);
  }
  if (suggestion.target === 'trap') {
    return `trap:${suggestion.severity ?? 'medium'}:${suggestion.text.trim().toLowerCase()}`;
  }
  return `${suggestion.target}:${suggestion.text.trim().toLowerCase()}`;
}

function instructionIdentityKey(text: string, layer: string, scope?: string): string {
  return `${layer}:${scope ?? '*'}:${text.trim().toLowerCase()}`;
}

export function applyBootstrapImport(options: ApplyBootstrapOptions = {}): BootstrapApplyResult {
  const cwd = options.cwd ?? process.cwd();
  const result = runBootstrapProfile(options);
  const proposal = result.importPlan;
  if (proposal.suggestions.length === 0) {
    return {
      proposal,
      receipt: loadBootstrapApplication(cwd),
      createdCount: 0,
      skippedCount: 0,
    };
  }

  const managedArtifacts: BootstrapApplicationReceipt['managed_artifacts'] = [];
  let createdCount = 0;
  let skippedCount = 0;

  withStoreLock(cwd, () => {
    const state = loadState(cwd);
    const activeInstructionKeys = new Set(
      loadInstructions(cwd)
        .filter((entry) => entry.active)
        .map((entry) => instructionIdentityKey(entry.text, entry.layer, entry.scope)),
    );
    const activeDecisionKeys = new Set(state.recent_decisions.map((entry) => genericSuggestionIdentityKey({
      target: 'decision',
      text: entry.text,
      layer: 'global',
      scope: undefined,
      severity: undefined,
    })));
    const activeConstraintKeys = new Set(state.active_constraints
      .filter((entry) => entry.status === 'active')
      .map((entry) => genericSuggestionIdentityKey({
        target: 'constraint',
        text: entry.text,
        layer: 'global',
        scope: undefined,
        severity: undefined,
      })));
    const activeTrapKeys = new Set(state.known_traps
      .filter((entry) => entry.status === 'active')
      .map((entry) => genericSuggestionIdentityKey({
        target: 'trap',
        text: entry.text,
        layer: 'global',
        scope: undefined,
        severity: entry.severity,
      })));
    let stateChanged = false;

    for (const suggestion of proposal.suggestions) {
      const identityKey = genericSuggestionIdentityKey(suggestion);
      if (
        (suggestion.target === 'instruction' && activeInstructionKeys.has(identityKey)) ||
        (suggestion.target === 'decision' && activeDecisionKeys.has(identityKey)) ||
        (suggestion.target === 'constraint' && activeConstraintKeys.has(identityKey)) ||
        (suggestion.target === 'trap' && activeTrapKeys.has(identityKey))
      ) {
        skippedCount++;
        continue;
      }
      switch (suggestion.target) {
        case 'instruction': {
          const entry = createInstruction(suggestion.text, {
            layer: suggestion.layer ?? 'global',
            scope: suggestion.scope,
            tags: suggestion.tags,
            author: resolveCurrentAgentName(cwd),
          }, cwd);
          activeInstructionKeys.add(identityKey);
          managedArtifacts.push({
            kind: 'instruction',
            id: entry.id,
            suggestion_id: suggestion.id,
            rollback_action: 'deactivate',
          });
          createdCount++;
          break;
        }
        case 'decision': {
          const { id, short_label } = generateIdWithLabel('recent_decisions', cwd);
          const entry: Decision = {
            id,
            short_label,
            text: suggestion.text,
            created_at: nowISO(),
            author: resolveCurrentAgentName(cwd),
            outcome: suggestion.outcome as DecisionOutcome | undefined,
            tags: suggestion.tags ?? [],
            related_paths: suggestion.related_paths,
          };
          state.recent_decisions.push(entry);
          activeDecisionKeys.add(identityKey);
          managedArtifacts.push({
            kind: 'decision',
            id: entry.id,
            suggestion_id: suggestion.id,
            rollback_action: 'delete',
          });
          stateChanged = true;
          createdCount++;
          break;
        }
        case 'constraint': {
          const { id, short_label } = generateIdWithLabel('active_constraints', cwd);
          const entry: Constraint = {
            id,
            short_label,
            text: suggestion.text,
            created_at: nowISO(),
            author: resolveCurrentAgentName(cwd),
            status: 'active',
            category: suggestion.category as ConstraintCategory | undefined,
            tags: suggestion.tags ?? [],
            related_paths: suggestion.related_paths,
          };
          state.active_constraints.push(entry);
          activeConstraintKeys.add(identityKey);
          managedArtifacts.push({
            kind: 'constraint',
            id: entry.id,
            suggestion_id: suggestion.id,
            rollback_action: 'delete',
          });
          stateChanged = true;
          createdCount++;
          break;
        }
        case 'trap': {
          const { id, short_label } = generateIdWithLabel('known_traps', cwd);
          const entry: Trap = {
            id,
            short_label,
            text: suggestion.text,
            created_at: nowISO(),
            author: resolveCurrentAgentName(cwd),
            status: 'active',
            severity: (suggestion.severity as Severity | undefined) ?? 'medium',
            tags: suggestion.tags ?? [],
            related_paths: suggestion.related_paths,
            visibility: 'shared',
          };
          state.known_traps.push(entry);
          activeTrapKeys.add(identityKey);
          managedArtifacts.push({
            kind: 'trap',
            id: entry.id,
            suggestion_id: suggestion.id,
            rollback_action: 'delete',
          });
          stateChanged = true;
          createdCount++;
          break;
        }
      }
    }

    if (stateChanged) {
      persistState(state, cwd, { writeProjectMarkdown: false });
    }
    if (createdCount > 0) {
      writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(loadState(cwd), cwd));
    }
  });

  const receipt = BootstrapApplicationReceiptSchema.parse({
    schema_version: DERIVED_SCHEMA_VERSION,
    applied_at: nowISO(),
    proposal_derived_at: proposal.derived_at,
    target: proposal.target,
    workspace_kind: proposal.workspace_kind,
    managed_artifacts: managedArtifacts,
    suggestion_ids: managedArtifacts.map((artifact) => artifact.suggestion_id),
  });
  saveVersionedJsonFile('bootstrap_application', bootstrapApplicationPath(cwd), receipt);

  return {
    proposal,
    receipt,
    createdCount,
    skippedCount,
  };
}

export function uninstallBootstrapImport(cwd?: string): BootstrapUninstallResult {
  const resolvedCwd = cwd ?? process.cwd();
  const receipt = loadBootstrapApplication(resolvedCwd);
  if (!receipt || receipt.uninstalled_at) {
    return {
      receipt,
      deactivatedCount: 0,
      deletedCount: 0,
      skippedCount: 0,
    };
  }

  let deactivatedCount = 0;
  let deletedCount = 0;
  let skippedCount = 0;

  withStoreLock(resolvedCwd, () => {
    const state = loadState(resolvedCwd);
    const instructions = loadInstructions(resolvedCwd);
    let stateChanged = false;
    for (const artifact of receipt.managed_artifacts) {
      if (artifact.kind === 'instruction') {
        const instruction = instructions.find((entry) => entry.id === artifact.id);
        if (!instruction || !instruction.active) {
          skippedCount++;
          continue;
        }
        instruction.active = false;
        instruction.updated_at = nowISO();
        saveInstruction(instruction, resolvedCwd);
        deactivatedCount++;
        continue;
      }
      const beforeCounts = {
        decisions: state.recent_decisions.length,
        constraints: state.active_constraints.length,
        traps: state.known_traps.length,
      };
      if (artifact.kind === 'decision') {
        state.recent_decisions = state.recent_decisions.filter((entry) => entry.id !== artifact.id);
      } else if (artifact.kind === 'constraint') {
        state.active_constraints = state.active_constraints.filter((entry) => entry.id !== artifact.id);
      } else if (artifact.kind === 'trap') {
        state.known_traps = state.known_traps.filter((entry) => entry.id !== artifact.id);
      }
      const changed = beforeCounts.decisions !== state.recent_decisions.length
        || beforeCounts.constraints !== state.active_constraints.length
        || beforeCounts.traps !== state.known_traps.length;
      if (!changed) {
        skippedCount++;
        continue;
      }
      stateChanged = true;
      deletedCount++;
    }
    if (stateChanged) {
      persistState(state, resolvedCwd, { writeProjectMarkdown: false });
    }
    if (deactivatedCount > 0 || deletedCount > 0) {
      writeFileAtomic(memoryPath('project.md', resolvedCwd), generateMarkdown(loadState(resolvedCwd), resolvedCwd));
    }
  });

  const nextReceipt = BootstrapApplicationReceiptSchema.parse({
    ...receipt,
    uninstalled_at: nowISO(),
  });
  saveVersionedJsonFile('bootstrap_application', bootstrapApplicationPath(resolvedCwd), nextReceipt);
  return {
    receipt: nextReceipt,
    deactivatedCount,
    deletedCount,
    skippedCount,
  };
}

function classifyWorkspace(cwd: string): WorkspaceClassification {
  const visibleEntries = fs.readdirSync(cwd)
    .filter((entry) => !EMPTY_WORKSPACE_IGNORED.has(entry));
  return {
    kind: visibleEntries.length === 0 ? 'empty' : 'existing',
    visibleEntries,
  };
}

function discoverNativeInstructionFiles(cwd: string): string[] {
  const discovered = new Set<string>();

  for (const relativePath of NATIVE_INSTRUCTION_FILES) {
    const filepath = path.join(cwd, relativePath);
    if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
      discovered.add(relativePath);
    }
  }

  for (const relativeDir of NATIVE_INSTRUCTION_DIRS) {
    const dir = path.join(cwd, relativeDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!/\.(md|mdc)$/i.test(entry)) {
        continue;
      }
      discovered.add(path.posix.join(relativeDir.replace(/\\/g, '/'), entry));
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function inferBootstrapConfidence(input: {
  workspaceKind: 'empty' | 'existing';
  readmePresent: boolean;
  agentsPresent: boolean;
  nativeInstructionFiles: string[];
  seedCount: number;
}): MemorySeedConfidence {
  if (input.workspaceKind === 'empty') {
    return input.seedCount > 3 ? 'medium' : 'low';
  }
  if (input.readmePresent && (input.agentsPresent || input.nativeInstructionFiles.length > 0) && input.seedCount >= 6) {
    return 'high';
  }
  if (input.readmePresent || input.nativeInstructionFiles.length > 0 || input.seedCount >= 4) {
    return 'medium';
  }
  return 'low';
}

function inferOnboardingMode(input: {
  workspaceKind: 'empty' | 'existing';
  readmePresent: boolean;
  nativeInstructionFiles: string[];
  confidence: MemorySeedConfidence;
}): 'empty_workspace' | 'existing_documented' | 'existing_sparse' {
  if (input.workspaceKind === 'empty') {
    return 'empty_workspace';
  }
  if (input.readmePresent || input.nativeInstructionFiles.length > 0 || input.confidence === 'high') {
    return 'existing_documented';
  }
  return 'existing_sparse';
}

function inferBootstrapGaps(input: {
  workspaceKind: 'empty' | 'existing';
  readmePresent: boolean;
  nativeInstructionFiles: string[];
  seedCount: number;
}): string[] {
  const gaps: string[] = [];
  if (input.workspaceKind === 'empty') {
    gaps.push('project intent is not documented yet');
    gaps.push('agent workflow expectations should be captured explicitly');
    return gaps;
  }
  if (!input.readmePresent) {
    gaps.push('no README-level project overview detected');
  }
  if (input.nativeInstructionFiles.length === 0) {
    gaps.push('no native agent instruction files detected');
  }
  if (input.seedCount < 4) {
    gaps.push('derived context is sparse and may need an interview');
  }
  return gaps;
}

function scoreSeed(seed: MemorySeedDocument, target?: string): number {
  let score = seedKindWeight(seed.seed_kind) + confidenceWeight(seed.confidence);
  if (!target) {
    return score;
  }

  const normalizedTarget = target.toLowerCase();
  if (seed.related_paths?.some((relatedPath) => matchesPath(relatedPath, target))) {
    score += 6;
  }
  if (seed.text.toLowerCase().includes(normalizedTarget)) {
    score += 4;
  }
  const targetTerms = normalizedTarget.split(/[\\/.\s_-]+/).filter(Boolean);
  if (targetTerms.some((term) => term.length > 1 && seed.text.toLowerCase().includes(term))) {
    score += 2;
  }
  return score;
}

function seedKindWeight(kind: MemorySeedKind): number {
  switch (kind) {
    case 'agent_rule':
      return 12;
    case 'warning':
      return 10;
    case 'tooling':
      return 9;
    case 'entrypoint':
      return 8;
    case 'command':
      return 7;
    case 'environment':
      return 7;
    case 'convention':
      return 6;
    case 'hotspot':
      return 4;
  }
}

function confidenceWeight(confidence: MemorySeedConfidence): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}

function matchesPath(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__GLOB__')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__GLOB__/g, '[^/]*') + '$';
  return new RegExp(regexStr).test(target);
}

function collectSectionSnippet(lines: string[], headingIndex: number): string | undefined {
  const buffer: string[] = [];
  for (const line of lines.slice(headingIndex + 1, headingIndex + 6)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) break;
    buffer.push(trimmed.replace(/^[-*]\s+/, ''));
  }
  return buffer.length > 0 ? buffer.join(' ') : undefined;
}

function findFirstExisting(cwd: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const filepath = path.join(cwd, candidate);
    if (fs.existsSync(filepath)) {
      return filepath;
    }
  }
  for (const hint of DOC_HINTS) {
    const docDir = path.join(cwd, hint);
    if (!fs.existsSync(docDir) || !fs.statSync(docDir).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(docDir).sort()) {
      if (/^readme/i.test(entry)) {
        return path.join(docDir, entry);
      }
    }
  }
  return undefined;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function normalizeTarget(target?: string): string | undefined {
  const trimmed = target?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// ─── Step 12: Additional brownfield sources ──────────────────────────────────

const CI_WORKFLOW_DIRS = ['.github/workflows', '.gitlab'];
const CI_FILES = ['.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml'];
const CONTRIBUTING_FILES = ['CONTRIBUTING.md', 'CONTRIBUTING'];
const CHANGELOG_FILES = ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md'];
const DOCKER_FILES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const ENV_EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template'];
const ADR_DIRS = ['doc/adr', 'docs/adr', 'doc/decisions', 'docs/decisions', 'adr'];

function extractAdditionalBrownfieldSeeds(
  cwd: string,
  target?: string,
): { seeds: MemorySeedDocument[]; sources: string[] } {
  const seeds: MemorySeedDocument[] = [];
  const sources: string[] = [];

  // CI/CD workflows
  for (const dir of CI_WORKFLOW_DIRS) {
    const fullPath = path.join(cwd, dir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      sources.push('ci_workflows');
      try {
        const files = fs.readdirSync(fullPath).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
        if (files.length > 0) {
          seeds.push(createSeed({
            text: `CI/CD: ${files.length} workflow(s) in ${dir}/`,
            seedKind: 'convention',
            sourceKind: 'ci_config',
            sourceRef: dir,
            confidence: 'medium',
            tags: ['bootstrap', 'ci'],
            relatedPaths: target ? [target] : undefined,
          }));
        }
      } catch { /* skip unreadable */ }
      break;
    }
  }
  for (const file of CI_FILES) {
    if (fs.existsSync(path.join(cwd, file))) {
      if (!sources.includes('ci_workflows')) sources.push('ci_config');
      seeds.push(createSeed({
        text: `CI/CD config: ${file}`,
        seedKind: 'convention',
        sourceKind: 'ci_config',
        sourceRef: file,
        confidence: 'medium',
        tags: ['bootstrap', 'ci'],
      }));
      break;
    }
  }

  // CONTRIBUTING.md
  const contributingPath = findFirstExisting(cwd, CONTRIBUTING_FILES);
  if (contributingPath) {
    sources.push('contributing');
    seeds.push(createSeed({
      text: `Contributing guide found: ${path.basename(contributingPath)}`,
      seedKind: 'convention',
      sourceKind: 'contributing',
      sourceRef: path.basename(contributingPath),
      confidence: 'medium',
      tags: ['bootstrap', 'contributing'],
    }));
  }

  // CHANGELOG
  const changelogPath = findFirstExisting(cwd, CHANGELOG_FILES);
  if (changelogPath) {
    sources.push('changelog');
    seeds.push(createSeed({
      text: `Changelog found: ${path.basename(changelogPath)}`,
      seedKind: 'convention',
      sourceKind: 'changelog',
      sourceRef: path.basename(changelogPath),
      confidence: 'low',
      tags: ['bootstrap', 'changelog'],
    }));
  }

  // Docker
  for (const file of DOCKER_FILES) {
    if (fs.existsSync(path.join(cwd, file))) {
      sources.push('docker');
      seeds.push(createSeed({
        text: `Docker config: ${file}`,
        seedKind: 'convention',
        sourceKind: 'docker',
        sourceRef: file,
        confidence: 'medium',
        tags: ['bootstrap', 'docker', 'infrastructure'],
      }));
      break;
    }
  }

  // .env.example
  const envPath = findFirstExisting(cwd, ENV_EXAMPLE_FILES);
  if (envPath) {
    sources.push('env_example');
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const varCount = content.split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).length;
      seeds.push(createSeed({
        text: `Environment template: ${path.basename(envPath)} (${varCount} variables)`,
        seedKind: 'convention',
        sourceKind: 'env_example',
        sourceRef: path.basename(envPath),
        confidence: 'medium',
        tags: ['bootstrap', 'env', 'configuration'],
      }));
    } catch { /* skip unreadable */ }
  }

  // ADR (Architecture Decision Records)
  for (const dir of ADR_DIRS) {
    const fullPath = path.join(cwd, dir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      sources.push('adr');
      try {
        const files = fs.readdirSync(fullPath).filter((f) => f.endsWith('.md'));
        if (files.length > 0) {
          seeds.push(createSeed({
            text: `Architecture Decision Records: ${files.length} ADR(s) in ${dir}/`,
            seedKind: 'convention',
            sourceKind: 'adr',
            sourceRef: dir,
            confidence: 'high',
            tags: ['bootstrap', 'adr', 'architecture'],
            relatedPaths: target ? [target] : undefined,
          }));
        }
      } catch { /* skip unreadable */ }
      break;
    }
  }

  return { seeds, sources: [...new Set(sources)] };
}
