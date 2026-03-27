import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AgentReleaseNotesSchema,
  BrainclawLocalReleaseManifestSchema,
  type AgentReleaseNotes,
  type BrainclawUpdateSource,
  type BrainclawUpdateSourceNpm,
  type Config,
} from './schema.js';

type VersionStatus = 'ok' | 'update_available' | 'upgrade_required' | 'invalid_config';
type InstallableUpdateStatus = 'not_configured' | 'unsupported_source' | 'check_failed' | 'up_to_date' | 'update_available' | 'invalid_config';

export const DEFAULT_LOCAL_RELEASES_DIR = '.releases';
export const DEFAULT_LOCAL_RELEASE_MANIFEST_PATH = `${DEFAULT_LOCAL_RELEASES_DIR}/brainclaw-local.json`;
export const DEFAULT_NPM_UPDATE_PACKAGE = 'brainclaw';
export const DEFAULT_NPM_UPDATE_DIST_TAG = 'latest';
export const DEFAULT_INSTALLABLE_UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface BrainclawVersionAssessment {
  cli_version: string;
  minimum_brainclaw_version: string | null;
  recommended_brainclaw_version: string | null;
  upgrade_message: string | null;
  upgrade_command: string | null;
  target_version: string | null;
  status: VersionStatus;
  message: string;
}

export interface BrainclawInstallableUpdateCheck {
  checked: boolean;
  source_type: BrainclawUpdateSource['type'] | null;
  source_description: string | null;
  latest_installable_version: string | null;
  artifact_path: string | null;
  install_command: string | null;
  release_notes: string | null;
  agent_release_notes?: AgentReleaseNotes | null;
  status: InstallableUpdateStatus;
  message: string;
  checked_at?: string | null;
  cached?: boolean;
  default_source?: boolean;
}

export interface BrainclawLocalReleasePublication {
  package_name: string;
  workspace_version: string;
  manifest_path: string;
  artifact_path: string;
  install_command: string;
  release_notes: string | null;
  agent_release_notes: AgentReleaseNotes | null;
}

export interface PublishLocalBrainclawReleaseOptions {
  releaseNotes?: string;
  agentReleaseNotes?: AgentReleaseNotes;
  manifestPath?: string;
  outputDir?: string;
}

export interface CheckBrainclawInstallableUpdateOptions {
  useDefaultNpmSource?: boolean;
  now?: Date;
  cacheTtlMs?: number;
  npmLookup?: NpmDistTagLookup;
}

interface NpmDistTagLookupResult {
  dist_tags: Record<string, string>;
  checked_at: string;
  cached: boolean;
}

interface NpmDistTagLookupOptions {
  cwd: string;
  now?: Date;
  cacheTtlMs?: number;
}

interface CachedNpmDistTagsDocument {
  version: 1;
  package_name: string;
  fetched_at: string;
  dist_tags: Record<string, string>;
}

type NpmDistTagLookup = (packageName: string, options: NpmDistTagLookupOptions) => NpmDistTagLookupResult;

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DEFAULT_NPM_UPDATE_SOURCE: BrainclawUpdateSourceNpm = {
  type: 'npm',
  package_name: DEFAULT_NPM_UPDATE_PACKAGE,
  dist_tag: DEFAULT_NPM_UPDATE_DIST_TAG,
};

export interface BrainclawInstallation {
  path: string;
  version: string;
  isCurrent: boolean;
}

/**
 * Scan PATH for all brainclaw installations and their versions.
 * Detects when multiple versions are installed (e.g. global + user-local)
 * which causes confusion about which version is actually running.
 */
export function detectConcurrentInstallations(): BrainclawInstallation[] {
  const currentVersion = getInstalledBrainclawVersion();
  const installations: BrainclawInstallation[] = [];
  const seen = new Set<string>();

  // On Windows, `where` returns all matches. On Unix, `which -a` does.
  const isWindows = os.platform() === 'win32';
  const result = isWindows
    ? spawnSync('where', ['brainclaw'], { encoding: 'utf-8', timeout: 5000 })
    : spawnSync('which', ['-a', 'brainclaw'], { encoding: 'utf-8', timeout: 5000 });

  if (result.status !== 0) return [];

  const paths = result.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const binPath of paths) {
    // Normalize to avoid duplicates from symlinks
    let realPath: string;
    try {
      realPath = isWindows ? binPath : fs.realpathSync(binPath);
    } catch {
      realPath = binPath;
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);

    // Get version by running the binary
    let version = 'unknown';
    try {
      const vResult = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
      if (vResult.status === 0) {
        version = vResult.stdout.trim().split(/\r?\n/)[0]?.trim() ?? 'unknown';
      }
    } catch { /* ignore */ }

    installations.push({
      path: binPath,
      version,
      isCurrent: version === currentVersion,
    });
  }

  return installations;
}

