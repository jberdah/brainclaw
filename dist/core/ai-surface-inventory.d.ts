export type AiSurfaceKind = 'desktop_ai_app' | 'desktop_embedded_capability' | 'web_surface' | 'cli_agent';
export type AiSurfaceStatus = 'not_detected' | 'detected_install' | 'detected_running' | 'detected_config' | 'brainclaw_ready' | 'limited';
export type AiSurfaceCapability = 'yes' | 'no' | 'limited' | 'unknown';
export interface AiSurfaceInfo {
    id: string;
    product_name: string;
    display_name: string;
    surface_kind: AiSurfaceKind;
    variant?: string;
    parent_surface_id?: string;
    status: AiSurfaceStatus;
    running: boolean;
    install_source?: string;
    install_location?: string;
    version?: string;
    detection_sources: string[];
    supports_mcp: AiSurfaceCapability;
    supports_remote_connectors: AiSurfaceCapability;
    supports_local_config: AiSurfaceCapability;
    supports_context_export: AiSurfaceCapability;
    supports_prompt_bootstrap: AiSurfaceCapability;
    supports_safe_write_actions: AiSurfaceCapability;
    interactive_only: boolean;
    can_edit_code: boolean;
    recommended_uses: string[];
}
export interface WindowsAppxPackageInfo {
    name: string;
    version?: string;
    installLocation?: string;
}
export interface BuildAiSurfaceInventoryOptions {
    homeDir?: string;
    platform?: NodeJS.Platform;
    processNames?: string[];
    windowsAppxPackages?: WindowsAppxPackageInfo[];
    browsers?: string[];
}
export declare function buildAiSurfaceInventory(options?: BuildAiSurfaceInventoryOptions): AiSurfaceInfo[];
export declare function renderAiSurfaceSummary(surfaces: AiSurfaceInfo[]): string[];
export declare function renderAiSurfaceUsageHints(surfaces: AiSurfaceInfo[]): string[];
//# sourceMappingURL=ai-surface-inventory.d.ts.map