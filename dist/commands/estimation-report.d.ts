export interface EstimationReportOptions {
    agent?: string;
    json?: boolean;
    cwd?: string;
}
export interface PlanEstimationEntry {
    id: string;
    text: string;
    author: string;
    estimated_minutes?: number;
    actual_effort?: string;
    elapsed_minutes?: number;
    ratio?: number;
    completed_at?: string;
}
export interface EstimationReportResult {
    entries: PlanEstimationEntry[];
    summary: {
        total: number;
        with_estimate: number;
        with_both: number;
        median_ratio?: number;
        mean_ratio?: number;
        calibration_hint?: string;
    };
}
/** Parse legacy actual_effort strings ("30min", "2h", "1h30m", "1d", "45m") → minutes.
 *  Still needed for actual_effort which remains a free string. */
export declare function parseEffortMinutes(effort: string): number | undefined;
export declare function buildCalibrationHint(medianRatio: number): string;
/** Render a ratio bar (40 chars wide, 1.0x at the midpoint). */
export declare function renderRatioBar(ratio: number, width?: number): string;
export declare function buildEstimationReport(options?: EstimationReportOptions): EstimationReportResult;
export declare function runEstimationReport(options?: EstimationReportOptions): void;
//# sourceMappingURL=estimation-report.d.ts.map