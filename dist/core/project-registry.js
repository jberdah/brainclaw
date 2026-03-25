import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { nowISO } from './ids.js';
import { MEMORY_DIR, memoryPath } from './io.js';
import { ProjectIdentityDocumentSchema } from './schema.js';
const PROJECT_IDENTITY_FILE = 'project.identity.json';
export function generateProjectId() {
    return `prj_${crypto.randomUUID().replace(/-/g, '')}`;
}
export function loadProjectIdentity(cwd, preferredDirName) {
    const filepath = memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName);
    return loadVersionedJsonFile('project_identity', filepath).document;
}
export function saveProjectIdentity(identity, cwd, preferredDirName) {
    const filepath = memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName);
    saveVersionedJsonFile('project_identity', filepath, ProjectIdentityDocumentSchema.parse(identity));
}
export function projectIdentityExists(cwd, preferredDirName) {
    return fs.existsSync(memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName));
}
export function resolveExistingProjectIdentity(cwd) {
    for (const dirName of [MEMORY_DIR]) {
        try {
            return loadProjectIdentity(cwd, dirName);
        }
        catch {
            // Ignore missing or malformed identity docs and keep searching.
        }
    }
    for (const dirName of [MEMORY_DIR]) {
        try {
            const config = loadConfig(cwd, dirName);
            if (config.project_id) {
                return {
                    schema_version: 2,
                    version: 1,
                    project_id: config.project_id,
                    project_name: config.project_name,
                    created_at: nowISO(),
                    storage_dir: config.storage_dir,
                    topology: config.topology,
                };
            }
        }
        catch {
            // Ignore missing or malformed config and keep searching.
        }
    }
    return undefined;
}
export function buildProjectIdentity(input) {
    return {
        schema_version: 2,
        version: 1,
        project_id: input.existing?.project_id ?? generateProjectId(),
        project_name: input.projectName,
        created_at: input.existing?.created_at ?? nowISO(),
        storage_dir: input.storageDir,
        topology: input.topology,
    };
}
//# sourceMappingURL=project-registry.js.map