export interface ReviewOptions {
    json?: boolean;
    type?: string;
    prioritized?: boolean;
    onlyOverdue?: boolean;
    assignee?: string;
    forCurator?: string;
    take?: number;
    claim?: string;
    auto?: boolean;
    autoBy?: string;
    cwd?: string;
}
export declare function runReview(options?: ReviewOptions): void;
//# sourceMappingURL=review.d.ts.map