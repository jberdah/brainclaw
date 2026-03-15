import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsonStore } from './json-store.js';
import { generateId, nowISO } from './ids.js';
import { memoryDir } from './io.js';
import {
  BootstrapProfileDocumentSchema,
  MemorySeedDocumentSchema,
  type BootstrapProfileDocument,
  type MemorySeedConfidence,
  type MemorySeedDocument,
  type MemorySeedKind,
  type MemorySeedSourceKind,
} from './schema.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { analyzeRepository } from './repo-analysis.js';

const README_CANDIDATES = ['README.md', 'README', 'README.txt', 'README.mdx'];
const DOC_HINTS = ['docs', 'doc'];
const MAKEFILE_NAME = 'Makefile';
const PROFILE_FILE = 'profile.json';
const HOTSPOT_LIMIT = 3;
const DERIVED_SCHEMA_VERSION = 2;

export interface BootstrapOptions {
  target?: string;
  refresh?: boolean;
  cwd?: string;
}

export interface BootstrapResult {
  profile: BootstrapProfileDocument;
  seeds: MemorySeedDocument[];
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
}

export function runBootstrapProfile(options: BootstrapOptions = {}): BootstrapResult {
  const cwd = options.cwd ?? process.cwd();
  const target = normalizeTarget(options.target);
  const existing = loadBootstrapProfile(cwd);
  const existingFingerprint = currentRepoFingerprint(cwd);

  if (!options.refresh && existing && isProfileReusable(existing, target, existingFingerprint)) {
    return {
      profile: existing,
      seeds: listBootstrapSeeds(cwd),
      reusedProfile: true,
    };
  }

  const artifacts = buildBootstrapArtifacts({ cwd, target, repoFingerprint: existingFingerprint });
  persistBootstrapArtifacts(artifacts, cwd);
  return {
    profile: artifacts.profile,
    seeds: artifacts.seeds,
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
  lines.push(`Sources scanned: ${result.profile.sources_scanned.join(', ') || 'none'}`);
  lines.push(`Seed count: ${result.profile.seed_count}`);
  if (result.profile.repo_fingerprint) {
    lines.push(`Repo fingerprint: ${result.profile.repo_fingerprint}`);
  }
  if (result.profile.target) {
    lines.push(`Target: ${result.profile.target}`);
  }
  if (result.reusedProfile) {
    lines.push('Reused existing bootstrap profile.');
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

function buildBootstrapArtifacts(input: {
  cwd: string;
  target?: string;
  repoFingerprint?: string;
}): BuildBootstrapArtifactsResult {
  const sourcesScanned: string[] = [];
  const seeds: MemorySeedDocument[] = [];

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

  const manifestResult = extractManifestSeeds(input.cwd, input.target);
  if (manifestResult.seeds.length > 0) {
    sourcesScanned.push(...manifestResult.sources);
    seeds.push(...manifestResult.seeds);
  }

  const repoAnalysis = analyzeRepository(input.cwd);
  sourcesScanned.push('repo-analysis');
  seeds.push(...extractRepoAnalysisSeeds(repoAnalysis, input.target));

  const gitProbe = probeGit(input.cwd, input.target);
  if (gitProbe.available) {
    sourcesScanned.push('git');
    seeds.push(...gitProbe.hotspotSeeds);
  }

  const uniqueSeeds = dedupeSeeds(seeds);
  const summary = buildSummary({
    agentsPresent,
    gitAvailable: gitProbe.available,
    repoAnalysis,
    seeds: uniqueSeeds,
    target: input.target,
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
    }),
    seeds: uniqueSeeds.map((seed) => MemorySeedDocumentSchema.parse({
      ...seed,
      schema_version: DERIVED_SCHEMA_VERSION,
    })),
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

  return {
    available: true,
    repoFingerprint,
    hotspotSeeds,
  };
}

function persistBootstrapArtifacts(artifacts: BuildBootstrapArtifactsResult, cwd: string): void {
  ensureBootstrapDirs(cwd);
  saveVersionedJsonFile('bootstrap_profile', bootstrapProfilePath(cwd), artifacts.profile);

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
  return path.join(memoryDir(cwd), 'bootstrap');
}

function bootstrapSeedsDir(cwd?: string): string {
  return path.join(bootstrapDir(cwd), 'seeds');
}

function bootstrapProfilePath(cwd?: string): string {
  return path.join(bootstrapDir(cwd), PROFILE_FILE);
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
  agentsPresent: boolean;
  gitAvailable: boolean;
  repoAnalysis: ReturnType<typeof analyzeRepository>;
  seeds: MemorySeedDocument[];
  target?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Bootstrap summary${input.target ? ` for ${input.target}` : ''}: ${input.seeds.length} derived signal(s).`);
  parts.push(`Repository mode looks ${input.repoAnalysis.recommendedMode}.`);
  if (input.agentsPresent) {
    parts.push('AGENTS.md detected and summarized.');
  }
  if (input.gitAvailable) {
    parts.push('Git history available for hotspot detection.');
  }
  const commandCount = input.seeds.filter((seed) => seed.seed_kind === 'command').length;
  if (commandCount > 0) {
    parts.push(`${commandCount} command-oriented hint(s) found.`);
  }
  return parts.join(' ');
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
    case 'entrypoint':
      return 8;
    case 'command':
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
