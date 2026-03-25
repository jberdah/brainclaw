export type VersionedDocumentType = 'agent_identity' | 'bootstrap_application' | 'bootstrap_import_plan' | 'bootstrap_profile' | 'candidate' | 'claim' | 'config' | 'constraint' | 'current_session' | 'decision' | 'handoff' | 'instruction' | 'memory_seed' | 'plan' | 'project_identity' | 'runtime_note' | 'ai_surface_task' | 'session_snapshot' | 'capability' | 'tool' | 'trap';
export type MigrationErrorKind = 'parse' | 'unknown_version' | 'migration_failed' | 'validation_failed';
export declare class MigrationError extends Error {
    readonly kind: MigrationErrorKind;
    readonly documentType: VersionedDocumentType;
    constructor(kind: MigrationErrorKind, message: string, documentType: VersionedDocumentType);
}
export interface MigrationMetadata {
    detectedVersion: number;
    currentVersion: number;
    migrated: boolean;
}
export interface MigrationResult<T> {
    document: T;
    metadata: MigrationMetadata;
}
export interface MigrationCheckEntry {
    documentType: VersionedDocumentType;
    path: string;
    status: 'ok' | 'outdated' | 'invalid';
    detectedVersion?: number;
    currentVersion: number;
    error?: string;
}
export declare function currentDocumentVersion(documentType: VersionedDocumentType): number;
export declare function detectDocumentVersion(raw: unknown): number;
export declare function migrateVersionedDocument<T>(documentType: VersionedDocumentType, raw: unknown): MigrationResult<T>;
export declare function parseVersionedJsonDocumentFromString<T>(documentType: VersionedDocumentType, rawText: string): MigrationResult<T>;
export declare function parseVersionedYamlDocumentFromString<T>(documentType: VersionedDocumentType, rawText: string): MigrationResult<T>;
export declare function loadVersionedJsonFile<T>(documentType: VersionedDocumentType, filepath: string): MigrationResult<T>;
export declare function loadVersionedYamlFile<T>(documentType: VersionedDocumentType, filepath: string): MigrationResult<T>;
export declare function preparePersistedDocument<T>(documentType: VersionedDocumentType, document: T): T;
export declare function saveVersionedJsonFile<T>(documentType: VersionedDocumentType, filepath: string, document: T): void;
export declare function saveVersionedYamlFile<T>(documentType: VersionedDocumentType, filepath: string, document: T): void;
export declare function scanMigrationStatus(cwd?: string): MigrationCheckEntry[];
//# sourceMappingURL=migration.d.ts.map