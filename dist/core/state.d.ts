import { type State } from './schema.js';
export declare function emptyState(): State;
export declare function loadState(cwd?: string): State;
export declare function saveState(state: State, cwd?: string): void;
interface PersistStateOptions {
    writeProjectMarkdown?: boolean;
    eventAction?: 'update' | 'upgrade' | 'rollback';
    eventSummary?: string;
    commitMessage?: string;
}
export declare function persistState(state: State, cwd?: string, options?: PersistStateOptions): void;
export declare function mutateState<T>(mutateFn: (state: State) => T, cwd?: string, options?: PersistStateOptions): T;
export {};
//# sourceMappingURL=state.d.ts.map