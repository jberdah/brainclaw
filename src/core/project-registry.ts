import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
import { nowISO } from './ids.js';
import { MEMORY_DIR, memoryPath } from './io.js';
import { ProjectIdentityDocumentSchema, type ProjectIdentityDocument, type TopologyMode } from './schema.js';

const PROJECT_IDENTITY_FILE = 'project.identity.json';

export function generateProjectId(): string {
  return `prj_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function loadProjectIdentity(cwd?: string, preferredDirName?: string): ProjectIdentityDocument {
  const filepath = memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName);
  return loadVersionedJsonFile<ProjectIdentityDocument>('project_identity', filepath).document;
}

export function saveProjectIdentity(identity: ProjectIdentityDocument, cwd?: string, preferredDirName?: string): void {
  const filepath = memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName);
  saveVersionedJsonFile('project_identity', filepath, ProjectIdentityDocumentSchema.parse(identity));
}

export function projectIdentityExists(cwd?: string, preferredDirName?: string): boolean {
  return fs.existsSync(memoryPath(PROJECT_IDENTITY_FILE, cwd, preferredDirName));
}

export function resolveExistingProjectIdentity(cwd?: string): ProjectIdentityDocument | undefined {
  for (const dirName of [MEMORY_DIR]) {
    try {
      return loadProjectIdentity(cwd, dirName);
    } catch {
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
    } catch {
      // Ignore missing or malformed config and keep searching.
    }
  }

  return undefined;
}

export function buildProjectIdentity(input: {
  existing?: ProjectIdentityDocument;
  projectName: string;
  storageDir: string;
  topology: TopologyMode;
}): ProjectIdentityDocument {
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
