export interface SwitchOptions {
    list?: boolean;
    clear?: boolean;
    /** Scope switch to session only (default: true when a session is active). */
    session?: boolean;
    json?: boolean;
    cwd?: string;
}
export declare function runSwitch(projectRef: string | undefined, options?: SwitchOptions): void;
//# sourceMappingURL=switch.d.ts.map