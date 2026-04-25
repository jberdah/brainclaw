import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { listAgentIdentities, resolveCurrentAgentIdentity } from '../core/agent-registry.js';
import { listCapabilities as listRegistryCapabilities, listTools as listRegistryTools } from '../core/registries.js';
import { buildReputationSummary } from '../core/reputation.js';
import { buildCircuitBreakerSnapshot } from '../core/circuit-breaker.js';
import { loadState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { doctorCheck } from '../core/security.js';
import { getVisibleMemoryVersion, readContextMarker } from '../core/freshness.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadProjectIdentity, projectIdentityExists } from '../core/project-registry.js';
import { findInstructionConflicts, loadInstructions } from '../core/instructions.js';
import { memoryExists, memoryPath, readFileSync, resolveEntityDir, memoryDir, REQUIRED_ENTITY_SUBDIRS } from '../core/io.js';
import { logger } from '../core/logger.js';
import { cleanupStaleCandidates, listCandidates, listArchivedCandidates } from '../core/candidates.js';
import { listClaims, isClaimExpired, assessClaimLiveness } from '../core/claims.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { isTrapExpired, listOperationalTraps } from '../core/traps.js';
import { scanText } from '../core/security.js';
import { isTaskLifecycleRuntimeEvent, listRuntimeEvents } from '../core/events.js';
import { resolveEventSessionId } from '../core/identity.js';
import { detectContradictions } from '../core/contradictions.js';
import { loadVersionedJsonFile, scanMigrationStatus } from '../core/migration.js';
import { buildAgentToolingContext } from '../core/agent-context.js';
import { assessAgentIntegrationReadiness } from '../core/agent-integrations.js';
import { assessBrainclawVersion, detectConcurrentInstallations } from '../core/brainclaw-version.js';
import { resolveStoreChain } from '../core/store-resolution.js';
import { listWorktrees, detectSharedCheckoutRisk } from '../core/worktree.js';
import { resolveCrossProjectLinks, detectCrossProjectCycles } from '../core/cross-project.js';
import { auditLocalAgentWorkspaceFiles, ensureGitignoreEntries, patchAllMcpConfigs } from '../core/agent-files.js';
import { summarizeWorkspaceProjects } from '../core/workspace-projects.js';
import { detectStaleness, staleSummary } from '../core/staleness.js';
import { InboxMessageSchema, type Handoff, type InboxMessage } from '../core/schema.js';
import { resolvePrimaryStore } from '../core/store-resolution.js';
import { runPostMigrationHealthCheck } from '../core/upgrades/health-check.js';

const BACKLOG_KEYWORDS = /\b(TODO|NEXT|backlog|next[\s-]step|action[\s-]item|prochaine?s?\s+étapes?|à\s+faire)\b/i;
const NON_MESSAGE_INBOX_SUBDIRS = new Set(['accepted', 'rejected', 'cross-project']);
export const MCP_RUNTIME_REPAIR_COMMAND = 'brainclaw doctor --repair';
export const MCP_WORKER_RELATIVE_PATH = 'dist/commands/mcp-worker.js';
const DIST_CLI_RELATIVE_PATH = 'dist/cli.js';
const DIST_BUILD_MANIFEST_RELATIVE_PATH = 'dist/.brainclaw-build.json';
const ACTIONABLE_BACKLOG_LINE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'unchecked_task', re: /^\s*(?:[-*•]\s*)?\[\s*\]\s+.+$/i },
  { name: 'todo_line', re: /^\s*(?:[-*•]\s*)?TODO\b.*$/i },
  { name: 'backlog_line', re: /^\s*(?:[-*•]\s*)?backlog:\s*.+$/i },
  { name: 'next_steps_line', re: /^\s*(?:[-*•]\s*)?next steps:\s*.+$/i },
  { name: 'should_do_line', re: /^\s*(?:[-*•]\s*)?should do\b.*$/i },
  { name: 'needs_to_be_done_line', re: /^\s*(?:[-*•]\s*)?needs to be done\b.*$/i },
];
const FORMAL_PLAN_REFERENCE_RE = /\bpln_[a-z0-9]+\b/i;

function hasBacklogPatterns(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const bulletOrNumbered = lines.some(
    (l) => /^\s*[-*•]\s+\w/.test(l) || /^\s*\d+\.\s+\w/.test(l),
  );
  return bulletOrNumbered || BACKLOG_KEYWORDS.test(text) || /\[[ x]\]/.test(text);
}

interface BacklogWithoutPlanFinding {
  handoff_id: string;
  matched_pattern: string;
  snippet: string;
  suggestion: string;
}

function truncateDoctorSnippet(text: string, maxLength = 140): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function hasFormalPlanLink(handoff: Handoff): boolean {
  return Boolean(handoff.plan_id)
    || FORMAL_PLAN_REFERENCE_RE.test(handoff.text)
    || Boolean(handoff.contract?.linked_plans?.length);
}

export function extractBacklogWithoutPlanFindings(handoff: Handoff): BacklogWithoutPlanFinding[] {
  if (hasFormalPlanLink(handoff)) {
    return [];
  }

  const findings: BacklogWithoutPlanFinding[] = [];
  for (const line of handoff.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    for (const pattern of ACTIONABLE_BACKLOG_LINE_PATTERNS) {
      if (!pattern.re.test(line)) {
        continue;
      }

      findings.push({
        handoff_id: handoff.id,
        matched_pattern: pattern.name,
        snippet: truncateDoctorSnippet(trimmed),
        suggestion: 'Create a formal plan item with `brainclaw plan create "<text>"` and link the handoff to the resulting pln_xxx.',
      });
      break;
    }
  }

  return findings;
}

export interface DoctorOptions {
  json?: boolean;
  cwd?: string;
  migrationCheck?: boolean;
  fixAgentIgnore?: boolean;
  fix?: boolean;
  repair?: boolean;
  /**
   * Run the post-migration health check (v1.0 schema upgrade invariants)
   * and exit non-zero on any failure. Skips the normal doctor suite.
   */
  afterMigration?: boolean;
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: unknown;
}

interface DistBuildManifest {
  schema_version: 1;
  generated_at: string;
  src_hash: string;
  dist_hash: string;
}

export interface McpRuntimeHealth {
  ok: boolean;
  status: 'ok' | 'missing' | 'stale';
  message: string;
  repair_command: string;
  missing_path?: string;
  missing_files: string[];
  src_hash?: string;
  dist_hash?: string;
  manifest_src_hash?: string;
  manifest_dist_hash?: string;
  manifest_path: string;
}

interface DoctorRepairResult {
  ok: boolean;
  repaired: boolean;
  reason: 'ok' | 'missing' | 'stale';
  repair_command: string;
  missing_path?: string;
  missing_files: string[];
  manifest_path: string;
  cli_version?: string;
}

/**
 * Machine-readable repair candidate emitted by a doctor check (pln#397 stp_b5337e30).
 *
 * The execution flow in stp_b31fbe23 consumes this shape to drive safe,
 * non-destructive repairs without operators needing to run `brainclaw init
 * --force` or hand-edit the store.
 *
 * `safe: true` means the action is either pure creation (mkdir, append .gitignore
 * entry, backup-and-rewrite) or observably idempotent. `safe: false` is reserved
 * for actions that can lose data (releasing an adopted claim, dropping an
 * orphaned message) and MUST prompt before running.
 */
export interface RepairCandidate {
  /** Stable, machine-readable verb: 'mkdir' | 'patch_mcp_config' | 'move_inbox_message' | 'release_stale_claim' | 'apply_migration' | 'prune_agents_list'. */
  action: string;
  /** Path or entity id the action operates on. */
  target: string;
  /** Human-readable description shown to operators before execution. */
  description: string;
  /** True when the action cannot lose data. False requires confirmation. */
  safe: boolean;
  /** Name of the DoctorCheck that produced this candidate. */
  related_check: string;
}

interface InboxMessageAudit {
  checked: number;
  invalid: Array<{ path: string; error: string }>;
  orphaned: Array<{ path: string; reason: string }>;
}

function listJsonFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath).sort()) {
    const fullPath = path.join(dirPath, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      files.push(...listJsonFilesRecursive(fullPath));
      continue;
    }

    if (entry.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeInboxAgentName(agent: string): string {
  return agent.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function toRelativeDoctorPath(filepath: string, cwd?: string): string {
  return path.relative(cwd ?? process.cwd(), filepath).replace(/\\/g, '/');
}

function resolveDoctorPath(relativePath: string, cwd?: string): string {
  return path.resolve(cwd ?? process.cwd(), ...relativePath.split('/'));
}

function listFilesForHash(rootPath: string, includeFile: (filepath: string) => boolean): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const files: string[] = [];
  const walk = (currentPath: string): void => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && includeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  };

  walk(rootPath);
  return files;
}

function hashFiles(rootPath: string, files: string[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }

  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(rootPath, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computeSourceTreeHash(cwd?: string): string | undefined {
  const effectiveCwd = cwd ?? process.cwd();
  const rootFiles = [path.join(effectiveCwd, 'tsconfig.json'), path.join(effectiveCwd, 'package.json')]
    .filter((filepath) => fs.existsSync(filepath));
  const srcFiles = listFilesForHash(path.join(effectiveCwd, 'src'), (filepath) => filepath.endsWith('.ts'));
  const scriptFiles = [path.join(effectiveCwd, 'scripts', 'copy-default-profiles.mjs')]
    .filter((filepath) => fs.existsSync(filepath));
  return hashFiles(effectiveCwd, [...rootFiles, ...srcFiles, ...scriptFiles]);
}

function getLatestMtimeMs(files: string[]): number {
  return files.reduce((latest, filepath) => {
    try {
      return Math.max(latest, fs.statSync(filepath).mtimeMs);
    } catch {
      return latest;
    }
  }, 0);
}

function collectSourceTreeFiles(cwd?: string): string[] {
  const effectiveCwd = cwd ?? process.cwd();
  const rootFiles = [path.join(effectiveCwd, 'tsconfig.json'), path.join(effectiveCwd, 'package.json')]
    .filter((filepath) => fs.existsSync(filepath));
  const srcFiles = listFilesForHash(path.join(effectiveCwd, 'src'), (filepath) => filepath.endsWith('.ts'));
  const scriptFiles = [path.join(effectiveCwd, 'scripts', 'copy-default-profiles.mjs')]
    .filter((filepath) => fs.existsSync(filepath));
  return [...rootFiles, ...srcFiles, ...scriptFiles];
}

function computeDistTreeHash(cwd?: string): string | undefined {
  const distRoot = path.join(cwd ?? process.cwd(), 'dist');
  const distFiles = listFilesForHash(distRoot, (filepath) => {
    const rel = path.relative(distRoot, filepath).replace(/\\/g, '/');
    return !rel.startsWith('.')
      && (filepath.endsWith('.js') || filepath.endsWith('.d.ts') || filepath.endsWith('.yaml'));
  });
  return hashFiles(distRoot, distFiles);
}

function collectDistTreeFiles(cwd?: string): string[] {
  const distRoot = path.join(cwd ?? process.cwd(), 'dist');
  return listFilesForHash(distRoot, (filepath) => {
    const rel = path.relative(distRoot, filepath).replace(/\\/g, '/');
    return !rel.startsWith('.')
      && (filepath.endsWith('.js') || filepath.endsWith('.d.ts') || filepath.endsWith('.yaml'));
  });
}

function readDistBuildManifest(cwd?: string): DistBuildManifest | undefined {
  const manifestPath = resolveDoctorPath(DIST_BUILD_MANIFEST_RELATIVE_PATH, cwd);
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DistBuildManifest;
    if (parsed && parsed.schema_version === 1 && typeof parsed.src_hash === 'string' && typeof parsed.dist_hash === 'string') {
      return parsed;
    }
  } catch {
    // ignored — invalid manifest means stale runtime and will be rebuilt
  }
  return undefined;
}

function writeDistBuildManifest(cwd: string, srcHash: string, distHash: string): void {
  const manifestPath = resolveDoctorPath(DIST_BUILD_MANIFEST_RELATIVE_PATH, cwd);
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    src_hash: srcHash,
    dist_hash: distHash,
  }, null, 2));
}

