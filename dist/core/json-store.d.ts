import type { VersionedDocumentType } from './migration.js';
export interface JsonStoreOptions<T> {
    dirPath: string;
    documentType: VersionedDocumentType;
    getId: (item: T) => string;
    sort?: (left: T, right: T) => number;
}
export declare class JsonStore<T> {
    private readonly dirPath;
    private readonly documentType;
    private readonly getId;
    private readonly sort?;
    constructor(options: JsonStoreOptions<T>);
    list(): T[];
    load(id: string): T;
    save(item: T): void;
    delete(id: string): void;
    exists(id: string): boolean;
    private ensureDir;
    private pathFor;
}
//# sourceMappingURL=json-store.d.ts.map