let cachedCliVersion: string | undefined;
let cachedPackageJsonPath: string | undefined;

/**
 * Read the brainclaw version from disk (package.json), bypassing the in-memory cache.
 * Used by the MCP server to detect when a new version has been installed while the
 * long-running MCP process is still running with old code.
 */
export function readDiskBrainclawVersion(): string {
  if (cachedPackageJsonPath === undefined) {
    cachedPackageJsonPath = findOwnPackageJson() ?? '';
  }
  if (!cachedPackageJsonPath) return '0.0.0';
  try {
    const parsed = JSON.parse(fs.readFileSync(cachedPackageJsonPath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getInstalledBrainclawVersion(): string {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  const packageJsonPath = findOwnPackageJson();
  if (!packageJsonPath) {
    cachedCliVersion = '0.0.0';
    return cachedCliVersion;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
    cachedCliVersion = typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : '0.0.0';
  } catch {
    cachedCliVersion = '0.0.0';
  }

  return cachedCliVersion;
}

export function assessBrainclawVersion(
  config?: Pick<Config, 'minimum_brainclaw_version' | 'recommended_brainclaw_version' | 'brainclaw_upgrade_message' | 'brainclaw_upgrade_command'>,
): BrainclawVersionAssessment {
  const cliVersion = getInstalledBrainclawVersion();
  const minimumVersion = normalizeConfiguredVersion(config?.minimum_brainclaw_version);
  const recommendedVersion = normalizeConfiguredVersion(config?.recommended_brainclaw_version);
  const upgradeMessage = config?.brainclaw_upgrade_message?.trim() || null;
  const upgradeCommand = config?.brainclaw_upgrade_command?.trim() || null;

  const invalidFields = [
    minimumVersion ? undefined : invalidField('minimum_brainclaw_version', config?.minimum_brainclaw_version),
    recommendedVersion ? undefined : invalidField('recommended_brainclaw_version', config?.recommended_brainclaw_version),
  ].filter((value): value is string => Boolean(value));

  if (invalidFields.length > 0) {
    return {
      cli_version: cliVersion,
      minimum_brainclaw_version: minimumVersion,
      recommended_brainclaw_version: recommendedVersion,
      upgrade_message: upgradeMessage,
      upgrade_command: upgradeCommand,
      target_version: recommendedVersion ?? minimumVersion,
      status: 'invalid_config',
      message: `Invalid Brainclaw version policy in config.yaml: ${invalidFields.join(', ')}`,
    };
  }

  if (minimumVersion && compareVersions(cliVersion, minimumVersion) < 0) {
    return {
      cli_version: cliVersion,
      minimum_brainclaw_version: minimumVersion,
      recommended_brainclaw_version: recommendedVersion,
      upgrade_message: upgradeMessage,
      upgrade_command: upgradeCommand,
      target_version: recommendedVersion ?? minimumVersion,
      status: 'upgrade_required',
      message: `Installed brainclaw ${cliVersion} is older than the required minimum ${minimumVersion}.`,
    };
  }

  if (recommendedVersion && compareVersions(cliVersion, recommendedVersion) < 0) {
    return {
      cli_version: cliVersion,
      minimum_brainclaw_version: minimumVersion,
      recommended_brainclaw_version: recommendedVersion,
      upgrade_message: upgradeMessage,
      upgrade_command: upgradeCommand,
      target_version: recommendedVersion,
      status: 'update_available',
      message: `Installed brainclaw ${cliVersion} is older than the project recommendation ${recommendedVersion}.`,
    };
  }

  const message = minimumVersion || recommendedVersion
    ? `Installed brainclaw ${cliVersion} satisfies the project version policy.`
    : `Installed brainclaw ${cliVersion}; no project-specific version policy is configured.`;

  return {
    cli_version: cliVersion,
    minimum_brainclaw_version: minimumVersion,
    recommended_brainclaw_version: recommendedVersion,
    upgrade_message: upgradeMessage,
    upgrade_command: upgradeCommand,
    target_version: recommendedVersion ?? minimumVersion,
    status: 'ok',
    message,
  };
}

export function checkBrainclawInstallableUpdate(
  config: Pick<Config, 'brainclaw_update_source' | 'brainclaw_upgrade_command' | 'brainclaw_upgrade_message'> | undefined,
  cwd: string,
  options: CheckBrainclawInstallableUpdateOptions = {},
): BrainclawInstallableUpdateCheck {
  const source = config?.brainclaw_update_source
    ?? (options.useDefaultNpmSource ? DEFAULT_NPM_UPDATE_SOURCE : undefined);
  const defaultSource = !config?.brainclaw_update_source && source?.type === 'npm';

  if (!source) {
    return {
      checked: false,
      source_type: null,
      source_description: null,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'not_configured',
      message: 'No installable update source is configured for this project.',
    };
  }

  if (source.type === 'npm') {
    return checkNpmInstallableUpdate(source, config, cwd, options, defaultSource);
  }

  return checkLocalPackInstallableUpdate(source.manifest_path, config, cwd);
}

export function renderBrainclawInstallableUpdateNotice(
  updateCheck: BrainclawInstallableUpdateCheck | undefined,
): string | null {
  if (!updateCheck || updateCheck.status !== 'update_available') {
    return null;
  }

  const lines = [updateCheck.message];
  if (updateCheck.install_command) {
    lines.push(`Install: ${updateCheck.install_command}`);
  }
  const arn = updateCheck.agent_release_notes;
  if (arn) {
    lines.push(`Summary: ${arn.summary}`);
    if (arn.breaking_risk && arn.breaking_risk !== 'none') {
      lines.push(`Breaking risk: ${arn.breaking_risk}`);
    }
    if (arn.highlights && arn.highlights.length > 0) {
      lines.push('Highlights:');
      for (const h of arn.highlights) {
        lines.push(`  • ${h}`);
      }
    }
    if (arn.action_recommendation) {
      lines.push(`Action: ${arn.action_recommendation}`);
    }
  } else if (updateCheck.release_notes) {
    lines.push(`Why update: ${updateCheck.release_notes}`);
  }
  return lines.join('\n');
}

export function publishLocalBrainclawRelease(
  cwd: string,
  options: PublishLocalBrainclawReleaseOptions = {},
): BrainclawLocalReleasePublication {
  const workspacePackage = readWorkspaceBrainclawPackage(cwd);
  const outputDir = path.resolve(cwd, options.outputDir ?? DEFAULT_LOCAL_RELEASES_DIR);
  const manifestPath = path.resolve(cwd, options.manifestPath ?? DEFAULT_LOCAL_RELEASE_MANIFEST_PATH);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

  const packResult = spawnSync(resolveNpmCommand(), resolveNpmPackArgs(outputDir), {
    cwd,
    encoding: 'utf-8',
    timeout: 120000,
  });

  if (packResult.error) {
    throw new Error(`Failed to run npm pack: ${packResult.error.message}`);
  }
  if (packResult.status !== 0) {
    throw new Error(firstNonEmptyLine(packResult.stderr) ?? firstNonEmptyLine(packResult.stdout) ?? 'npm pack failed');
  }

  const artifactFilename = parsePackedFilename(packResult.stdout);
  if (!artifactFilename) {
    throw new Error('npm pack did not report the generated tarball filename.');
  }

  const artifactAbsolutePath = path.join(outputDir, artifactFilename);
  if (!fs.existsSync(artifactAbsolutePath)) {
    throw new Error(`npm pack reported ${artifactFilename}, but the tarball was not found in ${outputDir}.`);
  }

  const manifestArtifactPath = toManifestRelativePath(path.relative(path.dirname(manifestPath), artifactAbsolutePath));
  const projectArtifactPath = toManifestRelativePath(path.relative(cwd, artifactAbsolutePath));
  const projectManifestPath = toPortablePath(path.relative(cwd, manifestPath));
  const installCommand = `npm install -g "${projectArtifactPath}"`;
  const releaseNotes = options.releaseNotes?.trim() || null;
  const agentReleaseNotes = options.agentReleaseNotes
    ? AgentReleaseNotesSchema.parse(options.agentReleaseNotes)
    : null;

  const manifest = BrainclawLocalReleaseManifestSchema.parse({
    version: 1,
    channel: 'local-pack',
    package_name: workspacePackage.name,
    latest_installable_version: workspacePackage.version,
    published_at: new Date().toISOString(),
    artifact_path: manifestArtifactPath,
    install_command: installCommand,
    release_notes: releaseNotes ?? undefined,
    agent_release_notes: agentReleaseNotes ?? undefined,
  });

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    package_name: workspacePackage.name,
    workspace_version: workspacePackage.version,
    manifest_path: projectManifestPath,
    artifact_path: projectArtifactPath,
    install_command: installCommand,
    release_notes: releaseNotes,
    agent_release_notes: agentReleaseNotes,
  };
}

function checkNpmInstallableUpdate(
  source: BrainclawUpdateSourceNpm,
  config: Pick<Config, 'brainclaw_upgrade_command' | 'brainclaw_upgrade_message'> | undefined,
  cwd: string,
  options: CheckBrainclawInstallableUpdateOptions,
  defaultSource: boolean,
): BrainclawInstallableUpdateCheck {
  const packageName = source.package_name?.trim() || DEFAULT_NPM_UPDATE_PACKAGE;
  const distTag = source.dist_tag?.trim() || DEFAULT_NPM_UPDATE_DIST_TAG;

  if (packageName.length === 0) {
    return {
      checked: false,
      source_type: 'npm',
      source_description: null,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'invalid_config',
      message: 'brainclaw_update_source.package_name must not be empty.',
      default_source: defaultSource,
    };
  }

  if (distTag.length === 0) {
    return {
      checked: false,
      source_type: 'npm',
      source_description: packageName,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'invalid_config',
      message: 'brainclaw_update_source.dist_tag must not be empty.',
      default_source: defaultSource,
    };
  }

  try {
    const lookup = (options.npmLookup ?? lookupNpmDistTags)(packageName, {
      cwd,
      now: options.now,
      cacheTtlMs: options.cacheTtlMs,
    });
    const latestVersion = normalizeConfiguredVersion(lookup.dist_tags[distTag]);
    if (!latestVersion) {
      return {
        checked: true,
        source_type: 'npm',
        source_description: formatNpmSourceDescription(packageName, distTag, defaultSource),
        latest_installable_version: null,
        artifact_path: null,
        install_command: null,
        release_notes: config?.brainclaw_upgrade_message?.trim() || null,
        status: 'check_failed',
        message: `The npm channel ${packageName}@${distTag} did not resolve to a valid semver release.`,
        checked_at: lookup.checked_at,
        cached: lookup.cached,
        default_source: defaultSource,
      };
    }

    const installCommand = config?.brainclaw_upgrade_command?.trim()
      || `npm install -g ${packageName}@${latestVersion}`;
    const releaseNotes = config?.brainclaw_upgrade_message?.trim() || null;
    const installedVersion = getInstalledBrainclawVersion();

    if (compareVersions(installedVersion, latestVersion) < 0) {
      return {
        checked: true,
        source_type: 'npm',
        source_description: formatNpmSourceDescription(packageName, distTag, defaultSource),
        latest_installable_version: latestVersion,
        artifact_path: null,
        install_command: installCommand,
        release_notes: releaseNotes,
        status: 'update_available',
        message: `A newer installable brainclaw build is available from npm: ${latestVersion} (installed ${installedVersion}).`,
        checked_at: lookup.checked_at,
        cached: lookup.cached,
        default_source: defaultSource,
      };
    }

    return {
      checked: true,
      source_type: 'npm',
      source_description: formatNpmSourceDescription(packageName, distTag, defaultSource),
      latest_installable_version: latestVersion,
      artifact_path: null,
      install_command: installCommand,
      release_notes: releaseNotes,
      status: 'up_to_date',
      message: `Installed brainclaw ${installedVersion} is up to date for npm channel ${packageName}@${distTag}.`,
      checked_at: lookup.checked_at,
      cached: lookup.cached,
      default_source: defaultSource,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checked: true,
      source_type: 'npm',
      source_description: formatNpmSourceDescription(packageName, distTag, defaultSource),
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: config?.brainclaw_upgrade_message?.trim() || null,
      status: 'check_failed',
      message: `Failed to check npm installable updates: ${message}`,
      default_source: defaultSource,
    };
  }
}

function checkLocalPackInstallableUpdate(
  manifestPath: string,
  config: Pick<Config, 'brainclaw_upgrade_command' | 'brainclaw_upgrade_message'> | undefined,
  cwd: string,
): BrainclawInstallableUpdateCheck {
  const trimmedManifestPath = manifestPath.trim();
  if (trimmedManifestPath.length === 0) {
    return {
      checked: false,
      source_type: 'local-pack',
      source_description: null,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'invalid_config',
      message: 'brainclaw_update_source.manifest_path must not be empty.',
      default_source: false,
    };
  }

  const resolvedManifestPath = path.isAbsolute(trimmedManifestPath)
    ? trimmedManifestPath
    : path.resolve(cwd, trimmedManifestPath);

  if (!fs.existsSync(resolvedManifestPath)) {
    return {
      checked: true,
      source_type: 'local-pack',
      source_description: resolvedManifestPath,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'check_failed',
      message: `The configured local-pack manifest was not found: ${resolvedManifestPath}`,
      default_source: false,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf-8')) as unknown;
    const manifest = BrainclawLocalReleaseManifestSchema.parse(parsed);
    const latestVersion = normalizeConfiguredVersion(manifest.latest_installable_version);
    if (!latestVersion) {
      return {
        checked: true,
        source_type: 'local-pack',
        source_description: resolvedManifestPath,
        latest_installable_version: null,
        artifact_path: null,
        install_command: null,
        release_notes: manifest.release_notes?.trim() || config?.brainclaw_upgrade_message?.trim() || null,
        status: 'check_failed',
        message: `The local-pack manifest has an invalid latest_installable_version: ${manifest.latest_installable_version}`,
        default_source: false,
      };
    }

    const artifactPath = manifest.artifact_path
      ? resolveManifestArtifactPath(manifest.artifact_path, resolvedManifestPath)
      : null;
    const installCommand = manifest.install_command?.trim()
      || (artifactPath ? `npm install -g "${artifactPath}"` : config?.brainclaw_upgrade_command?.trim() || null);
    const releaseNotes = manifest.release_notes?.trim() || config?.brainclaw_upgrade_message?.trim() || null;
    const agentReleaseNotes = manifest.agent_release_notes ?? null;
    const installedVersion = getInstalledBrainclawVersion();

    if (compareVersions(installedVersion, latestVersion) < 0) {
      return {
        checked: true,
        source_type: 'local-pack',
        source_description: resolvedManifestPath,
        latest_installable_version: latestVersion,
        artifact_path: artifactPath,
        install_command: installCommand,
        release_notes: releaseNotes,
        agent_release_notes: agentReleaseNotes,
        status: 'update_available',
        message: `A newer installable brainclaw build is available: ${latestVersion} (installed ${installedVersion}).`,
        default_source: false,
      };
    }

    return {
      checked: true,
      source_type: 'local-pack',
      source_description: resolvedManifestPath,
      latest_installable_version: latestVersion,
      artifact_path: artifactPath,
      install_command: installCommand,
      release_notes: releaseNotes,
      agent_release_notes: agentReleaseNotes,
      status: 'up_to_date',
      message: `Installed brainclaw ${installedVersion} is up to date for the configured local-pack channel.`,
      default_source: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checked: true,
      source_type: 'local-pack',
      source_description: resolvedManifestPath,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'check_failed',
      message: `Failed to read the configured local-pack manifest: ${message}`,
      default_source: false,
    };
  }
}

function resolveNpmCommand(): string {
  return process.platform === 'win32' ? (process.env.ComSpec?.trim() || 'cmd.exe') : 'npm';
}

function resolveNpmPackArgs(outputDir: string): string[] {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', 'npm', 'pack', '--json', '--pack-destination', outputDir];
  }

  return ['pack', '--json', '--pack-destination', outputDir];
}

function resolveNpmViewArgs(packageName: string): string[] {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', 'npm', 'view', packageName, 'dist-tags', '--json'];
  }

  return ['view', packageName, 'dist-tags', '--json'];
}

function findOwnPackageJson(): string | undefined {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(currentDir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { name?: unknown };
        if (parsed.name === 'brainclaw') {
          return candidate;
        }
      } catch {
        // Ignore malformed package.json while walking upward.
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return undefined;
    }
    currentDir = parent;
  }
}

function resolveManifestArtifactPath(artifactPath: string, manifestPath: string): string {
  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }

  return path.resolve(path.dirname(manifestPath), artifactPath);
}

