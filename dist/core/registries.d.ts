/**
 * Dedicated registries for project capabilities and tools.
 *
 * Replaces the legacy hack of storing capabilities/tools as decisions
 * with 'capability'/'tool' tags. Items are now persisted as individual
 * JSON files under discovery/capabilities/ and discovery/tools/.
 */
import type { ProjectCapability, ProjectTool } from './schema.js';
export declare function listCapabilities(cwd?: string): ProjectCapability[];
export declare function saveCapability(cap: ProjectCapability, cwd?: string): void;
export declare function deleteCapability(id: string, cwd?: string): boolean;
export declare function createCapability(opts: {
    name: string;
    description: string;
    category?: string;
    tags?: string[];
    author: string;
    authorId?: string;
    model?: string;
}, cwd?: string): ProjectCapability;
export declare function listTools(cwd?: string): ProjectTool[];
export declare function saveTool(tool: ProjectTool, cwd?: string): void;
export declare function deleteTool(id: string, cwd?: string): boolean;
export declare function createTool(opts: {
    name: string;
    description: string;
    type?: string;
    implementation?: string;
    tags?: string[];
    author: string;
    authorId?: string;
    model?: string;
}, cwd?: string): ProjectTool;
//# sourceMappingURL=registries.d.ts.map