export interface SearchCommandOptions {
    section?: string;
    since?: string;
    tag?: string[];
    pending?: boolean;
    maxResults?: number;
    json?: boolean;
}
export declare function runSearch(query: string, options?: SearchCommandOptions): void;
//# sourceMappingURL=search.d.ts.map