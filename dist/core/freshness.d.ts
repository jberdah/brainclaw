export interface ContextMarker {
    read_at: string;
    memory_version?: string;
    host_id?: string;
    target?: string;
    project?: string;
    all_hosts?: boolean;
}
export declare function getVisibleMemoryVersion(options?: {
    cwd?: string;
    hostId?: string;
    allHosts?: boolean;
}): string;
export declare function readContextMarker(cwd?: string): ContextMarker | undefined;
export declare function writeContextMarker(marker: ContextMarker, cwd?: string): void;
//# sourceMappingURL=freshness.d.ts.map