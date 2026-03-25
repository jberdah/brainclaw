import { type ExportFormat } from '../core/agent-files.js';
export type { ExportFormat };
export interface ExportOptions {
    format?: ExportFormat;
    output?: string;
    project?: string;
    agent?: string;
    detect?: boolean;
    write?: boolean;
    shared?: boolean;
    all?: boolean;
    cwd?: string;
}
export declare function runExport(options: ExportOptions): void;
export declare function writeAgentExportForAgent(agentName: string, cwd: string): {
    relativePath: string;
    created: boolean;
    updated: boolean;
} | undefined;
export declare function renderAgentExportForAgent(agentName: string, cwd: string): {
    agentName: string;
    relativePath: string;
    content: string;
} | undefined;
export declare function writeDetectedAgentExport(detectedAgentName: string, cwd: string): {
    relativePath: string;
    created: boolean;
} | undefined;
//# sourceMappingURL=export.d.ts.map