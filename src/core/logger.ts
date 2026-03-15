export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Initialise log level from --verbose/--debug flags or BRAINCLAW_LOG_LEVEL env. */
export function initLogLevel(opts: { verbose?: boolean; debug?: boolean }): void {
  if (opts.debug) {
    currentLevel = 'debug';
  } else if (opts.verbose) {
    currentLevel = 'info';
  } else {
    const env = process.env['BRAINCLAW_LOG_LEVEL'];
    if (env && env in LEVEL_ORDER) {
      currentLevel = env as LogLevel;
    }
  }
}

/** All output goes to stderr so it never pollutes stdout (MCP / JSON). */
export const logger = {
  error(...args: unknown[]) {
    if (LEVEL_ORDER['error'] <= LEVEL_ORDER[currentLevel])
      console.error('[brainclaw:error]', ...args);
  },
  warn(...args: unknown[]) {
    if (LEVEL_ORDER['warn'] <= LEVEL_ORDER[currentLevel])
      console.error('[brainclaw:warn]', ...args);
  },
  info(...args: unknown[]) {
    if (LEVEL_ORDER['info'] <= LEVEL_ORDER[currentLevel])
      console.error('[brainclaw:info]', ...args);
  },
  debug(...args: unknown[]) {
    if (LEVEL_ORDER['debug'] <= LEVEL_ORDER[currentLevel])
      console.error('[brainclaw:debug]', ...args);
  },
};
