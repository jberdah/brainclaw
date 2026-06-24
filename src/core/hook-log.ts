import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Append a one-line, timestamped diagnostic to ~/.brainclaw/hook.log.
 *
 * brainclaw session hooks (UserPromptSubmit / Stop) historically wrapped every
 * CLI call in `2>/dev/null`, which turned an actionable failure (e.g. "no
 * registered agent identity resolved") into a contentless "hook error: No
 * stderr output" on every prompt (trp#917). Hook-mode commands now degrade to
 * exit 0 and drop a line here instead, so the failure is silent to the agent's
 * prompt loop but still debuggable.
 *
 * Best-effort and never throws — a logging failure must not break a hook.
 */
const MAX_LOG_BYTES = 256 * 1024;

export function hookLogPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.brainclaw', 'hook.log');
}

export function logHookDiagnostic(message: string, homeDir: string = os.homedir()): void {
  try {
    const file = hookLogPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Size-cap: when the log grows past the cap, keep only the tail so it never
    // balloons unbounded across thousands of prompts.
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(file, 'utf-8').slice(-Math.floor(MAX_LOG_BYTES / 2));
        fs.writeFileSync(file, tail, 'utf-8');
      }
    } catch {
      /* no existing file — nothing to truncate */
    }
    const line = `${new Date().toISOString()} ${message.replace(/\s+/g, ' ').trim()}\n`;
    fs.appendFileSync(file, line, 'utf-8');
  } catch {
    /* best-effort — never break a hook over logging */
  }
}
