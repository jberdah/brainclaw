import child_process from 'node:child_process';

import type { LoopEvent, LoopThread, OperatorQuestionBody } from '../types.js';

/**
 * pln#513 step 4 — OS notifications hook on input_requested events.
 *
 * Best-effort, fire-and-forget OS-native heads-up so the operator notices
 * when a bootstrap loop pauses on an operator_question. Gated by
 * `BRAINCLAW_OPERATOR_NOTIFICATIONS=1` (opt-in) and scoped to bootstrap-preset
 * loops in v1. Every code path is wrapped so a missing notifier binary,
 * unparseable artifact body, or spawn error never propagates to the caller —
 * the journal write must remain the source of truth.
 */

const TITLE = 'brainclaw';
const QUESTION_TEXT_CAP = 80;

function isEnabled(): boolean {
  return process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS === '1';
}

function isBootstrapLoop(loop: LoopThread): boolean {
  return loop.protocol?.preset === 'bootstrap';
}

/**
 * Resolve the matching operator_question artifact body for the event's
 * question_id and return its question_text, truncated. Returns undefined
 * whenever the artifact can't be located or its body fails to parse —
 * the notification body still works without it.
 */
function resolveQuestionText(event: LoopEvent, loop: LoopThread): string | undefined {
  if (event.kind !== 'input_requested') return undefined;
  for (const artifact of loop.artifacts) {
    if (artifact.type !== 'operator_question' || artifact.body === undefined) continue;
    try {
      const body = JSON.parse(artifact.body) as OperatorQuestionBody;
      if (body.question_id === event.question_id) {
        const text = body.question_text;
        if (typeof text !== 'string' || text.length === 0) return undefined;
        return text.length > QUESTION_TEXT_CAP
          ? `${text.slice(0, QUESTION_TEXT_CAP)}…`
          : text;
      }
    } catch {
      // ignore unparseable bodies; fall through to the next artifact
    }
  }
  return undefined;
}

/**
 * Sanitize the message before passing it to a shell-bridge command
 * (osascript, powershell). We allow only printable ASCII apart from
 * double-quotes / backticks / backslashes / control chars to avoid quoting
 * pitfalls on every platform. The fallback `notify-send` on Linux runs
 * via an arg vector so its sanitization is just length-capping.
 */
function sanitizeForShell(message: string): string {
  return message
    .replace(/["`\\$]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

function composeMessage(event: LoopEvent, loop: LoopThread): string {
  const base = `brainclaw bootstrap: question awaiting input on loop ${loop.id}`;
  const text = resolveQuestionText(event, loop);
  return text ? `${base} — ${text}` : base;
}

function spawnDetached(command: string, args: string[]): void {
  const child = child_process.spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {
    // missing binary or exec failure — best-effort, swallow.
  });
  child.unref();
}

function notifyLinux(message: string): void {
  spawnDetached('notify-send', [TITLE, message]);
}

function notifyMac(message: string): void {
  const safe = sanitizeForShell(message);
  spawnDetached('osascript', [
    '-e',
    `display notification "${safe}" with title "${TITLE}"`,
  ]);
}

function notifyWindows(message: string): void {
  const safe = sanitizeForShell(message);
  // Try BurntToast if available; fall back to a terminal bell on stderr if
  // PowerShell itself cannot be invoked. Both paths are best-effort — we
  // never observe the exit code.
  const psCommand =
    `if (Get-Module -ListAvailable -Name BurntToast) { ` +
    `Import-Module BurntToast; New-BurntToastNotification -Text "${TITLE}", "${safe}" ` +
    `} else { [console]::Beep(800, 200) }`;
  const child = child_process.spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => {
    try {
      process.stderr.write('\x07');
    } catch {
      // give up silently
    }
  });
  child.unref();
}

/**
 * Fire an OS-native notification on `input_requested` events for bootstrap
 * loops. Returns immediately when:
 *   - the event is not `input_requested`,
 *   - the env-var opt-in is missing,
 *   - the loop's protocol preset is not `bootstrap`,
 *   - the host platform has no supported notifier.
 *
 * Never throws. The cwd parameter is accepted for parity with other hooks
 * but currently unused — the hook decides everything from the event + loop
 * snapshot the caller already loaded.
 */
export function notifyOperatorOnInputRequested(
  event: LoopEvent,
  loop: LoopThread,
  cwd?: string,
): void {
  void cwd;
  try {
    if (event.kind !== 'input_requested') return;
    if (!isEnabled()) return;
    if (!isBootstrapLoop(loop)) return;

    const message = composeMessage(event, loop);

    switch (process.platform) {
      case 'linux':
        notifyLinux(message);
        return;
      case 'darwin':
        notifyMac(message);
        return;
      case 'win32':
        notifyWindows(message);
        return;
      default:
        return;
    }
  } catch {
    // Hook is best-effort — swallow any unexpected error so the journal
    // write that triggered us stays the source of truth.
  }
}
