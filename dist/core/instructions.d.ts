import { type Config, type InstructionEntry, type InstructionLayer } from './schema.js';
export interface CreateInstructionOptions {
    layer: InstructionLayer;
    scope?: string;
    tags?: string[];
    author: string;
    supersedes?: string;
}
export interface ResolveInstructionsOptions {
    project?: string;
    agent?: string;
}
export declare function loadInstructions(cwd?: string): InstructionEntry[];
export declare function saveInstruction(entry: InstructionEntry, cwd?: string): void;
export declare function createInstruction(text: string, options: CreateInstructionOptions, cwd?: string): InstructionEntry;
export declare function resolveInstructions(entries: InstructionEntry[], options?: ResolveInstructionsOptions): InstructionEntry[];
export declare function inferProjectFromTarget(target: string | undefined, config: Config): string | undefined;
export declare function findInstructionConflicts(entries: InstructionEntry[]): Array<{
    layer: InstructionLayer;
    scope?: string;
    ids: string[];
}>;
//# sourceMappingURL=instructions.d.ts.map