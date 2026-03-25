export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export declare function setLogLevel(level: LogLevel): void;
export declare function getLogLevel(): LogLevel;
/** Initialise log level from --verbose/--debug flags or BRAINCLAW_LOG_LEVEL env. */
export declare function initLogLevel(opts: {
    verbose?: boolean;
    debug?: boolean;
}): void;
/** All output goes to stderr so it never pollutes stdout (MCP / JSON). */
export declare const logger: {
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    debug(...args: unknown[]): void;
};
//# sourceMappingURL=logger.d.ts.map