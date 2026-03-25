import { type Config, type IgnoreStrategy, type ProjectMode, type ProjectStrategy, type TopologyMode } from './schema.js';
export interface DefaultConfigOptions {
    projectId?: string;
    currentAgent?: string;
    currentAgentId?: string;
    projectMode?: ProjectMode;
    projectStrategy?: ProjectStrategy;
    storageDir?: string;
    topology?: TopologyMode;
    ignoreStrategy?: IgnoreStrategy;
}
export declare function defaultConfig(projectName: string, options?: DefaultConfigOptions): Config;
export declare function loadConfig(cwd?: string, preferredDirName?: string): Config;
export declare function saveConfig(config: Config, cwd?: string, preferredDirName?: string): void;
//# sourceMappingURL=config.d.ts.map