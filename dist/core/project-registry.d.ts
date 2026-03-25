import { type ProjectIdentityDocument, type TopologyMode } from './schema.js';
export declare function generateProjectId(): string;
export declare function loadProjectIdentity(cwd?: string, preferredDirName?: string): ProjectIdentityDocument;
export declare function saveProjectIdentity(identity: ProjectIdentityDocument, cwd?: string, preferredDirName?: string): void;
export declare function projectIdentityExists(cwd?: string, preferredDirName?: string): boolean;
export declare function resolveExistingProjectIdentity(cwd?: string): ProjectIdentityDocument | undefined;
export declare function buildProjectIdentity(input: {
    existing?: ProjectIdentityDocument;
    projectName: string;
    storageDir: string;
    topology: TopologyMode;
}): ProjectIdentityDocument;
//# sourceMappingURL=project-registry.d.ts.map