function readWorkspaceBrainclawPackage(cwd: string): { name: string; version: string } {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('Local Brainclaw release publishing requires a package.json in the current workspace.');
  }

  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: unknown; version?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read package.json: ${message}`);
  }

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (name !== 'brainclaw') {
    throw new Error(`Local release publishing is only supported from the brainclaw workspace; found package name "${name || '<missing>'}".`);
  }
  if (!parseVersion(version)) {
    throw new Error(`package.json version must be a valid semver string; found "${version || '<missing>'}".`);
  }

  return { name, version };
}

function parsePackedFilename(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as Array<{ filename?: unknown }>;
    const filename = parsed[0]?.filename;
    return typeof filename === 'string' && filename.trim().length > 0 ? filename.trim() : undefined;
  } catch {
    return firstNonEmptyLine(stdout);
  }
}

function lookupNpmDistTags(packageName: string, options: NpmDistTagLookupOptions): NpmDistTagLookupResult {
  const now = options.now ?? new Date();
  const cachePath = resolveNpmUpdateCachePath(packageName);
  const ttlMs = options.cacheTtlMs ?? DEFAULT_INSTALLABLE_UPDATE_CACHE_TTL_MS;
  const cached = readCachedNpmDistTags(cachePath, packageName, now, ttlMs);
  if (cached) {
    return cached;
  }

  const viewResult = spawnSync(resolveNpmCommand(), resolveNpmViewArgs(packageName), {
    cwd: options.cwd,
    encoding: 'utf-8',
    timeout: 15000,
  });

  if (viewResult.error) {
    throw new Error(`npm view failed: ${viewResult.error.message}`);
  }
  if (viewResult.status !== 0) {
    throw new Error(firstNonEmptyLine(viewResult.stderr) ?? firstNonEmptyLine(viewResult.stdout) ?? 'npm view failed');
  }

  const distTags = parseNpmDistTags(viewResult.stdout);
  const result: NpmDistTagLookupResult = {
    dist_tags: distTags,
    checked_at: now.toISOString(),
    cached: false,
  };

  writeCachedNpmDistTags(cachePath, {
    version: 1,
    package_name: packageName,
    fetched_at: result.checked_at,
    dist_tags: distTags,
  });

  return result;
}

function parseNpmDistTags(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`npm view returned invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm view did not return a dist-tag object.');
  }

  const distTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      distTags[key] = value.trim();
    }
  }

  if (Object.keys(distTags).length === 0) {
    throw new Error('npm view returned an empty dist-tag object.');
  }

  return distTags;
}

