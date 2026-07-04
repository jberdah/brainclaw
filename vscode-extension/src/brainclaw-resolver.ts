/**
 * Locate a runnable brainclaw CLI entry point and produce a spawn plan that
 * `cp.spawn(shell:false)` can execute directly on any OS — never a `.cmd` or
 * shell shim.
 *
 * Background — trp#927 (2026-07-03):
 *   The previous probe called `cp.exec(...)`, which resolves `brainclaw` on
 *   Windows via the shell (finds `brainclaw.cmd`). The actual MCP spawn used
 *   `cp.spawn(..., { shell: false })`, which on modern Node/win32 does NOT
 *   resolve a `.cmd` shim. So the probe cheerfully returned true and the real
 *   spawn threw `ENOENT`. On top of that, every probe failure was swallowed
 *   (`resolve(!err)`) so the user got no explanation.
 *
 * Design:
 *   1. Probe and spawn share the SAME mechanic — `node <cli.js>` under
 *      `spawn(shell:false)`. Whatever passes the probe will run.
 *   2. Each probe attempt is classified (`binary-missing` / `module-missing` /
 *      `timeout` / `spawn-failed` / `nonzero-exit` / `ok`), so when all tiers
 *      fail we can render a speaking error listing what was tried and why.
 *   3. The `global` tier resolves the npm shim to its concrete `cli.js` target
 *      (per the sh shim layout `<dir>/node_modules/brainclaw/dist/cli.js`) and
 *      hands that to spawn — the .cmd/.ps1 shims are never spawned directly.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type ProbeTier = 'local-bin' | 'workspace-dist' | 'global';

export type ProbeOutcome =
  | 'ok'
  | 'binary-missing'
  | 'module-missing'
  | 'timeout'
  | 'spawn-failed'
  | 'nonzero-exit';

export interface ProbeAttempt {
  tier: ProbeTier;
  script: string;
  outcome: ProbeOutcome;
  detail?: string;
}

/**
 * A concrete plan for spawning the brainclaw CLI. Always shaped as
 * `node <cli.js>` — never a `.cmd` / `.ps1` / shell shim — so it works with
 * `cp.spawn(..., { shell: false })` on Windows and POSIX alike.
 */
export interface BrainclawSpawnPlan {
  tier: ProbeTier;
  command: string;
  args: string[];
  script: string;
}

export type ResolveResult =
  | { ok: true; plan: BrainclawSpawnPlan; attempts: ProbeAttempt[] }
  | { ok: false; error: string; attempts: ProbeAttempt[] };

export interface ResolveOptions {
  probeTimeoutMs?: number;
  spawnFn?: typeof cp.spawn;
  whichBrainclaw?: () => Promise<string | undefined>;
  resolveShimTarget?: (shimPath: string) => string | undefined;
  nodeBinary?: string;
  existsSync?: (target: string) => boolean;
}

const CLI_TAIL = ['node_modules', 'brainclaw', 'dist', 'cli.js'];

const MODULE_MISSING_PATTERNS: readonly RegExp[] = [
  /Cannot find module/i,
  /MODULE_NOT_FOUND/,
  /ERR_MODULE_NOT_FOUND/,
];

export function localCliCandidate(cwd: string): string {
  return path.join(cwd, ...CLI_TAIL);
}

export function workspaceDistCandidate(cwd: string): string {
  return path.join(cwd, 'dist', 'cli.js');
}

/**
 * Default global-shim locator. Uses `where brainclaw` on win32 and
 * `command -v brainclaw` on POSIX; both are read via the shell (this is safe
 * — we only consume the *output* to derive a `.js` script path, we never
 * spawn the shim itself).
 */
async function defaultWhichBrainclaw(): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32'
        ? ['where', ['brainclaw']]
        : ['command', ['-v', 'brainclaw']];
    let out = '';
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(cmd, args, { shell: true, windowsHide: true });
    } catch {
      return resolve(undefined);
    }
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    proc.stderr?.on('data', () => { /* drain */ });
    proc.on('error', () => resolve(undefined));
    proc.on('exit', (code) => {
      if (code !== 0) return resolve(undefined);
      const first = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      resolve(first);
    });
  });
}

/**
 * Given a shim path returned by `where brainclaw` / `command -v brainclaw`,
 * derive the concrete `cli.js` target. Both the win32 (.cmd) and POSIX
 * shims npm installs follow the convention `<dir>/node_modules/brainclaw/dist/cli.js`
 * (see the sh shim body). If the .cmd shim itself is what came back on win32
 * we peel off the extension to derive the same base directory.
 */
