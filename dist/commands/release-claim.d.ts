export interface ReleaseClaimOptions {
    planStatus?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'dropped';
    cwd?: string;
}
export declare function runReleaseClaim(id: string, options?: ReleaseClaimOptions): void;
//# sourceMappingURL=release-claim.d.ts.map