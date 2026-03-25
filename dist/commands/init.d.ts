import type { ProjectMode, ProjectStrategy, TopologyMode } from '../core/schema.js';
export interface InitOptions {
    yes?: boolean;
    force?: boolean;
    compact?: boolean;
    projectMode?: ProjectMode;
    projectStrategy?: ProjectStrategy;
    storageDir?: string;
    topology?: TopologyMode;
    analyzeRepo?: boolean;
    scan?: boolean;
    cwd?: string;
    skipAgentBootstrap?: boolean;
    skipSetupRequirement?: boolean;
}
export declare function runInit(options?: InitOptions): Promise<void>;
//# sourceMappingURL=init.d.ts.map