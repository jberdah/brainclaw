import { type AgentReleaseNotes } from '../core/schema.js';
export interface VersionOptions {
    check?: boolean;
    json?: boolean;
    publishLocal?: boolean;
    releaseNotes?: string;
    /** Structured agent-first release notes (JSON string or parsed object). */
    agentReleaseNotes?: string | AgentReleaseNotes;
    cwd?: string;
}
export declare function runVersion(options?: VersionOptions): void;
//# sourceMappingURL=version.d.ts.map