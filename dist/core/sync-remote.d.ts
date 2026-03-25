export interface RemoteSyncResult {
    success: boolean;
    message: string;
    details?: string;
}
export declare function pullRemoteMemory(options?: {
    remote?: string;
    cwd?: string;
}): RemoteSyncResult;
export declare function pushRemoteMemory(options?: {
    remote?: string;
    cwd?: string;
    message?: string;
}): RemoteSyncResult;
export declare function diffRemoteMemory(options?: {
    remote?: string;
    cwd?: string;
}): RemoteSyncResult;
//# sourceMappingURL=sync-remote.d.ts.map