function resolveNpmUpdateCachePath(packageName: string): string {
  const safeName = packageName.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || DEFAULT_NPM_UPDATE_PACKAGE;
  return path.join(os.homedir(), '.brainclaw', 'cache', 'installable-updates', `${safeName}.json`);
}

function readCachedNpmDistTags(
  cachePath: string,
  packageName: string,
  now: Date,
  ttlMs: number,
): NpmDistTagLookupResult | undefined {
  if (!fs.existsSync(cachePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Partial<CachedNpmDistTagsDocument>;
    if (
      parsed.version !== 1
      || parsed.package_name !== packageName
      || typeof parsed.fetched_at !== 'string'
      || !parsed.dist_tags
      || typeof parsed.dist_tags !== 'object'
      || Array.isArray(parsed.dist_tags)
    ) {
      return undefined;
    }

    const fetchedAt = Date.parse(parsed.fetched_at);
    if (!Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > ttlMs) {
      return undefined;
    }

    const distTags: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.dist_tags)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        distTags[key] = value.trim();
      }
    }
    if (Object.keys(distTags).length === 0) {
      return undefined;
    }

    return {
      dist_tags: distTags,
      checked_at: parsed.fetched_at,
      cached: true,
    };
  } catch {
    return undefined;
  }
}

function writeCachedNpmDistTags(cachePath: string, document: CachedNpmDistTagsDocument): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  } catch {
    // Cache writes are best-effort only.
  }
}

function formatNpmSourceDescription(packageName: string, distTag: string, defaultSource: boolean): string {
  return defaultSource ? `${packageName}@${distTag} (default npm channel)` : `${packageName}@${distTag}`;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function toManifestRelativePath(value: string): string {
  const portable = toPortablePath(value);
  if (portable.startsWith('./') || portable.startsWith('../')) {
    return portable;
  }
  return `./${portable}`;
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeConfiguredVersion(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return parseVersion(trimmed) ? trimmed : null;
}

function invalidField(fieldName: string, rawValue: string | undefined): string | undefined {
  if (!rawValue || rawValue.trim().length === 0) {
    return undefined;
  }

  return parseVersion(rawValue.trim()) ? undefined : `${fieldName}=${rawValue.trim()}`;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = value.match(SEMVER_RE);
  if (!match) {
    return undefined;
  }

  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return 0;
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number.parseInt(leftPart, 10) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number.parseInt(rightPart, 10) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}
