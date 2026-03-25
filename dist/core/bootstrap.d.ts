import { type BootstrapInterviewAnswer, type BootstrapApplicationReceipt, type BootstrapImportPlanDocument, type BootstrapProfileDocument, type MemorySeedConfidence, type MemorySeedDocument, type MemorySeedKind, type MemorySeedSourceKind } from './schema.js';
export interface BootstrapOptions {
    target?: string;
    refresh?: boolean;
    cwd?: string;
    interviewAnswers?: BootstrapInterviewAnswer[];
}
export interface BootstrapResult {
    profile: BootstrapProfileDocument;
    seeds: MemorySeedDocument[];
    importPlan: BootstrapImportPlanDocument;
    lastApplication?: BootstrapApplicationReceipt;
    reusedProfile: boolean;
}
export interface DerivedContextSignal {
    id: string;
    text: string;
    seed_kind: MemorySeedKind;
    source_kind: MemorySeedSourceKind;
    source_ref: string;
    confidence: MemorySeedConfidence;
    related_paths?: string[];
}
export interface ApplyBootstrapOptions extends BootstrapOptions {
    force?: boolean;
}
export interface BootstrapApplyResult {
    proposal: BootstrapImportPlanDocument;
    receipt?: BootstrapApplicationReceipt;
    createdCount: number;
    skippedCount: number;
}
export interface BootstrapUninstallResult {
    receipt?: BootstrapApplicationReceipt;
    deactivatedCount: number;
    deletedCount: number;
    skippedCount: number;
}
export declare function runBootstrapProfile(options?: BootstrapOptions): BootstrapResult;
export declare function listBootstrapSeeds(cwd?: string): MemorySeedDocument[];
export declare function loadBootstrapProfile(cwd?: string): BootstrapProfileDocument | undefined;
export declare function hasReusableBootstrapProfile(target?: string, cwd?: string): boolean;
export declare function selectDerivedSignals(target: string | undefined, maxSignals: number, cwd?: string): DerivedContextSignal[];
export declare function renderBootstrapSummary(result: BootstrapResult): string;
export declare function renderBootstrapInterview(result: BootstrapResult, audience?: 'cli' | 'ide_chat' | 'any'): string;
export declare function loadBootstrapImportPlan(cwd?: string): BootstrapImportPlanDocument | undefined;
export declare function loadBootstrapApplication(cwd?: string): BootstrapApplicationReceipt | undefined;
export declare function applyBootstrapImport(options?: ApplyBootstrapOptions): BootstrapApplyResult;
export declare function uninstallBootstrapImport(cwd?: string): BootstrapUninstallResult;
//# sourceMappingURL=bootstrap.d.ts.map