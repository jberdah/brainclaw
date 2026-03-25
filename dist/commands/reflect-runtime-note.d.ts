import { type ReflectOptions } from './reflect.js';
import type { CandidateType } from '../core/schema.js';
export interface ReflectRuntimeNoteOptions extends ReflectOptions {
    type?: CandidateType;
    host?: string;
    allHosts?: boolean;
    json?: boolean;
    suggest?: boolean;
}
export declare function runReflectRuntimeNote(id: string, text: string | undefined, options: ReflectRuntimeNoteOptions): void;
export declare function suggestCandidateTypes(text: string, tags: string[]): Array<{
    type: CandidateType;
    score: number;
    reason: string;
}>;
//# sourceMappingURL=reflect-runtime-note.d.ts.map