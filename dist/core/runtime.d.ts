import { type MemoryVisibility, type RuntimeNote } from './schema.js';
export interface RuntimeListOptions {
    agent?: string;
    visibility?: MemoryVisibility | 'all';
    hostId?: string;
    includeAllHosts?: boolean;
}
export interface RuntimeLookupOptions extends RuntimeListOptions {
}
export declare function ensureRuntimeDir(agent: string, cwd?: string, visibility?: MemoryVisibility, hostId?: string): void;
export declare function saveRuntimeNote(note: RuntimeNote, cwd?: string): void;
export declare function runtimeNotePath(note: RuntimeNote, cwd?: string): string;
export declare function deleteRuntimeNote(note: RuntimeNote, cwd?: string): boolean;
export declare function listRuntimeNotes(agentOrOptions?: string | RuntimeListOptions, cwd?: string): RuntimeNote[];
export declare function findRuntimeNoteById(id: string, options?: RuntimeLookupOptions, cwd?: string): RuntimeNote | undefined;
export declare function generateRuntimeNoteId(): string;
//# sourceMappingURL=runtime.d.ts.map