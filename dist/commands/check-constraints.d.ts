export interface CheckConstraintsOptions {
    staged?: boolean;
    files?: string[];
    json?: boolean;
}
export interface ConstraintViolation {
    constraintId: string;
    constraintText: string;
    matchedFiles: string[];
}
export declare function runCheckConstraints(options?: CheckConstraintsOptions): void;
//# sourceMappingURL=check-constraints.d.ts.map