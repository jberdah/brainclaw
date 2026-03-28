import { type AgentReleaseNotes, type BrainclawUpdateSource, type Config } from './schema.js';
type VersionStatus = 'ok' | 'update_available' | 'upgrade_required' | 'invalid_config';
type InstallableUpdateStatus = 'not_configured' | 'unsupported_source' | 'check_failed' | 'up_to_date' | 'update_available' | 'invalid_config';
export declare const DEFAULT_LOCAL_RELEASES_DIR = ".releases";
export declare const DEFAULT_LOCAL_RELEASE_MANIFEST_PATH = ".releases/brainclaw-local.json";
export declare const DEFAULT_NPM_UPDATE_PACKAGE = "brainclaw";
export declare const DEFAULT_NPM_UPDATE_DIST_TAG = "latest";
export declare const DEFAULT_INSTALLABLE_UPDATE_CACHE_TTL_MS: number;
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
type NpmDistTagLookup = (packageName: string, options: NpmDistTagLookupOptions) => NpmDistTagLookupResult;
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
export declare function detectConcurrentInstallations(): BrainclawInstallation[];
/**
 * Read the brainclaw version from disk (package.json), bypassing the in-memory cache.
 * Used by the MCP server to detect when a new version has been installed while the
 * long-running MCP process is still running with old code.
 */
export declare function readDiskBrainclawVersion(): string;
export declare function getInstalledBrainclawVersion(): string;
export declare function assessBrainclawVersion(config?: Pick<Config, 'minimum_brainclaw_version' | 'recommended_brainclaw_version' | 'brainclaw_upgrade_message' | 'brainclaw_upgrade_command'>): BrainclawVersionAssessment;
export declare function checkBrainclawInstallableUpdate(config: Pick<Config, 'brainclaw_update_source' | 'brainclaw_upgrade_command' | 'brainclaw_upgrade_message'> | undefined, cwd: string, options?: CheckBrainclawInstallableUpdateOptions): BrainclawInstallableUpdateCheck;
export declare function renderBrainclawInstallableUpdateNotice(updateCheck: BrainclawInstallableUpdateCheck | undefined): string | null;
export declare function publishLocalBrainclawRelease(cwd: string, options?: PublishLocalBrainclawReleaseOptions): BrainclawLocalReleasePublication;
export {};
//# sourceMappingURL=brainclaw-version.d.ts.map