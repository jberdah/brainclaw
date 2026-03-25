export interface SearchResult {
    id: string;
    section: string;
    text: string;
    author?: string;
    created_at: string;
    tags: string[];
    related_paths?: string[];
    score: number;
}
export interface SearchCorpusDocument {
    id: string;
    section: string;
    text: string;
    author?: string;
    created_at: string;
    tags: string[];
    related_paths?: string[];
}
export interface SearchOptions {
    query: string;
    section?: string;
    since?: string;
    tags?: string[];
    includePending?: boolean;
    maxResults?: number;
    cwd?: string;
}
export declare function searchCorpus(documents: SearchCorpusDocument[], options: Omit<SearchOptions, 'cwd' | 'includePending'>): SearchResult[];
export declare function search(options: SearchOptions): SearchResult[];
//# sourceMappingURL=search.d.ts.map