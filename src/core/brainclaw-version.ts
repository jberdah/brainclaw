import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BrainclawLocalReleaseManifestSchema,
  type BrainclawUpdateSource,
  type Config,
} from './schema.js';

type VersionStatus = 'ok' | 'update_available' | 'upgrade_required' | 'invalid_config';
type InstallableUpdateStatus = 'not_configured' | 'unsupported_source' | 'check_failed' | 'up_to_date' | 'update_available' | 'invalid_config';

export const DEFAULT_LOCAL_RELEASES_DIR = '.releases';
export const DEFAULT_LOCAL_RELEASE_MANIFEST_PATH = `${DEFAULT_LOCAL_RELEASES_DIR}/brainclaw-local.json`;

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
  status: InstallableUpdateStatus;
  message: string;
}

export interface BrainclawLocalReleasePublication {
  package_name: string;
  workspace_version: string;
  manifest_path: string;
  artifact_path: string;
  install_command: string;
  release_notes: string | null;
}

export interface PublishLocalBrainclawReleaseOptions {
  releaseNotes?: string;
  manifestPath?: string;
  outputDir?: string;
}

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

let cachedCliVersion: string | undefined;

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
): BrainclawInstallableUpdateCheck {
  const source = config?.brainclaw_update_source;
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
    const packageName = source.package_name?.trim() || 'brainclaw';
    const distTag = source.dist_tag?.trim() || 'latest';
    return {
      checked: false,
      source_type: 'npm',
      source_description: `${packageName}@${distTag}`,
      latest_installable_version: null,
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'unsupported_source',
      message: 'The npm update source is modeled in config but is not implemented yet in this build.',
    };
  }

  const manifestPath = source.manifest_path.trim();
  if (manifestPath.length === 0) {
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
    };
  }

  const resolvedManifestPath = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(cwd, manifestPath);

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
      };
    }

    const artifactPath = manifest.artifact_path
      ? resolveManifestArtifactPath(manifest.artifact_path, resolvedManifestPath)
      : null;
    const installCommand = manifest.install_command?.trim()
      || (artifactPath ? `npm install -g "${artifactPath}"` : config?.brainclaw_upgrade_command?.trim() || null);
    const releaseNotes = manifest.release_notes?.trim() || config?.brainclaw_upgrade_message?.trim() || null;
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
        status: 'update_available',
        message: `A newer installable brainclaw build is available: ${latestVersion} (installed ${installedVersion}).`,
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
      status: 'up_to_date',
      message: `Installed brainclaw ${installedVersion} is up to date for the configured local-pack channel.`,
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
    };
  }
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

  const manifest = BrainclawLocalReleaseManifestSchema.parse({
    version: 1,
    channel: 'local-pack',
    package_name: workspacePackage.name,
    latest_installable_version: workspacePackage.version,
    published_at: new Date().toISOString(),
    artifact_path: manifestArtifactPath,
    install_command: installCommand,
    release_notes: releaseNotes ?? undefined,
  });

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return {
    package_name: workspacePackage.name,
    workspace_version: workspacePackage.version,
    manifest_path: projectManifestPath,
    artifact_path: projectArtifactPath,
    install_command: installCommand,
    release_notes: releaseNotes,
  };
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