export function resolveMcpWorkerMissingPath(cwd?: string): string {
  return resolveDoctorPath(MCP_WORKER_RELATIVE_PATH, cwd);
}

export function isBrainclawRepoCwd(cwd?: string): boolean {
  // dist/ runtime checks resolve paths relative to cwd; that only makes sense
  // when cwd is the brainclaw source/install root. For every other cwd (a
  // user's project, a test workspace), dist/ does not and should not exist.
  const effectiveCwd = cwd ?? process.cwd();
  if (fs.existsSync(path.join(effectiveCwd, 'src', 'commands', 'mcp.ts'))) {
    return true;
  }
  if (fs.existsSync(path.join(effectiveCwd, 'dist', 'commands', 'mcp.js'))) {
    return true;
  }
  return false;
}

export function getMcpRuntimeHealth(cwd?: string): McpRuntimeHealth {
  const effectiveCwd = cwd ?? process.cwd();
  const manifestPath = resolveDoctorPath(DIST_BUILD_MANIFEST_RELATIVE_PATH, effectiveCwd);
  const cliPath = resolveDoctorPath(DIST_CLI_RELATIVE_PATH, effectiveCwd);
  const workerPath = resolveMcpWorkerMissingPath(effectiveCwd);
  const missingFiles = [cliPath, workerPath].filter((filepath) => !fs.existsSync(filepath));
  const srcHash = computeSourceTreeHash(effectiveCwd);
  const distHash = computeDistTreeHash(effectiveCwd);
  const manifest = readDistBuildManifest(effectiveCwd);
  const latestSourceMtime = getLatestMtimeMs(collectSourceTreeFiles(effectiveCwd));
  const latestDistMtime = getLatestMtimeMs(collectDistTreeFiles(effectiveCwd));

  if (missingFiles.length > 0 || !distHash) {
    return {
      ok: false,
      status: 'missing',
      message: `dist/ runtime is missing required artifacts. Run "${MCP_RUNTIME_REPAIR_COMMAND}" to rebuild dist/.`,
      repair_command: MCP_RUNTIME_REPAIR_COMMAND,
      missing_path: missingFiles[0],
      missing_files: missingFiles.map((filepath) => toRelativeDoctorPath(filepath, effectiveCwd)),
      src_hash: srcHash,
      dist_hash: distHash,
      manifest_src_hash: manifest?.src_hash,
      manifest_dist_hash: manifest?.dist_hash,
      manifest_path: toRelativeDoctorPath(manifestPath, effectiveCwd),
    };
  }

  if (!manifest) {
    if (latestSourceMtime > latestDistMtime) {
      return {
        ok: false,
        status: 'stale',
        message: `dist/ appears older than src/. Run "${MCP_RUNTIME_REPAIR_COMMAND}" to rebuild dist/.`,
        repair_command: MCP_RUNTIME_REPAIR_COMMAND,
        missing_files: [],
        src_hash: srcHash,
        dist_hash: distHash,
        manifest_path: toRelativeDoctorPath(manifestPath, effectiveCwd),
      };
    }

    return {
      ok: true,
      status: 'ok',
      message: 'dist/ runtime is healthy (legacy build without hash manifest)',
      repair_command: MCP_RUNTIME_REPAIR_COMMAND,
      missing_files: [],
      src_hash: srcHash,
      dist_hash: distHash,
      manifest_path: toRelativeDoctorPath(manifestPath, effectiveCwd),
    };
  }

  if (!srcHash || manifest.src_hash !== srcHash || manifest.dist_hash !== distHash) {
    return {
      ok: false,
      status: 'stale',
      message: `dist/ is stale relative to src/. Run "${MCP_RUNTIME_REPAIR_COMMAND}" to rebuild dist/.`,
      repair_command: MCP_RUNTIME_REPAIR_COMMAND,
      missing_files: [],
      src_hash: srcHash,
      dist_hash: distHash,
      manifest_src_hash: manifest.src_hash,
      manifest_dist_hash: manifest.dist_hash,
      manifest_path: toRelativeDoctorPath(manifestPath, effectiveCwd),
    };
  }

  return {
    ok: true,
    status: 'ok',
    message: 'dist/ runtime is healthy',
    repair_command: MCP_RUNTIME_REPAIR_COMMAND,
    missing_files: [],
    src_hash: srcHash,
    dist_hash: distHash,
    manifest_src_hash: manifest.src_hash,
    manifest_dist_hash: manifest.dist_hash,
    manifest_path: toRelativeDoctorPath(manifestPath, effectiveCwd),
  };
}

function spawnRepairCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { json?: boolean },
): { ok: boolean; stdout: string; stderr: string; status: number | null; errorCode?: string } {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: options.json ? 'pipe' : 'inherit',
  });

  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    status: result.status,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

