import { type StoreTarget } from '../core/store-resolution.js';
export interface ToolOptions {
    tag?: string[];
    type?: string;
    author?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runTool(subcommand: string, args: string[], options?: ToolOptions): void;
//# sourceMappingURL=tool.d.ts.map