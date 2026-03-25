import { type AiSurfaceInfo } from './ai-surface-inventory.js';
export type OsVariant = 'windows' | 'macos' | 'linux' | 'windows+wsl2';
export interface ShellInfo {
    name: string;
    path?: string;
    default: boolean;
}
export interface GitUserInfo {
    name: string;
    email: string;
    scope: 'global' | 'local';
    /** Remote host this user is associated with (e.g. github.com, gitlab.com) */
    host?: string;
}
export interface SshKeyInfo {
    name: string;
    path: string;
    type: string;
    /** Host this key is configured for in ~/.ssh/config (if any) */
    configured_host?: string;
}
export interface ToolchainInfo {
    name: string;
    available: boolean;
    version?: string;
    path?: string;
}
export interface WslDistroInfo {
    name: string;
    default: boolean;
    /** Node.js path inside this distro (if detected) */
    node_path?: string;
    node_version?: string;
}
export interface MachineProfile {
    /** Schema version for forward-compat */
    schema_version: number;
    /** When this profile was last generated */
    generated_at: string;
    /** Hostname */
    hostname: string;
    /** OS username (who is running brainclaw on this machine) */
    os_user: string;
    /** Home directory */
    home_dir: string;
    /** OS variant */
    os_variant: OsVariant;
    /** Platform from Node.js */
    platform: NodeJS.Platform;
    /** OS release */
    os_release: string;
    /** CPU architecture */
    arch: string;
    /** Available shells */
    shells: ShellInfo[];
    /** Git users configured */
    git_users: GitUserInfo[];
    /** SSH keys found */
    ssh_keys: SshKeyInfo[];
    /** Toolchains detected */
    toolchains: ToolchainInfo[];
    /** WSL distros (Windows only) */
    wsl_distros: WslDistroInfo[];
    /** Desktop AI apps, web surfaces, and CLI AI surfaces discovered on this machine */
    ai_surfaces: AiSurfaceInfo[];
}
/**
 * Build a complete machine profile by detecting all system capabilities.
 */
export declare function buildMachineProfile(): MachineProfile;
/**
 * Path to the machine profile file.
 */
export declare function machineProfilePath(): string;
/**
 * Save a machine profile to ~/.brainclaw/machine.yaml.
 */
export declare function saveMachineProfile(profile: MachineProfile): string;
/**
 * Load the machine profile from ~/.brainclaw/machine.yaml.
 * Returns undefined if no profile exists.
 */
export declare function loadMachineProfile(): MachineProfile | undefined;
/**
 * Render a human-readable summary of the machine profile.
 */
export declare function renderMachineProfileSummary(profile: MachineProfile): string;
//# sourceMappingURL=machine-profile.d.ts.map