function readLocalPackageVersion(cwd: string): string {
  const packageJsonPath = path.join(cwd, 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  return parsed.version ?? 'unknown';
}

function repairDistRuntime(options: DoctorOptions = {}): DoctorRepairResult {
  const cwd = options.cwd ?? process.cwd();
  const before = getMcpRuntimeHealth(cwd);
  if (before.ok) {
    const manifestPath = resolveDoctorPath(DIST_BUILD_MANIFEST_RELATIVE_PATH, cwd);
    if (!fs.existsSync(manifestPath)) {
      const srcHash = computeSourceTreeHash(cwd);
      const distHash = computeDistTreeHash(cwd);
      if (srcHash && distHash) {
        writeDistBuildManifest(cwd, srcHash, distHash);
      }
    }
    const versionResult = spawnRepairCommand(process.execPath, [DIST_CLI_RELATIVE_PATH, '--version'], cwd, { json: true });
    if (!versionResult.ok && versionResult.errorCode !== 'EPERM') {
      throw new Error(versionResult.stderr.trim() || versionResult.stdout.trim() || 'dist/cli.js --version failed');
    }
    const cliVersion = versionResult.ok ? versionResult.stdout.trim() : readLocalPackageVersion(cwd);
    return {
      ok: true,
      repaired: false,
      reason: 'ok',
      repair_command: MCP_RUNTIME_REPAIR_COMMAND,
      missing_path: before.missing_path,
      missing_files: before.missing_files,
      manifest_path: before.manifest_path,
      cli_version: cliVersion,
    };
  }

  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const tscResult = spawnRepairCommand(npxCommand, ['tsc'], cwd, options);
  if (!tscResult.ok) {
    throw new Error(tscResult.stderr.trim() || tscResult.stdout.trim() || 'npx tsc failed');
  }

  const copyProfilesResult = spawnRepairCommand(process.execPath, ['scripts/copy-default-profiles.mjs'], cwd, options);
  if (!copyProfilesResult.ok) {
    throw new Error(copyProfilesResult.stderr.trim() || copyProfilesResult.stdout.trim() || 'copy-default-profiles.mjs failed');
  }

  const versionResult = spawnRepairCommand(process.execPath, [DIST_CLI_RELATIVE_PATH, '--version'], cwd, { json: true });
  if (!versionResult.ok && versionResult.errorCode !== 'EPERM') {
    throw new Error(versionResult.stderr.trim() || versionResult.stdout.trim() || 'dist/cli.js --version failed');
  }
  const cliVersion = versionResult.ok ? versionResult.stdout.trim() : readLocalPackageVersion(cwd);

  const srcHash = computeSourceTreeHash(cwd);
  const distHash = computeDistTreeHash(cwd);
  if (!srcHash || !distHash) {
    throw new Error('Rebuild completed but runtime hash could not be computed');
  }
  writeDistBuildManifest(cwd, srcHash, distHash);

  const after = getMcpRuntimeHealth(cwd);
  if (!after.ok) {
    throw new Error(after.message);
  }

  return {
    ok: true,
    repaired: true,
    reason: before.status,
    repair_command: MCP_RUNTIME_REPAIR_COMMAND,
    missing_path: before.missing_path,
    missing_files: before.missing_files,
    manifest_path: after.manifest_path,
    cli_version: cliVersion,
  };
}

/**
 * Return the absolute paths of entity subdirectories that should exist under
 * `.brainclaw/` but don't. Source of truth is REQUIRED_ENTITY_SUBDIRS in
 * core/io.ts (pln#397 stp_b5337e30).
 */
function scanMissingEntitySubdirs(cwd?: string): string[] {
  const root = memoryDir(cwd);
  if (!fs.existsSync(root)) return [];
  const missing: string[] = [];
  for (const subdir of REQUIRED_ENTITY_SUBDIRS) {
    const full = path.join(root, subdir);
    if (!fs.existsSync(full)) missing.push(full);
  }
  return missing;
}

function auditInboxMessages(cwd?: string): InboxMessageAudit {
  const effectiveCwd = cwd ?? process.cwd();
  const inboxRoot = resolveEntityDir('inbox', effectiveCwd, 'read');
  const result: InboxMessageAudit = {
    checked: 0,
    invalid: [],
    orphaned: [],
  };

  if (!fs.existsSync(inboxRoot)) {
    return result;
  }

  for (const entry of fs.readdirSync(inboxRoot).sort()) {
    const fullPath = path.join(inboxRoot, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isFile() && entry.endsWith('.json')) {
      try {
        loadVersionedJsonFile<InboxMessage>('message', fullPath);
        result.orphaned.push({
          path: toRelativeDoctorPath(fullPath, effectiveCwd),
          reason: 'message file is stored at inbox root instead of an agent subdirectory',
        });
      } catch {
        // Pending candidate files also live at inbox root; ignore non-message documents here.
      }
      continue;
    }

    if (!stat.isDirectory() || NON_MESSAGE_INBOX_SUBDIRS.has(entry)) {
      continue;
    }

    for (const filepath of listJsonFilesRecursive(fullPath)) {
      try {
        const parsed = loadVersionedJsonFile<InboxMessage>('message', filepath);
        const message = InboxMessageSchema.parse(parsed.document);
        result.checked += 1;

        const expectedDir = normalizeInboxAgentName(message.to);
        if (expectedDir !== entry) {
          result.orphaned.push({
            path: toRelativeDoctorPath(filepath, effectiveCwd),
            reason: `message targets '${message.to}' but is stored under '${entry}'`,
          });
        }
      } catch (error: unknown) {
        result.invalid.push({
          path: toRelativeDoctorPath(filepath, effectiveCwd),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

export function runDoctor(options: DoctorOptions = {}): void {
  if (options.repair) {
    try {
      const result = repairDistRuntime(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.repaired) {
        console.log(`✔ Rebuilt dist/ (${result.reason})`);
        console.log(`✔ Verified runtime: ${result.cli_version ?? 'unknown version'}`);
        console.log(`✔ Updated hash manifest: ${result.manifest_path}`);
      } else {
        console.log(`✔ dist/ runtime already healthy (${result.cli_version ?? 'unknown version'})`);
      }
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({
          ok: false,
          repaired: false,
          repair_command: MCP_RUNTIME_REPAIR_COMMAND,
          error: message,
        }, null, 2));
      } else {
        console.error(`✗ Repair failed: ${message}`);
      }
      process.exit(1);
    }
  }

  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (options.afterMigration) {
    runAfterMigrationCheck(options);
    return;
  }

  let hasIssues = false;
  const checks: DoctorCheck[] = [];
  const repairCandidates: RepairCandidate[] = [];
  let migrationEntries = [] as ReturnType<typeof scanMigrationStatus>;
  let agentGitHygieneFixed: string[] = [];

  // pln#397 stp_b5337e30: scan entity-aligned subdirectories and emit safe
  // mkdir repair candidates for any that are missing. Runs before other
  // checks so downstream validators don't emit cascading "not found" noise.
  const missingDirs = scanMissingEntitySubdirs(options.cwd);
  if (missingDirs.length > 0) {
    const rel = missingDirs.map((p) => toRelativeDoctorPath(p, options.cwd));
    checks.push({
      name: 'entity_subdirs',
      status: 'warn',
      message: `${missingDirs.length} required subdirectorie(s) missing from .brainclaw/`,
      details: { missing: rel },
    });
    for (const dir of missingDirs) {
      repairCandidates.push({
        action: 'mkdir',
        target: toRelativeDoctorPath(dir, options.cwd),
        description: `Create missing entity subdirectory ${toRelativeDoctorPath(dir, options.cwd)}`,
        safe: true,
        related_check: 'entity_subdirs',
      });
    }
    hasIssues = true;
    if (!options.json) {
      console.warn(`⚠ ${missingDirs.length} required subdirectorie(s) missing under .brainclaw/:`);
      for (const p of rel) {
        console.warn(`  - ${p}`);
      }
    }
  } else {
    checks.push({ name: 'entity_subdirs', status: 'ok', message: 'all entity subdirectories present' });
    if (!options.json) {
      console.log('✔ all entity subdirectories present');
    }
  }

  // Validate config
  let config;
  try {
    config = loadConfig(options.cwd);
    checks.push({ name: 'config', status: 'ok', message: 'config.yaml is valid' });
    if (!options.json) {
      console.log('✔ config.yaml is valid');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'config', status: 'error', message: `config.yaml is invalid: ${msg}` });
    console.error(`✗ config.yaml is invalid: ${msg}`);
    hasIssues = true;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, checks, metrics: {} }, null, 2));
    }
    return;
  }

  if (options.fixAgentIgnore) {
    const initialAudit = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());
    if (initialAudit.missingGitignorePaths.length > 0) {
      ensureGitignoreEntries(options.cwd ?? process.cwd(), initialAudit.missingGitignorePaths);
      agentGitHygieneFixed = initialAudit.missingGitignorePaths;
      if (!options.json) {
        console.log(`✔ Added generated local agent files to .gitignore: ${agentGitHygieneFixed.join(', ')}`);
      }
    }
  }

  if (isBrainclawRepoCwd(options.cwd)) {
    const mcpRuntimeHealth = getMcpRuntimeHealth(options.cwd);
    if (mcpRuntimeHealth.ok) {
      checks.push({
        name: 'mcp_runtime',
        status: 'ok',
        message: mcpRuntimeHealth.message,
        details: mcpRuntimeHealth,
      });
      if (!options.json) {
        console.log('✔ MCP runtime: dist/ is healthy');
      }
    } else {
      checks.push({
        name: 'mcp_runtime',
        status: mcpRuntimeHealth.status === 'missing' ? 'error' : 'warn',
        message: mcpRuntimeHealth.message,
        details: mcpRuntimeHealth,
      });
      if (!options.json) {
        const glyph = mcpRuntimeHealth.status === 'missing' ? '✗' : '⚠';
        console.warn(`${glyph} MCP runtime: ${mcpRuntimeHealth.message}`);
        if (mcpRuntimeHealth.missing_path) {
          console.warn(`  Missing path: ${toRelativeDoctorPath(mcpRuntimeHealth.missing_path, options.cwd)}`);
        }
        console.warn(`  Repair: ${mcpRuntimeHealth.repair_command}`);
      }
      hasIssues = true;
    }
  }

  // Validate state
  let state;
  try {
    state = loadState(options.cwd);
    checks.push({ name: 'state', status: 'ok', message: 'state is valid' });
    if (!options.json) {
      console.log('✔ state is valid');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'state', status: 'error', message: `state is invalid: ${msg}` });
    console.error(`✗ state is invalid: ${msg}`);
    hasIssues = true;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, checks, metrics: {} }, null, 2));
    }
    return;
  }

  if (options.migrationCheck) {
    migrationEntries = scanMigrationStatus(options.cwd);
    const outdated = migrationEntries.filter((entry) => entry.status === 'outdated');
    const invalid = migrationEntries.filter((entry) => entry.status === 'invalid');

    if (outdated.length > 0) {
      checks.push({
        name: 'schema_migrations',
        status: 'warn',
        message: `${outdated.length} document(s) require schema migration.`,
      });
      if (!options.json) {
        console.warn(`⚠ ${outdated.length} document(s) require schema migration.`);
        for (const entry of outdated.slice(0, 20)) {
          console.warn(`  - ${entry.path} [${entry.documentType}] v${entry.detectedVersion} -> v${entry.currentVersion}`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'schema_migrations',
        status: 'ok',
        message: 'No documents require schema migration',
      });
      if (!options.json) {
        console.log('✔ No documents require schema migration');
      }
    }

    if (invalid.length > 0) {
      checks.push({
        name: 'schema_migration_errors',
        status: 'error',
        message: `${invalid.length} document(s) are invalid or unreadable for migration.`,
      });
      if (!options.json) {
        console.warn(`⚠ ${invalid.length} document(s) are invalid or unreadable for migration.`);
        for (const entry of invalid.slice(0, 20)) {
          console.warn(`  - ${entry.path} [${entry.documentType}] ${entry.error ?? 'invalid document'}`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'schema_migration_errors',
        status: 'ok',
        message: 'No invalid versioned documents found',
      });
    }
  }

  const workspaceProjects = summarizeWorkspaceProjects(options.cwd ?? process.cwd(), config);
  if (config.project_mode === 'multi-project' && workspaceProjects.effective_project_count === 0) {
    checks.push({
      name: 'project_mode',
      status: 'warn',
      message: config.projects?.strategy === 'folder'
        ? 'project_mode is multi-project with folder strategy but no child projects were resolved from config, registry, or nested stores yet.'
        : 'project_mode is multi-project but no project namespaces are configured yet.',
    });
    if (!options.json) {
      console.warn(config.projects?.strategy === 'folder'
        ? '⚠ project_mode is multi-project with folder strategy but no child projects were resolved from config, registry, or nested stores yet.'
        : '⚠ project_mode is multi-project but no project namespaces are configured yet.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'project_mode',
      status: 'ok',
      message: `project_mode=${config.project_mode}, strategy=${config.projects?.strategy ?? 'manual'}, configured_projects=${workspaceProjects.configured_projects.length}, effective_projects=${workspaceProjects.effective_project_count}`,
      details: workspaceProjects,
    });
    if (!options.json) {
      console.log(`✔ project mode: ${config.project_mode} (${config.projects?.strategy ?? 'manual'}), effective projects=${workspaceProjects.effective_project_count}`);
    }
  }

  try {
    if (projectIdentityExists(options.cwd)) {
      const projectIdentity = loadProjectIdentity(options.cwd);
      if (!config.project_id) {
        checks.push({
          name: 'project_identity',
          status: 'warn',
          message: `project.identity.json exists but config.yaml has no project_id. Expected ${projectIdentity.project_id}.`,
        });
        if (!options.json) {
          console.warn(`⚠ project.identity.json exists but config.yaml has no project_id. Expected ${projectIdentity.project_id}.`);
        }
        hasIssues = true;
      } else if (config.project_id !== projectIdentity.project_id) {
        checks.push({
          name: 'project_identity',
          status: 'warn',
          message: `project_id mismatch between config.yaml (${config.project_id}) and project.identity.json (${projectIdentity.project_id}).`,
        });
        if (!options.json) {
          console.warn(`⚠ project_id mismatch between config.yaml (${config.project_id}) and project.identity.json (${projectIdentity.project_id}).`);
        }
        hasIssues = true;
      } else {
        checks.push({
          name: 'project_identity',
          status: 'ok',
          message: `project_id=${projectIdentity.project_id}`,
        });
        if (!options.json) {
          console.log(`✔ project identity: ${projectIdentity.project_id}`);
        }
      }
    } else if (config.project_id) {
      checks.push({
        name: 'project_identity',
        status: 'warn',
        message: `config.yaml has project_id=${config.project_id} but project.identity.json is missing.`,
      });
      if (!options.json) {
        console.warn(`⚠ config.yaml has project_id=${config.project_id} but project.identity.json is missing.`);
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'project_identity',
        status: 'ok',
        message: 'No project identity configured yet',
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'project_identity', status: 'warn', message: `project identity is invalid: ${msg}` });
    if (!options.json) {
      console.warn(`⚠ project identity is invalid: ${msg}`);
    }
    hasIssues = true;
  }

  try {
    const registeredAgents = listAgentIdentities(options.cwd);
    // Agent identity check: verify the detected agent is registered (env vars + detectAiAgent).
    // config.current_agent is NOT checked — it's a legacy singleton, not an identity source.
    const detectedAgent = resolveCurrentAgentIdentity(options.cwd);
    if (detectedAgent) {
      checks.push({
        name: 'agent_identity',
        status: 'ok',
        message: `detected_agent=${detectedAgent.agent_name}, agent_id=${detectedAgent.agent_id}, registered_agents=${registeredAgents.length}`,
      });
      if (!options.json) {
        console.log(`✔ detected agent: ${detectedAgent.agent_name} (${detectedAgent.agent_id})`);
      }
    } else {
      checks.push({
        name: 'agent_identity',
        status: 'warn',
        message: `No agent detected from environment (${registeredAgents.length} registered agent(s)). Set BRAINCLAW_AGENT or run from an agent terminal.`,
      });
      if (!options.json) {
        console.warn(`⚠ No agent detected from environment (${registeredAgents.length} registered). Set BRAINCLAW_AGENT or run from an agent terminal.`);
      }
      hasIssues = true;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'agent_identity', status: 'warn', message: `agent identity is invalid: ${msg}` });
    if (!options.json) {
      console.warn(`⚠ agent identity is invalid: ${msg}`);
    }
    hasIssues = true;
  }

  // Warn if no curator is registered
  try {
    const allAgents = listAgentIdentities(options.cwd);
    const hasCurator = allAgents.some((a) => a.trust_level === 'curator');
    if (!hasCurator && allAgents.length > 0) {
      checks.push({
        name: 'no_curator',
        status: 'warn',
        message: 'No curator registered. Run `brainclaw set-trust <agent> --level curator` or `brainclaw register-agent <name> --curator` to designate a project owner.',
      });
      if (!options.json) {
        console.warn('⚠ No curator registered — run `brainclaw set-trust <agent> --level curator` to designate a project owner.');
      }
    }
  } catch { /* non-fatal */ }

  const agentTooling = buildAgentToolingContext({ cwd: options.cwd });
  if (agentTooling.agents_md_present && agentTooling.agents_rules.length === 0) {
    checks.push({
      name: 'agent_rules',
      status: 'warn',
      message: 'AGENTS.md is present but no actionable rules were extracted.',
    });
    if (!options.json) {
      console.warn('⚠ AGENTS.md is present but no actionable rules were extracted.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_rules',
      status: 'ok',
      message: agentTooling.agents_md_present
        ? `${agentTooling.agents_rules.length} actionable agent rule(s) detected`
        : 'No AGENTS.md detected',
    });
  }

  const incompleteSkills = agentTooling.skills.filter((skill) => !skill.description && !skill.scripts_present && !skill.references_present && !skill.assets_present);
  if (incompleteSkills.length > 0) {
    checks.push({
      name: 'agent_skills',
      status: 'warn',
      message: `${incompleteSkills.length} skill(s) look incomplete or under-described.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${incompleteSkills.length} skill(s) look incomplete or under-described.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_skills',
      status: 'ok',
      message: `${agentTooling.skills.length} skill(s) inventoried`,
    });
  }

  const missingMcpCommands = agentTooling.mcp_servers.filter((server) => server.availability === 'missing_command');
  if (missingMcpCommands.length > 0) {
    checks.push({
      name: 'agent_mcp',
      status: 'warn',
      message: `${missingMcpCommands.length} stdio MCP server(s) are configured with a missing local command.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${missingMcpCommands.length} stdio MCP server(s) are configured with a missing local command.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_mcp',
      status: 'ok',
      message: `${agentTooling.mcp_servers.length} MCP server(s) inventoried`,
    });
  }

  const integrationReadiness = assessAgentIntegrationReadiness(config, options.cwd ?? process.cwd());
  const missingIntegrations = integrationReadiness.filter((entry) => !entry.ready);
  
  if (options.fix && missingIntegrations.some(m => m.missing_surfaces.some(s => s.kind === 'mcp') || m.drifting_surfaces.length > 0)) {
    const results = patchAllMcpConfigs(options.cwd ?? process.cwd());
    // Re-evaluate readiness
    const refreshedReadiness = assessAgentIntegrationReadiness(config, options.cwd ?? process.cwd());
    const fixedAgents = missingIntegrations.filter(initial => {
      const current = refreshedReadiness.find(r => r.agent_name === initial.agent_name);
      return current?.ready;
    }).map(r => r.agent_name);
    
    if (!options.json) {
      console.log(`\n✔ Applied --fix: Patched ${results.length} MCP config(s) automatically.`);
      if (fixedAgents.length > 0) {
        console.log(`✔ Successfully restored: ${fixedAgents.join(', ')}`);
      }
    }
    missingIntegrations.length = 0;
    missingIntegrations.push(...refreshedReadiness.filter((entry) => !entry.ready));
  }

  if (missingIntegrations.length > 0) {
    checks.push({
      name: 'agent_integrations',
      status: 'warn',
      message: `${missingIntegrations.length} declared agent integration(s) are not fully activated or are drifting.`,
      details: missingIntegrations,
    });
    if (!options.json) {
      console.warn(`⚠ ${missingIntegrations.length} declared agent integration(s) are not fully activated or are drifting.`);
      for (const m of missingIntegrations) {
        console.warn(`  - ${m.agent_name} -> Effective Tier: ${m.effective_tier}`);
        for (const drift of m.drifting_surfaces) {
          console.warn(`    ↳ Drift: ${drift.drift_message}`);
        }
        for (const g of m.self_healing_guidance) {
          console.warn(`    ↳ ${g}`);
        }
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_integrations',
      status: 'ok',
      message: `${integrationReadiness.length} declared agent integration(s) are fully activated`,
    });
    if (!options.json) {
      for (const r of integrationReadiness) {
        console.info(`✓ ${r.agent_name} is active -> Effective Tier: ${r.effective_tier}`);
      }
    }
  }

  const agentGitHygiene = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());
  if (!agentGitHygiene.isGitRepo) {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: 'No Git worktree detected; agent git hygiene audit skipped',
    });
  } else if (agentGitHygiene.presentPaths.length === 0) {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: 'No local-only Brainclaw agent files detected in the workspace',
    });
  } else if (agentGitHygiene.hasIssues) {
    const parts: string[] = [];
    if (agentGitHygiene.missingGitignorePaths.length > 0) {
      parts.push(`${agentGitHygiene.missingGitignorePaths.length} file(s) should be added to .gitignore`);
    }
    if (agentGitHygiene.trackedPaths.length > 0) {
      parts.push(`${agentGitHygiene.trackedPaths.length} file(s) are still tracked by Git`);
    }
    const fixHint = agentGitHygiene.missingGitignorePaths.length > 0
      ? ' Run `brainclaw doctor --fix-agent-ignore` to add ignore entries.'
      : '';
    checks.push({
      name: 'agent_git_hygiene',
      status: 'warn',
      message: `${parts.join('; ')}.${fixHint}`.trim(),
      details: agentGitHygiene,
    });
    if (!options.json) {
      console.warn(`⚠ Agent git hygiene: ${parts.join('; ')}.`);
      if (agentGitHygiene.missingGitignorePaths.length > 0) {
        console.warn(`  Missing .gitignore entries: ${agentGitHygiene.missingGitignorePaths.join(', ')}`);
        console.warn('  Fix: run `brainclaw doctor --fix-agent-ignore`');
      }
      if (agentGitHygiene.trackedPaths.length > 0) {
        console.warn(`  Tracked local agent files: ${agentGitHygiene.trackedPaths.join(', ')}`);
        console.warn('  After updating .gitignore, untrack them with `git rm --cached <path>` as needed.');
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'agent_git_hygiene',
      status: 'ok',
      message: `${agentGitHygiene.presentPaths.length} local-only Brainclaw agent file(s) are ignored correctly`,
      details: agentGitHygiene,
    });
    if (!options.json) {
      console.log(`✔ Agent git hygiene: ${agentGitHygiene.presentPaths.length} local-only file(s) are ignored correctly`);
    }
  }

  const brainclawVersion = assessBrainclawVersion(config);
  if (brainclawVersion.status === 'upgrade_required' || brainclawVersion.status === 'invalid_config') {
    checks.push({
      name: 'brainclaw_version',
      status: 'warn',
      message: brainclawVersion.message,
      details: brainclawVersion,
    });
    if (!options.json) {
      console.warn(`⚠ ${brainclawVersion.message}`);
      if (brainclawVersion.upgrade_message) {
        console.warn(`  Benefits: ${brainclawVersion.upgrade_message}`);
      }
      if (brainclawVersion.upgrade_command) {
        console.warn(`  Upgrade: ${brainclawVersion.upgrade_command}`);
      }
    }
    hasIssues = true;
  } else if (brainclawVersion.status === 'update_available') {
    checks.push({
      name: 'brainclaw_version',
      status: 'warn',
      message: brainclawVersion.message,
      details: brainclawVersion,
    });
    if (!options.json) {
      console.warn(`⚠ ${brainclawVersion.message}`);
      if (brainclawVersion.upgrade_message) {
        console.warn(`  Benefits: ${brainclawVersion.upgrade_message}`);
      }
      if (brainclawVersion.upgrade_command) {
        console.warn(`  Upgrade: ${brainclawVersion.upgrade_command}`);
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'brainclaw_version',
      status: 'ok',
      message: brainclawVersion.message,
    });
    if (!options.json) {
      console.log(`✔ ${brainclawVersion.message}`);
    }
  }

  // Check for concurrent brainclaw installations in PATH
  try {
    const installations = detectConcurrentInstallations();
    const uniqueVersions = new Set(installations.map(i => i.version));
    if (installations.length > 1 && uniqueVersions.size > 1) {
      const details = installations.map(i => `${i.path} (${i.version}${i.isCurrent ? ', active' : ''})`).join(', ');
      checks.push({
        name: 'brainclaw_path_conflicts',
        status: 'warn',
        message: `Multiple brainclaw versions in PATH: ${details}. The first in PATH will be used by CLI; MCP uses absolute path.`,
        details: { installations },
      });
      if (!options.json) {
        console.warn(`⚠ Multiple brainclaw versions in PATH:`);
        for (const inst of installations) {
          console.warn(`  ${inst.isCurrent ? '→' : ' '} ${inst.path} (${inst.version})`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'brainclaw_path_conflicts',
        status: 'ok',
        message: installations.length > 0
          ? `Single brainclaw in PATH: ${installations[0]!.path} (${installations[0]!.version})`
          : 'No brainclaw found in PATH (using direct invocation)',
      });
    }
  } catch {
    // Non-fatal — PATH scan failure should not block doctor
    checks.push({ name: 'brainclaw_path_conflicts', status: 'ok', message: 'PATH scan skipped' });
  }

  // Check project.md consistency
  try {
    const currentMd = readFileSync(memoryPath('project.md', options.cwd));
    const expectedMd = generateMarkdown(state, options.cwd);
    if (currentMd === expectedMd) {
      checks.push({ name: 'markdown_sync', status: 'ok', message: 'project.md is in sync with state' });
      if (!options.json) {
        console.log('✔ project.md is in sync with state');
      }
    } else {
      checks.push({ name: 'markdown_sync', status: 'warn', message: 'project.md is out of sync with state. Run `brainclaw rebuild` to fix.' });
      console.warn('⚠ project.md is out of sync with state. Run `brainclaw rebuild` to fix.');
      hasIssues = true;
    }
  } catch (err) {
    logger.debug('Failed to check project.md sync:', err);
    checks.push({ name: 'markdown_sync', status: 'warn', message: 'project.md is missing. Run `brainclaw rebuild` to regenerate.' });
    console.warn('⚠ project.md is missing. Run `brainclaw rebuild` to regenerate.');
    hasIssues = true;
  }

  // Security scan on state
  const warnings = doctorCheck(state, config);
  if (warnings.length === 0) {
    checks.push({ name: 'state_security', status: 'ok', message: 'No sensitive content detected in state' });
    if (!options.json) {
      console.log('✔ No sensitive content detected in state');
    }
  } else {
    hasIssues = true;
    checks.push({ name: 'state_security', status: 'warn', message: `${warnings.length} sensitive content warning(s) detected in state` });
    if (!options.json) {
      console.log('');
      console.log('State warnings:');
    }
    for (const w of warnings) {
      if (!options.json) {
        console.warn(`  - ${w.message}`);
      }
    }
  }

  const planItems = state.plan_items;
  const instructions = loadInstructions(options.cwd);
  const activePlans = planItems.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  const blockedPlans = planItems.filter((plan) => plan.status === 'blocked');
  const unassignedInProgress = planItems.filter((plan) => plan.status === 'in_progress' && !plan.assignee);

  if (!options.json) {
    console.log(`✔ Shared plan: ${activePlans.length} active, ${blockedPlans.length} blocked`);
  }

  if (unassignedInProgress.length > 0) {
    checks.push({
      name: 'plan_assignment',
      status: 'warn',
      message: `${unassignedInProgress.length} in-progress plan item(s) have no assignee.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${unassignedInProgress.length} in-progress plan item(s) have no assignee.`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'plan_assignment',
      status: 'ok',
      message: 'All in-progress plan items have an assignee',
    });
  }

  const unknownProjects = activePlans
    .map((plan) => plan.project)
    .filter((project): project is string => typeof project === 'string' && project.length > 0)
    .filter((project) => config.project_mode === 'multi-project' && !config.projects.known.includes(project));
  if (unknownProjects.length > 0) {
    const deduped = [...new Set(unknownProjects)];
    checks.push({
      name: 'plan_projects',
      status: 'warn',
      message: `Plan items reference unknown project namespace(s): ${deduped.join(', ')}`,
    });
    if (!options.json) {
      console.warn(`⚠ Plan items reference unknown project namespace(s): ${deduped.join(', ')}`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'plan_projects',
      status: 'ok',
      message: 'Plan items reference known project namespaces',
    });
  }

  const activeInstructions = instructions.filter((entry) => entry.active);
  const instructionConflicts = findInstructionConflicts(instructions);
  if (!options.json) {
    console.log(`✔ Shared instructions: ${activeInstructions.length} active`);
  }
  if (instructionConflicts.length > 0) {
    const summary = instructionConflicts
      .map((conflict) => `${conflict.layer}${conflict.scope ? `:${conflict.scope}` : ''} (${conflict.ids.join(', ')})`)
      .join('; ');
    checks.push({
      name: 'instruction_conflicts',
      status: 'warn',
      message: `Multiple active instructions share the same layer/scope: ${summary}`,
    });
    if (!options.json) {
      console.warn(`⚠ Multiple active instructions share the same layer/scope: ${summary}`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'instruction_conflicts',
      status: 'ok',
      message: 'Instruction layers resolve without active scope conflicts',
    });
  }

  // --- Reflective memory checks ---
  let pending = listCandidates('pending', options.cwd);
  const accepted = listArchivedCandidates('accepted', options.cwd);
  const rejected = listArchivedCandidates('rejected', options.cwd);
  if (!options.json) {
    console.log('');
    console.log(`Reflective memory: ${pending.length} pending, ${accepted.length} accepted, ${rejected.length} rejected`);
  }

  // Governance checks
  const approvalPolicy = config.governance?.approval_policy ?? 'review';
  const curators = config.governance?.curators ?? [];
  if (approvalPolicy === 'strict' && curators.length === 0) {
    checks.push({ name: 'governance_config', status: 'warn', message: 'governance.approval_policy is strict but no governance.curators are configured.' });
    console.warn('⚠ governance.approval_policy is strict but no governance.curators are configured.');
    hasIssues = true;
  } else {
    checks.push({ name: 'governance_config', status: 'ok', message: `approval_policy=${approvalPolicy}, curators=${curators.length}` });
  }

  const maxPending = config.reflective_memory?.max_pending ?? 50;
  const promotionStarsThreshold = config.reflective_memory?.promotion_stars_threshold ?? 3;
  const promotionUsesThreshold = config.reflective_memory?.promotion_uses_threshold ?? 2;
  const reviewSlaHours = config.governance?.review_sla_hours ?? 24;
  let promotionReady = pending.filter((c) => (c.star_count ?? 0) >= promotionStarsThreshold || (c.usage_count ?? 0) >= promotionUsesThreshold);
  let pendingOverdue = pending.filter((c) => {
    const ageHours = Math.floor((Date.now() - Date.parse(c.created_at)) / (1000 * 60 * 60));
    return ageHours > reviewSlaHours;
  });

  const reviewed = [...accepted, ...rejected]
    .filter((c) => c.resolved_at)
    .map((c) => {
      const created = Date.parse(c.created_at);
      const resolved = Date.parse(c.resolved_at as string);
      return Math.max(0, resolved - created) / (1000 * 60 * 60);
    });
  const avgReviewHours = reviewed.length > 0
    ? reviewed.reduce((sum, value) => sum + value, 0) / reviewed.length
    : 0;

  if (!options.json) {
    console.log(`Governance review KPI: pending_overdue=${pendingOverdue.length}, avg_review_hours=${avgReviewHours.toFixed(1)}, review_sla_hours=${reviewSlaHours}`);
    console.log(`Promotion signal: ${promotionReady.length} candidate(s) reached ${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)`);
  }

  const staleAutoCandidates = cleanupStaleCandidates({
    cwd: options.cwd,
    source: 'auto',
    maxAgeDays: 30,
    dryRun: !options.fix,
  });
  if (staleAutoCandidates.matched > 0) {
    const actionMessage = options.fix
      ? `Removed ${staleAutoCandidates.deleted} stale auto-generated candidate(s) older than 30 days.`
      : `${staleAutoCandidates.matched} stale auto-generated candidate(s) older than 30 days. Run \`brainclaw cleanup-candidates --max-age 30\` or \`brainclaw doctor --fix\`.`;
    checks.push({
      name: 'stale_auto_candidates',
      status: options.fix ? 'ok' : 'warn',
      message: actionMessage,
      details: staleAutoCandidates.candidates.map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        created_at: candidate.created_at,
        text: truncateDoctorSnippet(candidate.text),
      })),
    });
    if (!options.json) {
      if (options.fix) {
        console.log(`✔ ${actionMessage}`);
      } else {
        console.warn(`⚠ ${actionMessage}`);
      }
    }
    if (!options.fix) {
      hasIssues = true;
    }
  } else {
    checks.push({
      name: 'stale_auto_candidates',
      status: 'ok',
      message: 'No stale auto-generated candidates found',
    });
    if (!options.json) {
      console.log('✔ No stale auto-generated candidates found');
    }
  }
  if (options.fix && staleAutoCandidates.deleted > 0) {
    pending = listCandidates('pending', options.cwd);
    promotionReady = pending.filter((c) => (c.star_count ?? 0) >= promotionStarsThreshold || (c.usage_count ?? 0) >= promotionUsesThreshold);
    pendingOverdue = pending.filter((c) => {
      const ageHours = Math.floor((Date.now() - Date.parse(c.created_at)) / (1000 * 60 * 60));
      return ageHours > reviewSlaHours;
    });
  }

  if (promotionReady.length > 0) {
    checks.push({
      name: 'promotion_signals',
      status: 'warn',
      message: `${promotionReady.length} pending candidate(s) reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`,
    });
    if (!options.json) {
      console.warn(`⚠ ${promotionReady.length} pending candidate(s) reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`);
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'promotion_signals',
      status: 'ok',
      message: `No pending candidate reached the promotion threshold (${promotionStarsThreshold} star(s) or ${promotionUsesThreshold} use(s)).`,
    });
  }

  if (pendingOverdue.length > 0) {
    checks.push({ name: 'governance_sla', status: 'warn', message: `${pendingOverdue.length} pending candidate(s) are beyond review SLA (${reviewSlaHours}h).` });
    console.warn(`⚠ ${pendingOverdue.length} pending candidate(s) are beyond review SLA (${reviewSlaHours}h).`);
    hasIssues = true;
  } else {
    checks.push({ name: 'governance_sla', status: 'ok', message: `No pending candidate beyond SLA (${reviewSlaHours}h)` });
  }

  if (pending.length > maxPending) {
    checks.push({ name: 'pending_capacity', status: 'warn', message: `Too many pending candidates (${pending.length} > ${maxPending}).` });
    console.warn(`⚠ Too many pending candidates (${pending.length} > ${maxPending}). Consider reviewing or pruning.`);
    hasIssues = true;
  } else {
    checks.push({ name: 'pending_capacity', status: 'ok', message: `Pending candidates within limit (${pending.length}/${maxPending})` });
  }

  // Scan candidate texts for sensitive content
  const candidateWarnings: string[] = [];
  for (const c of pending) {
    const cw = scanText(c.text, config);
    for (const w of cw) {
      candidateWarnings.push(`${w.message} in candidate ${c.id}`);
    }
  }
  if (candidateWarnings.length > 0) {
    hasIssues = true;
    checks.push({ name: 'candidate_security', status: 'warn', message: `${candidateWarnings.length} warning(s) in pending candidates` });
    if (!options.json) {
      console.log('');
      console.log('Candidate warnings:');
    }
    for (const w of candidateWarnings) {
      if (!options.json) {
        console.warn(`  - ${w}`);
      }
    }
  } else if (pending.length > 0) {
    checks.push({ name: 'candidate_security', status: 'ok', message: 'No sensitive content detected in pending candidates' });
    if (!options.json) {
      console.log('✔ No sensitive content detected in pending candidates');
    }
  } else {
    checks.push({ name: 'candidate_security', status: 'ok', message: 'No pending candidates to scan' });
  }

  // Stale rejected candidates
  const pruneDays = config.reflective_memory?.prune_rejected_after_days ?? 30;
  const cutoff = new Date(Date.now() - pruneDays * 24 * 60 * 60 * 1000).toISOString();
  const staleRejected = rejected.filter(c => (c.resolved_at ?? c.created_at) < cutoff);
  if (staleRejected.length > 0) {
    checks.push({ name: 'rejected_cleanup', status: 'warn', message: `${staleRejected.length} rejected candidate(s) older than ${pruneDays} days.` });
    console.warn(`⚠ ${staleRejected.length} rejected candidate(s) older than ${pruneDays} days. Run \`brainclaw prune-candidates\` to clean up.`);
    hasIssues = true;
  } else {
    checks.push({ name: 'rejected_cleanup', status: 'ok', message: `No stale rejected candidates beyond ${pruneDays} days` });
  }

  // --- Contradiction detection ---
  try {
    const contradictions = detectContradictions(state);
    if (contradictions.length > 0) {
      hasIssues = true;
      checks.push({
        name: 'contradictions',
        status: 'warn',
        message: `${contradictions.length} potential contradiction(s) detected in state.`,
        details: contradictions.slice(0, 5).map((item) => ({
          item_id: item.item_id,
          conflicts_with: item.conflicts_with,
          section: item.section,
          kind: item.kind,
          severity: item.severity,
          score: item.score,
          reason: item.reason,
        })),
      });
      if (!options.json) {
        console.warn(`⚠ ${contradictions.length} potential contradiction(s) detected:`);
        for (const c of contradictions.slice(0, 5)) {
          console.warn(`  - [${c.item_id}] vs [${c.conflicts_with}] (${c.severity}, score ${c.score}): ${c.reason}`);
        }
      }
    } else {
      checks.push({ name: 'contradictions', status: 'ok', message: 'No contradictions detected in state' });
    }
  } catch (err) {
    logger.debug('Skipping contradictions check (module unavailable):', err);
  }

  // --- Expired items check ---
  const nowIso = new Date().toISOString();
  const expiredNotes = listRuntimeNotes(undefined, options.cwd).filter(n => n.expires_at && n.expires_at < nowIso);
  const expiredConstraints = state.active_constraints.filter(c => c.expires_at && c.expires_at < nowIso && c.status === 'active');
  const expiredTraps = state.known_traps.filter((t) => isTrapExpired(t, nowIso));
  const totalExpired = expiredNotes.length + expiredConstraints.length + expiredTraps.length;
  if (totalExpired > 0) {
    checks.push({ name: 'expired_items', status: 'warn', message: `${totalExpired} expired item(s): ${expiredConstraints.length} constraints, ${expiredNotes.length} notes, ${expiredTraps.length} traps. Run \`brainclaw prune --expired\` to clean up.` });
    if (!options.json) {
      console.warn(`⚠ ${totalExpired} expired item(s). Run \`brainclaw prune --expired\` to clean up.`);
    }
    hasIssues = true;
  } else {
    checks.push({ name: 'expired_items', status: 'ok', message: 'No expired items found' });
  }

  // --- Stale memory check: age-based heuristics for plans, handoffs, candidates, runtime_notes ---
  try {
    const pendingCandidatesForStaleness = listCandidates('pending', options.cwd);
    const runtimeNotesForStaleness = listRuntimeNotes(undefined, options.cwd);
    const staleReport = detectStaleness(
      state.plan_items,
      state.known_traps,
      state.open_handoffs,
      pendingCandidatesForStaleness,
      Date.now(),
      runtimeNotesForStaleness,
    );
    if (staleReport.warnings.length > 0) {
      const summary = staleSummary(staleReport);
      checks.push({
        name: 'stale_memory',
        status: 'warn',
        message: `${staleReport.warnings.length} stale item(s) detected: ${summary}`,
        details: staleReport.warnings.map((w) => ({
          id: w.id,
          entity: w.entity,
          age_days: w.age_days,
          reason: w.reason,
          suggested_action: w.suggested_action,
        })),
      });
      if (!options.json) {
        console.warn(`⚠ Stale memory: ${summary}`);
        for (const w of staleReport.warnings.slice(0, 5)) {
          console.warn(`  [${w.entity}] ${w.text} — ${w.reason}`);
          console.warn(`  → ${w.suggested_action}`);
        }
        if (staleReport.warnings.length > 5) {
          console.warn(`  … and ${staleReport.warnings.length - 5} more. Run \`brainclaw doctor --json\` for the full list.`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({ name: 'stale_memory', status: 'ok', message: 'No stale items detected' });
      if (!options.json) {
        console.log('✔ No stale items detected');
      }
    }
  } catch { /* non-fatal — staleness check should not block doctor */ }

  // --- Inbox message layout checks ---
  const inboxAudit = auditInboxMessages(options.cwd);
  const inboxIssueCount = inboxAudit.invalid.length + inboxAudit.orphaned.length;
  if (inboxIssueCount > 0) {
    const status = inboxAudit.invalid.length > 0 ? 'error' : 'warn';
    checks.push({
      name: 'inbox_messages',
      status,
      message: `${inboxIssueCount} inbox message issue(s): ${inboxAudit.invalid.length} invalid, ${inboxAudit.orphaned.length} orphaned.`,
      details: {
        checked: inboxAudit.checked,
        invalid: inboxAudit.invalid.slice(0, 10),
        orphaned: inboxAudit.orphaned.slice(0, 10),
      },
    });
    // pln#397 stp_b5337e30: orphaned messages (wrong-dir placement) can be
    // moved safely. Invalid JSON requires manual inspection — surface as
    // unsafe so the repair flow prompts.
    for (const orphaned of inboxAudit.orphaned) {
      repairCandidates.push({
        action: 'move_inbox_message',
        target: orphaned.path,
        description: `Move orphaned inbox message to the correct agent subdirectory (${orphaned.reason})`,
        safe: true,
        related_check: 'inbox_messages',
      });
    }
    for (const invalid of inboxAudit.invalid) {
      repairCandidates.push({
        action: 'quarantine_inbox_message',
        target: invalid.path,
        description: `Move malformed inbox message to inbox/.quarantine for later inspection (${invalid.error})`,
        safe: false,
        related_check: 'inbox_messages',
      });
    }
    if (!options.json) {
      console.warn(`⚠ Inbox messages: ${inboxAudit.invalid.length} invalid, ${inboxAudit.orphaned.length} orphaned.`);
      for (const invalid of inboxAudit.invalid.slice(0, 10)) {
        console.warn(`  - invalid: ${invalid.path} (${invalid.error})`);
      }
      for (const orphaned of inboxAudit.orphaned.slice(0, 10)) {
        console.warn(`  - orphaned: ${orphaned.path} (${orphaned.reason})`);
      }
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'inbox_messages',
      status: 'ok',
      message: inboxAudit.checked > 0
        ? `Inbox messages look valid (${inboxAudit.checked} agent message file(s) checked)`
        : 'No inbox message files to check',
      details: { checked: inboxAudit.checked },
    });
    if (!options.json && inboxAudit.checked > 0) {
      console.log(`✔ Inbox messages: ${inboxAudit.checked} agent message file(s) checked`);
    }
  }

  // --- Claims checks ---
  const claims = listClaims(options.cwd);
  const activeClaims = claims.filter(c => c.status === 'active');
  if (!options.json) {
    console.log('');
    console.log(`Claims: ${activeClaims.length} active, ${claims.length - activeClaims.length} released`);
  }

  // Check for duplicate scope claims
  const scopeCounts = new Map<string, string[]>();
  for (const c of activeClaims) {
    const list = scopeCounts.get(c.scope) ?? [];
    list.push(c.id);
    scopeCounts.set(c.scope, list);
  }
  for (const [scope, ids] of scopeCounts) {
    if (ids.length > 1) {
      checks.push({ name: 'claim_collisions', status: 'warn', message: `Multiple active claims on scope "${scope}": ${ids.join(', ')}` });
      console.warn(`⚠ Multiple active claims on scope "${scope}": ${ids.join(', ')}`);
      hasIssues = true;
    }
  }
  if (!checks.some((c) => c.name === 'claim_collisions')) {
    checks.push({ name: 'claim_collisions', status: 'ok', message: 'No overlapping active claims detected' });
  }

  // Warn if active claims have no linked plan
  const unlinkedClaims = activeClaims.filter((c) => !c.plan_id);
  if (unlinkedClaims.length > 0) {
    const ids = unlinkedClaims.map((c) => c.id).join(', ');
    checks.push({
      name: 'claim_plan_link',
      status: 'warn',
      message: `${unlinkedClaims.length} active claim(s) have no linked plan item: ${ids}. Pass planId when calling bclaw_claim to trace work to the backlog.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${unlinkedClaims.length} active claim(s) have no linked plan item: ${ids}`);
      console.warn('  Pass planId when calling bclaw_claim to trace work to the backlog.');
    }
    hasIssues = true;
  } else if (activeClaims.length > 0) {
    checks.push({ name: 'claim_plan_link', status: 'ok', message: `All ${activeClaims.length} active claim(s) are linked to a plan item` });
    if (!options.json) {
      console.log(`✔ Claim plan links: all ${activeClaims.length} claim(s) linked`);
    }
  } else {
    checks.push({ name: 'claim_plan_link', status: 'ok', message: 'No active claims to check' });
  }

  // Stale claims check — session-aware: a claim with a live session is never considered stale
  const staleThresholdHours = config?.claims?.auto_release_after_hours ?? 24;
  const livenessById = new Map(
    activeClaims.map(c => [c.id, assessClaimLiveness(c, { thresholdHours: staleThresholdHours, cwd: options.cwd })]),
  );
  const staleClaims = activeClaims.filter(c => {
    const s = livenessById.get(c.id)!.status;
    return s === 'stale' || s === 'never-adopted';
  });
  const orphanedClaims = activeClaims.filter(c => livenessById.get(c.id)!.status === 'orphaned');

  if (staleClaims.length > 0) {
    hasIssues = true;
    const details = staleClaims.map(c => `${c.agent} → ${c.scope}`).join(', ');
    checks.push({ name: 'claims_stale', status: 'warn', message: `${staleClaims.length} stale claim(s) (no live session, >${staleThresholdHours}h): ${details}` });
    if (!options.json) console.warn(`⚠ ${staleClaims.length} stale claim(s) (no live session, >${staleThresholdHours}h): ${details}`);
  } else {
    checks.push({ name: 'claims_stale', status: 'ok', message: `No stale claims (threshold: ${staleThresholdHours}h)` });
  }

  if (orphanedClaims.length > 0) {
    hasIssues = true;
    const details = orphanedClaims.map(c => `${c.agent} → ${c.scope}`).join(', ');
    checks.push({ name: 'claims_orphaned', status: 'warn', message: `${orphanedClaims.length} orphaned claim(s) (session crashed): ${details}. Run 'brainclaw prune' or 'brainclaw claim release' to clean up.` });
    if (!options.json) console.warn(`⚠ ${orphanedClaims.length} orphaned claim(s) — session was adopted but died (crash recovery): ${details}`);
  } else if (activeClaims.some(c => c.adopted_at)) {
    checks.push({ name: 'claims_orphaned', status: 'ok', message: 'No orphaned claims' });
  }

  // Expired-but-still-active claims (TTL passed but prune not run)
  const expiredActive = activeClaims.filter((c) => isClaimExpired(c));
  if (expiredActive.length > 0) {
    hasIssues = true;
    const ids = expiredActive.map((c) => c.id).join(', ');
    checks.push({
      name: 'claim_ttl_expired',
      status: 'warn',
      message: `${expiredActive.length} active claim(s) past their TTL: ${ids}. Run 'brainclaw prune' to release them automatically.`,
    });
    if (!options.json) {
      console.warn(`⚠ ${expiredActive.length} active claim(s) have expired (TTL passed — run 'brainclaw prune')`);
      for (const c of expiredActive) {
        console.warn(`  - [${c.id}] ${c.scope}: expires_at ${c.expires_at}`);
      }
    }
  } else if (activeClaims.some((c) => c.expires_at)) {
    checks.push({ name: 'claim_ttl_expired', status: 'ok', message: 'All TTL-bounded claims are within their expiry window' });
    if (!options.json) console.log('✔ Claim TTLs: all within bounds');
  } else {
    checks.push({ name: 'claim_ttl_expired', status: 'ok', message: 'No TTL-bounded claims' });
  }

  // --- Runtime notes checks ---
  const notes = listRuntimeNotes(undefined, options.cwd);
  const localTraps = listOperationalTraps({}, options.cwd);
  if (!options.json) {
    console.log(`Runtime notes: ${notes.length} total`);
    console.log(`Local traps: ${localTraps.length} visible on this host`);
  }

  const marker = readContextMarker(options.cwd);
  const visibleMemoryVersion = getVisibleMemoryVersion({ cwd: options.cwd });
  if (marker?.memory_version && marker.memory_version !== visibleMemoryVersion) {
    checks.push({
      name: 'context_freshness',
      status: 'warn',
      message: `Last context read is stale for this host (marker ${marker.memory_version}, current ${visibleMemoryVersion}).`,
    });
    if (!options.json) {
      console.warn('⚠ Last context read is stale for this host. Run `brainclaw context` again before acting on old memory.');
    }
    hasIssues = true;
  } else {
    checks.push({
      name: 'context_freshness',
      status: 'ok',
      message: marker?.memory_version ? 'Last context marker matches current visible memory version' : 'No context marker found',
    });
    if (!options.json && marker?.memory_version) {
      console.log('✔ Context freshness marker matches current visible memory');
    }
  }

  // --- Runtime events integrity checks ---
  const events = listRuntimeEvents(options.cwd);
  if (events.length > 0) {
    const sessions = new Map<string, Set<string>>();
    for (const event of events.filter(isTaskLifecycleRuntimeEvent)) {
      const sessionValue = resolveEventSessionId(event);
      if (!sessionValue) continue;
      const set = sessions.get(sessionValue) ?? new Set<string>();
      set.add(event.event_type);
      sessions.set(sessionValue, set);
    }

    if (sessions.size > 0) {
      let incompleteSessions = 0;
      for (const [sessionId, eventTypes] of sessions.entries()) {
        if (!eventTypes.has('task_finished')) {
          incompleteSessions++;
          checks.push({ name: 'runtime_sessions', status: 'warn', message: `Runtime session '${sessionId}' has no task_finished event.` });
          console.warn(`⚠ Runtime session '${sessionId}' has no task_finished event.`);
          hasIssues = true;
        }
      }
      if (!options.json) {
        console.log(`Runtime events: ${events.length} total across ${sessions.size} session(s)`);
      }
      if (incompleteSessions === 0) {
        checks.push({ name: 'runtime_sessions', status: 'ok', message: 'Runtime sessions look consistent' });
        if (!options.json) {
          console.log('✔ Runtime sessions look consistent');
        }
      }
    } else {
      checks.push({ name: 'runtime_sessions', status: 'ok', message: `Runtime events: ${events.length} total (no session metadata)` });
      if (!options.json) {
        console.log(`Runtime events: ${events.length} total (no session metadata)`);
      }
    }
  } else {
    checks.push({ name: 'runtime_sessions', status: 'ok', message: 'No runtime events found' });
  }

  const metrics = {
    active_instructions: activeInstructions.length,
    active_plan_items: activePlans.length,
    blocked_plan_items: blockedPlans.length,
    promotion_ready_candidates: promotionReady.length,
    stale_auto_candidates: staleAutoCandidates.matched,
    stale_auto_candidates_deleted: staleAutoCandidates.deleted,
    pending_candidates: pending.length,
    accepted_candidates: accepted.length,
    rejected_candidates: rejected.length,
    pending_overdue: pendingOverdue.length,
    avg_review_hours: Number(avgReviewHours.toFixed(1)),
    review_sla_hours: reviewSlaHours,
    active_claims: activeClaims.length,
    released_claims: claims.length - activeClaims.length,
    runtime_notes: notes.length,
    visible_local_traps: localTraps.length,
    memory_version: visibleMemoryVersion,
    stale_context: Boolean(marker?.memory_version && marker.memory_version !== visibleMemoryVersion),
    runtime_events: events.length,
    agent_rules: agentTooling.agents_rules.length,
    local_skills: agentTooling.skills.length,
    incomplete_skills: incompleteSkills.length,
    local_mcp_servers: agentTooling.mcp_servers.length,
    missing_mcp_commands: missingMcpCommands.length,
    agent_git_hygiene_present: agentGitHygiene.presentPaths.length,
    agent_git_hygiene_missing_ignore: agentGitHygiene.missingGitignorePaths.length,
    agent_git_hygiene_tracked: agentGitHygiene.trackedPaths.length,
    declared_agent_integrations: integrationReadiness.length,
    integration_activation_gaps: missingIntegrations.length,
    brainclaw_cli_version: brainclawVersion.cli_version,
    required_brainclaw_version: brainclawVersion.minimum_brainclaw_version,
    recommended_brainclaw_version: brainclawVersion.recommended_brainclaw_version,
  };

  const reputationSummary = buildReputationSummary(options.cwd);
  if (reputationSummary.enabled) {
    checks.push({
      name: 'reputation_summary',
      status: 'ok',
      message: `tracked_agents=${reputationSummary.tracked_agents}, avg_internal_trust=${reputationSummary.avg_internal_trust}`,
    });
    if (!options.json) {
      console.log(`Reputation: ${reputationSummary.tracked_agents} tracked agent(s), avg trust ${reputationSummary.avg_internal_trust}`);
    }
  }

  // Circuit-breaker health check
  const circuitSnapshot = buildCircuitBreakerSnapshot(options.cwd);
  if (circuitSnapshot.tripped_agents.length > 0) {
    const names = circuitSnapshot.tripped_agents.map(a => `${a.agent_key}(${a.rejection_count}/${a.threshold})`).join(', ');
    checks.push({
      name: 'circuit_breaker',
      status: 'warn',
      message: `${circuitSnapshot.tripped_agents.length} agent(s) in circuit-breaker: ${names}`,
      details: circuitSnapshot.tripped_agents,
    });
    hasIssues = true;
    if (!options.json) {
      console.warn(`⚠ Circuit-breaker: ${circuitSnapshot.tripped_agents.length} agent(s) suspended from auto-promote: ${names}`);
      console.warn(`  Use 'brainclaw set-trust <agent> --reset-breaker' to restore.`);
    }
  } else {
    checks.push({ name: 'circuit_breaker', status: 'ok', message: 'No agents in circuit-breaker' });
    if (!options.json) {
      console.log('✔ Circuit-breaker: no agents suspended');
    }
  }

  // --- Store hierarchy check ---
  try {
    const storeChain = resolveStoreChain(options.cwd ?? process.cwd());
    if (storeChain.length > 1) {
      const chainDesc = storeChain
        .map((s) => `${s.role}(d=${s.depth})`)
        .join(' → ');
      // Warn if multiple stores declare the same non-unknown role
      const roleCounts = new Map<string, number>();
      for (const s of storeChain) {
        if (s.role !== 'unknown') {
          roleCounts.set(s.role, (roleCounts.get(s.role) ?? 0) + 1);
        }
      }
      const duplicateRoles = [...roleCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([role]) => role);
      if (duplicateRoles.length > 0) {
        checks.push({
          name: 'store_hierarchy',
          status: 'warn',
          message: `Store hierarchy has duplicate roles: ${duplicateRoles.join(', ')}. Chain: ${chainDesc}`,
          details: storeChain,
        });
        if (!options.json) {
          console.warn(`⚠ Store hierarchy has duplicate roles (${duplicateRoles.join(', ')}): ${chainDesc}`);
        }
        hasIssues = true;
      } else {
        checks.push({
          name: 'store_hierarchy',
          status: 'ok',
          message: `Store chain (${storeChain.length} stores): ${chainDesc}`,
          details: storeChain,
        });
        if (!options.json) {
          console.log(`✔ Store chain (${storeChain.length}): ${chainDesc}`);
        }
      }
    } else {
      checks.push({
        name: 'store_hierarchy',
        status: 'ok',
        message: 'Single store — no parent stores found in hierarchy',
      });
    }
  } catch {
    // non-fatal
  }

  // Cross-project links validation
  try {
    const links = resolveCrossProjectLinks(options.cwd);
    if (links.length > 0) {
      const unavailable = links.filter((l) => !l.available);
      if (unavailable.length > 0) {
        hasIssues = true;
        const paths = unavailable.map((l) => l.path).join(', ');
        checks.push({ name: 'cross_project_links', status: 'error', message: `cross_project_links: ${unavailable.length} unreachable path(s): ${paths}` });
        if (!options.json) console.error(`✗ cross_project_links: ${unavailable.length} unreachable path(s): ${paths}`);
      } else {
        checks.push({ name: 'cross_project_links', status: 'ok', message: `cross_project_links: ${links.length} link(s) OK` });
        if (!options.json) console.log(`✔ cross_project_links: ${links.length} link(s) OK`);
      }
      const cycles = detectCrossProjectCycles(options.cwd);
      if (cycles.length > 0) {
        hasIssues = true;
        checks.push({ name: 'cross_project_cycles', status: 'error', message: `cross_project_links cycle detected: ${cycles[0].join(' → ')}` });
        if (!options.json) console.error(`✗ cross_project_links cycle: ${cycles[0].join(' → ')}`);
      }
    }
  } catch {
    // non-fatal
  }

  // --- Backlog patterns in open handoffs ---
  try {
    const openHandoffs = state.open_handoffs.filter((h) => h.status === 'open');
    const backlogWithoutPlans = openHandoffs.flatMap((handoff) => extractBacklogWithoutPlanFindings(handoff));
    if (backlogWithoutPlans.length > 0) {
      const ids = [...new Set(backlogWithoutPlans.map((finding) => finding.handoff_id))].join(', ');
      checks.push({
        name: 'backlog_without_plans',
        status: 'warn',
        message: `${backlogWithoutPlans.length} actionable backlog item(s) in open handoff(s) lack a formal plan: ${ids}. Create a pln_xxx plan and link it.`,
        details: backlogWithoutPlans,
      });
      if (!options.json) {
        console.warn(`⚠ ${backlogWithoutPlans.length} actionable backlog item(s) in open handoff(s) lack a formal plan: ${ids}`);
        for (const finding of backlogWithoutPlans.slice(0, 10)) {
          console.warn(`  - [${finding.handoff_id}] ${finding.snippet}`);
          console.warn(`    ${finding.suggestion}`);
        }
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'backlog_without_plans',
        status: 'ok',
        message: openHandoffs.length > 0
          ? `${openHandoffs.length} open handoff(s) checked — no actionable backlog without plans detected`
          : 'No open handoffs to check',
      });
    }

    const handoffsWithBacklog = openHandoffs.filter((h) => !h.plan_id && hasBacklogPatterns(h.text));
    if (handoffsWithBacklog.length > 0) {
      const ids = handoffsWithBacklog.map((h) => h.id).join(', ');
      checks.push({
        name: 'handoff_backlog',
        status: 'warn',
        message: `${handoffsWithBacklog.length} open handoff(s) contain backlog patterns without a linked plan: ${ids}. Run \`brainclaw plan create "<text>"\` to formalize.`,
        details: handoffsWithBacklog.map((h) => ({ id: h.id, from: h.from, to: h.to })),
      });
      if (!options.json) {
        console.warn(`⚠ ${handoffsWithBacklog.length} open handoff(s) contain unformalized backlog (no plan linked): ${ids}`);
        console.warn('  Run `brainclaw plan create "<description>"` to create formal plan items.');
      }
      hasIssues = true;
    } else {
      checks.push({
        name: 'handoff_backlog',
        status: 'ok',
        message: openHandoffs.length > 0
          ? `${openHandoffs.length} open handoff(s) checked — no unformalized backlog detected`
          : 'No open handoffs to check',
      });
      if (!options.json && openHandoffs.length > 0) {
        console.log(`✔ Handoff backlog: ${openHandoffs.length} open handoff(s) checked, all covered`);
      }
    }

    // Check scope hygiene - warn if machine-level items are at project level
    try {
      const MACHINE_TAGS = ['windows', 'wsl', 'powershell', 'ssh', 'linux', 'macos', 'env', 'path', 'node-path'];
      const chain = resolveStoreChain(options.cwd);
      const userStoreExists = chain.some((s) => s.role === 'user');

      if (userStoreExists) {
        const projectState = loadState(options.cwd);
        const projectLevelItems: Array<{ id: string; type: string; text: string; tags: string[] }> = [];

        // Collect project-level items with machine-generic tags
        for (const constraint of projectState.active_constraints) {
          const hasMachineTag = constraint.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: constraint.id, type: 'constraint', text: constraint.text, tags: constraint.tags });
        }
        for (const decision of projectState.recent_decisions) {
          const hasMachineTag = decision.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: decision.id, type: 'decision', text: decision.text, tags: decision.tags });
        }
        for (const trap of projectState.known_traps) {
          const hasMachineTag = trap.tags.some((t) => MACHINE_TAGS.includes(t.toLowerCase()));
          if (hasMachineTag) projectLevelItems.push({ id: trap.id, type: 'trap', text: trap.text, tags: trap.tags });
        }

        if (projectLevelItems.length > 0) {
          const itemDescr = projectLevelItems.map((i) => `${i.type}[${i.id.slice(0, 8)}]`).join(', ');
          checks.push({
            name: 'scope_hygiene',
            status: 'warn',
            message: `${projectLevelItems.length} project-level item(s) have machine-generic tags: ${itemDescr}. Consider moving to user store.`,
            details: projectLevelItems,
          });
          if (!options.json) {
            console.warn(`⚠ Scope hygiene: ${projectLevelItems.length} project-level item(s) with machine tags (windows, wsl, ssh, etc.) should be in user store`);
            projectLevelItems.forEach((item) => {
              console.warn(`  - [${item.id.slice(0, 8)}] ${item.type}: tags=[${item.tags.join(', ')}]`);
            });
          }
        } else {
          checks.push({ name: 'scope_hygiene', status: 'ok', message: 'No machine-level items detected at project scope' });
          if (!options.json) {
            console.log('✔ Scope hygiene: no machine-level items at project scope');
          }
        }
      } else {
        checks.push({ name: 'scope_hygiene', status: 'ok', message: 'User store not configured (scope hygiene skipped)' });
      }
    } catch { /* non-fatal */ }

    // Check for cross-level duplicates
    try {
      const chain = resolveStoreChain(options.cwd);
      const allConstraints: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();
      const allDecisions: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();
      const allTraps: Map<string, Array<{ id: string; store: string; text: string }>> = new Map();

      // Collect items from all stores
      for (const store of chain) {
        try {
          const storeState = loadState(store.cwd);
          const storeName = store.role;

          for (const constraint of storeState.active_constraints) {
            const key = constraint.text.slice(0, 60).toLowerCase();
            if (!allConstraints.has(key)) allConstraints.set(key, []);
            allConstraints.get(key)!.push({ id: constraint.id, store: storeName, text: constraint.text });
          }
          for (const decision of storeState.recent_decisions) {
            const key = decision.text.slice(0, 60).toLowerCase();
            if (!allDecisions.has(key)) allDecisions.set(key, []);
            allDecisions.get(key)!.push({ id: decision.id, store: storeName, text: decision.text });
          }
          for (const trap of storeState.known_traps) {
            const key = trap.text.slice(0, 60).toLowerCase();
            if (!allTraps.has(key)) allTraps.set(key, []);
            allTraps.get(key)!.push({ id: trap.id, store: storeName, text: trap.text });
          }
        } catch { /* skip stores that can't be read */ }
      }

      // Find duplicates (same text at different levels)
      const duplicates: Array<{ type: string; text: string; items: Array<{ id: string; store: string }> }> = [];

      allConstraints.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'constraint',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });
      allDecisions.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'decision',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });
      allTraps.forEach((items, key) => {
        if (items.length > 1 && new Set(items.map((i) => i.store)).size > 1) {
          duplicates.push({
            type: 'trap',
            text: items[0].text,
            items: items.map((i) => ({ id: i.id, store: i.store })),
          });
        }
      });

      if (duplicates.length > 0) {
        checks.push({
          name: 'cross_level_duplicates',
          status: 'warn',
          message: `${duplicates.length} potential duplicate(s) detected across store levels. Review and deduplicate if needed.`,
          details: duplicates.slice(0, 10), // Limit to 10 for brevity
        });
        if (!options.json) {
          console.warn(`⚠ Cross-level duplicates: ${duplicates.length} potential duplicate(s) across store levels`);
          duplicates.slice(0, 10).forEach((dup) => {
            console.warn(`  - ${dup.type}: "${dup.text.slice(0, 40)}..." at [${dup.items.map((i) => i.store).join(', ')}]`);
          });
        }
      } else {
        checks.push({ name: 'cross_level_duplicates', status: 'ok', message: 'No cross-level duplicates detected' });
        if (!options.json) {
          console.log('✔ Cross-level duplicates: no duplicates across store levels');
        }
      }

      // Metadata consistency checks (capabilities/tools from dedicated registries)
      const capabilities = listRegistryCapabilities(options.cwd);
      const tools = listRegistryTools(options.cwd);
      const metadataIssues: string[] = [];

      // Check capabilities completeness
      capabilities.forEach((cap) => {
        if (!cap.category) {
          metadataIssues.push(`Capability [${cap.id}] missing category`);
        }
        if (!cap.name || cap.name.trim().length === 0) {
          metadataIssues.push(`Capability [${cap.id}] has empty name`);
        }
      });

      // Check tools completeness
      tools.forEach((tool) => {
        if (!tool.type) {
          metadataIssues.push(`Tool [${tool.id}] missing type`);
        }
        if (!tool.name || tool.name.trim().length === 0) {
          metadataIssues.push(`Tool [${tool.id}] has empty name`);
        }
      });

      if (metadataIssues.length > 0) {
        checks.push({
          name: 'metadata_consistency',
          status: 'warn',
          message: `${metadataIssues.length} metadata inconsistency(ies) found. Capabilities/tools may be incomplete.`,
          details: metadataIssues.slice(0, 10),
        });
        if (!options.json) {
          console.warn(`⚠ Metadata consistency: ${metadataIssues.length} issue(s) found`);
          metadataIssues.slice(0, 10).forEach((issue) => {
            console.warn(`  - ${issue}`);
          });
        }
      } else {
        checks.push({
          name: 'metadata_consistency',
          status: 'ok',
          message: `Metadata consistency OK (${capabilities.length} capabilities, ${tools.length} tools)`,
        });
        if (!options.json) {
          console.log(`✔ Metadata consistency: ${capabilities.length} capabilities, ${tools.length} tools registered`);
        }
      }
    } catch { /* non-fatal */ }

    // Check for machine-scoped items in project store (should be in user store)
    try {
      const machineInProject = [
        ...state.active_constraints.filter((c) => c.scope === 'machine'),
        ...state.recent_decisions.filter((d) => d.scope === 'machine'),
        ...state.known_traps.filter((t) => t.scope === 'machine'),
      ];
      if (machineInProject.length > 0) {
        const ids = machineInProject.map((i) => i.id).slice(0, 5);
        checks.push({
          name: 'machine_scope_placement',
          status: 'warn',
          message: `${machineInProject.length} machine-scoped item(s) in project store — consider promoting to user store with 'brainclaw migrate --promote-machine-items'`,
          details: ids,
        });
        if (!options.json) {
          console.warn(`⚠ ${machineInProject.length} machine-scoped item(s) in project store: ${ids.join(', ')}`);
        }
      } else {
        checks.push({ name: 'machine_scope_placement', status: 'ok', message: 'No machine-scoped items misplaced in project store' });
        if (!options.json) {
          console.log('✔ Machine-scope placement: no misplaced items');
        }
      }
    } catch { /* non-fatal */ }

    // Workflow hygiene check (Phase 9)
    try {
      const activeClaims = listClaims(options.cwd).filter((c) => c.status === 'active');
      const inProgressPlans = state.plan_items.filter((p) => p.status === 'in_progress');
      const workflowIssues: string[] = [];

      if (activeClaims.length > 3) {
        workflowIssues.push(`${activeClaims.length} active claims — consider releasing finished ones`);
      }
      const unclaimedInProgress = inProgressPlans.filter(
        (p) => !activeClaims.some((c) => c.plan_id === p.id)
      );
      if (unclaimedInProgress.length > 0) {
        workflowIssues.push(`${unclaimedInProgress.length} in-progress plan(s) without a claim`);
      }

      if (workflowIssues.length > 0) {
        checks.push({
          name: 'workflow_hygiene',
          status: 'warn',
          message: `Workflow hygiene: ${workflowIssues.join('; ')}`,
          details: workflowIssues,
        });
        if (!options.json) {
          console.warn(`⚠ Workflow hygiene: ${workflowIssues.join('; ')}`);
        }
      } else {
        checks.push({ name: 'workflow_hygiene', status: 'ok', message: 'Workflow hygiene OK' });
        if (!options.json) console.log('✔ Workflow hygiene: OK');
      }
    } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }

  // Worktree stale-session and shared-checkout checks
  try {
    const activeClaims = listClaims(options.cwd);
    const worktrees = listWorktrees(options.cwd ?? process.cwd());
    const claimWorktrees = new Set(activeClaims.filter((c) => c.worktree_path && c.status === 'active').map((c) => c.worktree_path!));
    const orphanWorktrees = worktrees.filter(
      (wt) => !wt.is_main && wt.session_id && !claimWorktrees.has(wt.path),
    );
    if (orphanWorktrees.length > 0) {
      hasIssues = true;
      checks.push({
        name: 'worktree_orphans',
        status: 'warn',
        message: `${orphanWorktrees.length} worktree(s) have no active claim: ${orphanWorktrees.map((w) => w.path).join(', ')}. Run 'brainclaw worktree prune' or remove them.`,
      });
      if (!options.json) {
        console.warn(`⚠ ${orphanWorktrees.length} orphan worktree(s) with no active claim`);
        for (const wt of orphanWorktrees) {
          console.warn(`  - ${wt.path} (branch: ${wt.branch}, session: ${wt.session_id ?? 'unknown'})`);
        }
      }
    } else {
      checks.push({ name: 'worktree_orphans', status: 'ok', message: 'No orphan worktrees detected' });
      if (!options.json) console.log('✔ Worktrees: no orphans');
    }

    // Shared-checkout risk: multiple brainclaw sessions in the same working tree
    const risk = detectSharedCheckoutRisk(options.cwd ?? process.cwd());
    if (risk.has_conflict) {
      hasIssues = true;
      checks.push({
        name: 'worktree_shared_checkout',
        status: 'warn',
        message: `Shared-checkout risk: ${risk.conflicting_paths.length} worktree(s) have multiple active sessions. Each session should use a dedicated worktree.`,
      });
      if (!options.json) {
        console.warn('⚠ Shared-checkout risk detected — multiple sessions share a worktree');
        for (const p of risk.conflicting_paths) {
          console.warn(`  - ${p}`);
        }
      }
    } else {
      checks.push({ name: 'worktree_shared_checkout', status: 'ok', message: 'No shared-checkout conflicts' });
      if (!options.json) console.log('✔ Worktrees: no shared-checkout conflicts');
    }
  } catch { /* non-fatal — git may not be available or no worktrees */ }

  // --- Documentation drift check ---
  try {
    const { execSync } = childProcess;
    const effectiveCwd = options.cwd ?? process.cwd();
    const srcCommitDate = execSync('git log -1 --format=%aI -- src/commands src/core', { encoding: 'utf-8', cwd: effectiveCwd }).trim();
    const docsCommitDate = execSync('git log -1 --format=%aI -- docs/', { encoding: 'utf-8', cwd: effectiveCwd }).trim();

    if (srcCommitDate && docsCommitDate && srcCommitDate > docsCommitDate) {
      checks.push({ name: 'doc_drift', status: 'warn', message: `Documentation may be outdated: src/ last changed ${srcCommitDate.slice(0, 10)}, docs/ last changed ${docsCommitDate.slice(0, 10)}` });
      if (!options.json) {
        console.warn(`⚠ Documentation drift: src/ updated ${srcCommitDate.slice(0, 10)} but docs/ last updated ${docsCommitDate.slice(0, 10)}`);
      }
    } else if (srcCommitDate && !docsCommitDate) {
      checks.push({ name: 'doc_drift', status: 'warn', message: 'No docs/ directory found in git history' });
      if (!options.json) {
        console.warn('⚠ No docs/ directory found in git history');
      }
    } else {
      checks.push({ name: 'doc_drift', status: 'ok', message: 'Documentation is up to date with source' });
      if (!options.json) console.log('✔ Documentation is up to date with source');
    }
  } catch { /* non-fatal — git may not be available */ }

  // --- Security preinstall gate check ---
  if (config.security?.preinstall?.enabled) {
    checks.push({ name: 'security_preinstall', status: 'ok', message: `Security preinstall gate is enabled (mode: ${config.security.preinstall.mode})` });
    if (!options.json) console.log(`✔ Security preinstall gate is enabled (mode: ${config.security.preinstall.mode})`);

    // Check if guard scripts exist
    try {
      const guardDir = path.join(memoryPath('security/bin', options.cwd), '.');
      const guardExists = fs.existsSync(path.dirname(guardDir));
      if (guardExists) {
        checks.push({ name: 'security_guard_scripts', status: 'ok', message: 'Guard wrapper scripts are generated' });
        if (!options.json) console.log('✔ Guard wrapper scripts are generated');
      } else {
        checks.push({ name: 'security_guard_scripts', status: 'warn', message: 'Guard wrapper scripts not found — run brainclaw setup-security' });
        if (!options.json) console.warn('⚠ Guard wrapper scripts not found — run brainclaw setup-security');
      }
    } catch { /* non-fatal */ }
  } else {
    checks.push({ name: 'security_preinstall', status: 'ok', message: 'Security preinstall gate is not enabled (optional)' });
    if (!options.json) console.log('ℹ Security preinstall gate is not enabled (optional — run brainclaw setup-security to activate)');
  }

  // VS Code extension check
  try {
    const codeResult = childProcess.spawnSync('code', ['--list-extensions'], { stdio: 'pipe', timeout: 5000 });
    if (codeResult.status === 0) {
      const extensions = codeResult.stdout.toString().split('\n').map(e => e.trim().toLowerCase());
      if (extensions.includes('brainclaw.brainclaw-vscode')) {
        checks.push({ name: 'vscode_extension', status: 'ok', message: 'Brainclaw VS Code extension is installed' });
        if (!options.json) console.log('✔ Brainclaw VS Code extension is installed');
      } else {
        checks.push({ name: 'vscode_extension', status: 'warn', message: 'VS Code detected but Brainclaw extension is not installed. Run `brainclaw setup` to install it.' });
        if (!options.json) console.log('⚠ VS Code detected but Brainclaw extension is not installed. Run `brainclaw setup` to install it.');
      }
    }
    // If `code` is not available, skip silently — VS Code not installed
  } catch {
    // Non-fatal
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: !hasIssues,
      checks,
      repair_candidates: repairCandidates,
      metrics: {
        ...metrics,
        migration_outdated_documents: migrationEntries.filter((entry) => entry.status === 'outdated').length,
        migration_invalid_documents: migrationEntries.filter((entry) => entry.status === 'invalid').length,
        reputation_enabled: reputationSummary.enabled,
        reputation_tracked_agents: reputationSummary.tracked_agents,
        reputation_avg_internal_trust: reputationSummary.avg_internal_trust,
        reputation_current_agent_trust: reputationSummary.current_agent_trust ?? 0,
        circuit_breaker_tripped_count: circuitSnapshot.tripped_agents.length,
        circuit_breaker_threshold: circuitSnapshot.threshold,
        circuit_breaker_window_days: circuitSnapshot.window_days,
        agent_git_hygiene_fixed: agentGitHygieneFixed.length,
        repair_candidates_safe: repairCandidates.filter((c) => c.safe).length,
        repair_candidates_unsafe: repairCandidates.filter((c) => !c.safe).length,
      },
      migration: options.migrationCheck
        ? {
            entries: migrationEntries,
            outdated: migrationEntries.filter((entry) => entry.status === 'outdated').length,
            invalid: migrationEntries.filter((entry) => entry.status === 'invalid').length,
          }
        : undefined,
    }, null, 2));
    return;
  }

  if (!hasIssues) {
    console.log('');
    console.log('All checks passed.');
  }
}

function runAfterMigrationCheck(options: DoctorOptions): void {
  const cwd = options.cwd ?? process.cwd();
  const store = resolvePrimaryStore(cwd);
  if (!store) {
    console.error(`Error: no .brainclaw/ store resolved from ${cwd}`);
    process.exit(1);
  }

  const report = runPostMigrationHealthCheck({ storePath: store.storePath });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Post-migration health check on ${report.store_path}`);
    for (const finding of report.findings) {
      const glyph = finding.status === 'ok' ? '✔' : finding.status === 'warn' ? '⚠' : '✗';
      console.log(`  ${glyph} [${finding.check}] ${finding.message}`);
    }
    console.log('');
    console.log(report.ok ? '✔ All post-migration invariants hold.' : '✗ Post-migration invariants failed. Inspect the findings above.');
  }

  if (!report.ok) {
    process.exit(1);
  }
}