function defaultResolveShimTarget(shimPath: string): string | undefined {
  const dir = path.dirname(shimPath);
  const candidate = path.join(dir, ...CLI_TAIL);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Probe a single script candidate using the SAME spawn mechanics the MCP
 * client will use later — `node <script> --version` under `shell:false`.
 * Classifies the outcome so callers can degrade with a speaking message.
 */
export async function probeScriptCandidate(
  tier: ProbeTier,
  script: string,
  cwd: string,
  opts: { timeoutMs?: number; spawnFn?: typeof cp.spawn; nodeBinary?: string; existsSync?: (t: string) => boolean } = {},
): Promise<ProbeAttempt> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const spawnFn = opts.spawnFn ?? cp.spawn;
  const nodeBinary = opts.nodeBinary ?? 'node';
  const existsSync = opts.existsSync ?? fs.existsSync;

  if (!existsSync(script)) {
    return { tier, script, outcome: 'binary-missing' };
  }

  return new Promise<ProbeAttempt>((resolve) => {
    let settled = false;
    const finish = (attempt: ProbeAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };

    let proc: cp.ChildProcess;
    try {
      proc = spawnFn(nodeBinary, [script, '--version'], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return finish({
        tier,
        script,
        outcome: 'spawn-failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    let stderr = '';
    proc.stdout?.on('data', () => { /* drain */ });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });

    proc.on('error', (err: Error) => {
      finish({ tier, script, outcome: 'spawn-failed', detail: err.message });
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        return finish({ tier, script, outcome: 'ok' });
      }
      const trimmed = stderr.trim();
      const detail = trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : (trimmed || undefined);
      const isModuleMissing = MODULE_MISSING_PATTERNS.some((pat) => pat.test(stderr));
      finish({
        tier,
        script,
        outcome: isModuleMissing ? 'module-missing' : 'nonzero-exit',
        detail,
      });
    });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      finish({ tier, script, outcome: 'timeout' });
    }, timeoutMs);
  });
}

/**
 * Locate a runnable brainclaw CLI in three tiers and return the plan that
 * spawns it. On failure the result carries a speaking error listing every
 * candidate tried and the classified reason each one failed.
 */
export async function resolveBrainclawSpawnPlan(
  cwd: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const nodeBinary = opts.nodeBinary ?? 'node';
  const existsSync = opts.existsSync ?? fs.existsSync;
  const attempts: ProbeAttempt[] = [];

  const candidates: Array<{ tier: ProbeTier; script: string }> = [
    { tier: 'local-bin', script: localCliCandidate(cwd) },
    { tier: 'workspace-dist', script: workspaceDistCandidate(cwd) },
  ];

  const which = opts.whichBrainclaw ?? defaultWhichBrainclaw;
  const shimPath = await which();
  if (shimPath) {
    const resolveShim = opts.resolveShimTarget ?? defaultResolveShimTarget;
    const target = resolveShim(shimPath);
    if (target) {
      candidates.push({ tier: 'global', script: target });
    } else {
      attempts.push({
        tier: 'global',
        script: shimPath,
        outcome: 'binary-missing',
        detail: `brainclaw is on PATH (${shimPath}) but its cli.js target could not be located under ${path.dirname(shimPath)}/${CLI_TAIL.join('/')}`,
      });
    }
  }

  for (const { tier, script } of candidates) {
    const attempt = await probeScriptCandidate(tier, script, cwd, {
      timeoutMs: opts.probeTimeoutMs,
      spawnFn: opts.spawnFn,
      nodeBinary,
      existsSync,
    });
    attempts.push(attempt);
    if (attempt.outcome === 'ok') {
      return {
        ok: true,
        plan: { tier, command: nodeBinary, args: [script], script },
        attempts,
      };
    }
  }

  return { ok: false, error: formatResolveError(attempts), attempts };
}

/**
 * Build a human-readable error listing every candidate tried and the reason
 * each one failed, plus a next-action hint when the failure pattern maps to
 * a common root cause (rased node_modules → `npm ci`, nothing installed
 * anywhere → `npm i -g brainclaw`).
 */
export function formatResolveError(attempts: readonly ProbeAttempt[]): string {
  if (attempts.length === 0) {
    return 'brainclaw not found: no candidates were probed (resolver produced no attempts — please file a bug)';
  }
  const lines: string[] = ['Could not locate a runnable brainclaw. Tried:'];
  for (const attempt of attempts) {
    lines.push(`  • [${attempt.tier}] ${attempt.script} → ${describeOutcome(attempt)}`);
  }
  const hint = suggestFix(attempts);
  if (hint) {
    lines.push('');
    lines.push(hint);
  }
  return lines.join('\n');
}

function describeOutcome(attempt: ProbeAttempt): string {
  switch (attempt.outcome) {
    case 'ok':
      return 'ok';
    case 'binary-missing':
      return attempt.detail ?? 'script file not present';
    case 'module-missing': {
      const first = attempt.detail?.split('\n')[0]?.trim();
      return `module missing${first ? ` (${first})` : ''} — node_modules likely rased, run \`npm ci\``;
    }
    case 'timeout':
      return 'timed out (probe did not exit in the allotted window)';
    case 'spawn-failed':
      return `spawn failed (${attempt.detail ?? 'unknown'})`;
    case 'nonzero-exit': {
      const first = attempt.detail?.split('\n')[0]?.trim();
      return `exited non-zero${first ? ` (${first})` : ''}`;
    }
  }
}

function suggestFix(attempts: readonly ProbeAttempt[]): string | undefined {
  const nonGlobal = attempts.filter((a) => a.tier !== 'global');
  const moduleMissing = nonGlobal.find((a) => a.outcome === 'module-missing');
  if (moduleMissing) {
    return `Hint: brainclaw script is present at ${moduleMissing.script} but a dependency is missing — run \`npm ci\` (or \`npm install\`) in the workspace.`;
  }
  const allBinaryMissing = attempts.length > 0 && attempts.every((a) => a.outcome === 'binary-missing');
  if (allBinaryMissing) {
    return 'Hint: install brainclaw either locally (`npm i brainclaw`) or globally (`npm i -g brainclaw`).';
  }
  return undefined;
}
