/**
 * MCP command resolution + shared writer plumbing (pln#546 step 3 extraction).
 *
 * Extracted from agent-files.ts so the binary-resolution / shim-tracing logic
 * can evolve independently of the per-agent writers. Three concerns live here:
 *
 *   1. Resolving the brainclaw MCP server invocation from any host shell
 *      (which/where → cli.js shim → absolute node + cli.js pair). Falls back
 *      to `npx brainclaw mcp` when nothing else resolves.
 *   2. Building the `brainclawMcpEntry` JSON shape that every MCP writer emits
 *      under `mcpServers.brainclaw` (or its agent-specific equivalent).
 *   3. Hook-command rendering — `getBclawCliParts` + `buildHookCommand` for
 *      writers that emit session-start / Stop / context-diff entries.
 *
 * The `_forceResolve` module flag is private to this file; callers toggle it
 * via `withForcedResolve(cb)` so the next pair of `brainclawMcpEntry` calls
 * overwrites existing absolute paths (used by `patchAllMcpConfigs` post-upgrade).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cached MCP command — resolved once per process. */
let cachedMcpCommand: { command: string; args: string[] } | undefined;

/** Module-level flag: when true, brainclawMcpEntry overwrites existing paths. */
let _forceResolve = false;

/**
 * Resolve the brainclaw command for MCP configs.
 * Returns `{ command: "<node>", args: ["<cli.js>", "mcp"] }` so the config
 * works in non-login shells (VS Code Server, MCP subprocesses) on all OSes.
 *
 * Strategy:
 * 1. Find the brainclaw bin via which/where
 * 2. Trace from the bin/shim to the actual cli.js entry point
 * 3. Pair it with the absolute node path
 * Falls back to 'npx brainclaw mcp' if resolution fails.
 */
function resolveBrainclawMcpCommand(): { command: string; args: string[] } {
  const nodeBin = process.execPath;

  // 1. Try to resolve the cli.js from the installed brainclaw binary
  const cliJs = resolveBrainclawCliJs();
  if (cliJs) {
    return { command: nodeBin, args: [cliJs, 'mcp'] };
  }

  // 2. Fallback: npx (relies on PATH, may resolve wrong version)
  return { command: 'npx', args: ['brainclaw', 'mcp'] };
}

/**
 * Trace from the brainclaw bin/shim to the actual dist/cli.js file.
 * Works on Windows (.cmd shim), macOS/Linux (symlink to bin stub).
 */
function resolveBrainclawCliJs(): string | undefined {
  // Strategy A: find via which/where and trace to cli.js
  const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCmd, ['brainclaw'], { encoding: 'utf-8', timeout: 3000 });
    if (result.status === 0) {
      const resolved = result.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (resolved) {
        const cliJs = traceToCliJs(resolved);
        if (cliJs) return cliJs;
      }
    }
  } catch {
    // Non-fatal — try next strategy
  }

  // Strategy B: resolve from this file's own package (we ARE brainclaw)
  try {
    const ownCliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    if (fs.existsSync(ownCliJs)) return ownCliJs;
  } catch {
    // Non-fatal
  }

  return undefined;
}

/**
 * Given a bin path (shim or symlink), trace to the dist/cli.js entry point.
 *
 * Windows: .cmd shim contains a line like `"%_prog%" "%dp0%\node_modules\brainclaw\dist\cli.js" %*`
 * Unix: bin is a symlink → resolve to real path → go up to package root → dist/cli.js
 */
function traceToCliJs(binPath: string): string | undefined {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    // Read the .cmd shim and extract the cli.js path
    const cmdPath = binPath.endsWith('.cmd') ? binPath : `${binPath}.cmd`;
    try {
      const content = fs.readFileSync(cmdPath, 'utf-8');
      // Match patterns like: "%dp0%\node_modules\brainclaw\dist\cli.js"
      const match = content.match(/%dp0%\\([^\s"]+cli\.js)/);
      if (match) {
        const shimDir = path.dirname(cmdPath);
        const cliJs = path.resolve(shimDir, match[1]!);
        if (fs.existsSync(cliJs)) return cliJs;
      }
    } catch {
      // Fall through
    }
  } else {
    // Unix: follow symlink chain to the real bin, then find cli.js
    try {
      const realBin = fs.realpathSync(binPath);
      // Typical layout: .../node_modules/.bin/brainclaw → ../brainclaw/dist/cli.js
      // Or: .../node_modules/brainclaw/dist/cli.js (direct)
      if (realBin.endsWith('cli.js') && fs.existsSync(realBin)) return realBin;

      // The bin stub typically lives at node_modules/brainclaw/dist/cli.js
      // or node_modules/.bin/brainclaw → ../brainclaw/dist/cli.js
      const packageRoot = findPackageRoot(realBin);
      if (packageRoot) {
        const cliJs = path.join(packageRoot, 'dist', 'cli.js');
        if (fs.existsSync(cliJs)) return cliJs;
      }
    } catch {
      // Fall through
    }
  }

  return undefined;
}

/** Walk up from a file to find the nearest directory containing package.json with name "brainclaw". */
function findPackageRoot(from: string): string | undefined {
  let dir = path.dirname(from);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'brainclaw') return dir;
      }
    } catch { /* continue */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function getBrainclawMcpCommand(): { command: string; args: string[] } {
  if (!cachedMcpCommand) {
    cachedMcpCommand = resolveBrainclawMcpCommand();
  }
  return cachedMcpCommand;
}

/** Reset the cached MCP command so it gets re-resolved on next access. */
export function resetMcpCommandCache(): void {
  cachedMcpCommand = undefined;
}

/** Test/internal helper — read the current force-resolve state. */
export function isForceResolveEnabled(): boolean {
  return _forceResolve;
}

/**
 * Run `cb` with force-resolve mode enabled, so `brainclawMcpEntry` overwrites
 * any existing absolute paths in user MCP configs. Always restores the prior
 * state, even when `cb` throws.
 */
export function withForcedResolve<T>(cb: () => T): T {
  const previous = _forceResolve;
  _forceResolve = true;
  try {
    return cb();
  } finally {
    _forceResolve = previous;
  }
}

/**
 * Build a complete MCP server entry with relay model env injection.
 * Merges with the existing entry to preserve manual edits (e.g. custom command
 * path, additional env vars, extra args). Only sets defaults for missing fields.
 *
 * When `workspacePath` is provided, injects BRAINCLAW_CWD into the env so
 * the MCP server resolves the correct workspace root regardless of the IDE's
 * process.cwd() at launch time.
 */
export function brainclawMcpEntry(agentName: string, existing?: unknown, workspacePath?: string): Record<string, unknown> {
  const defaults = getBrainclawMcpCommand();
  const ex = isJsonObject(existing) ? existing : {};
  const exEnv = isJsonObject(ex.env) ? ex.env : {};

  // When _forceResolve is true (post-upgrade), always use newly resolved paths.
  // Otherwise preserve existing command if it's an absolute path (manual edit).
  // CRITICAL: once we decide to preserve the command, we MUST also preserve
  // the args. Previously args was always overwritten, which silently clobbered
  // manual customizations (--cwd, --debug, etc.) and broke setups on DGX.
  // See trp#12 + pln#450.
  const useExisting = !_forceResolve && typeof ex.command === 'string' && ex.command !== 'npx';
  const existingArgs = Array.isArray(ex.args) ? (ex.args as unknown[]) : undefined;

  return {
    command: useExisting ? ex.command : defaults.command,
    args: useExisting && existingArgs ? existingArgs : defaults.args,
    // Merge env: preserve user-added vars, ensure BRAINCLAW_AGENT is set
    env: {
      ...exEnv,
      BRAINCLAW_AGENT: agentName,
      ...(workspacePath ? { BRAINCLAW_CWD: workspacePath } : {}),
    },
    // Preserve timeout if set
    ...(typeof ex.timeout === 'number' ? { timeout: ex.timeout } : {}),
  };
}

export function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Resolve the brainclaw CLI invocation for hook configs.
 * Returns shell-safe parts like `["<node>", "<cli.js>"]` or `["npx", "brainclaw"]`.
 */
export function getBclawCliParts(): string[] {
  const mcpCmd = getBrainclawMcpCommand();
  if (mcpCmd.command === 'npx') return ['npx', 'brainclaw'];

  const argsWithoutMcp = [...mcpCmd.args];
  if (argsWithoutMcp[argsWithoutMcp.length - 1] === 'mcp') {
    argsWithoutMcp.pop();
  }

  return [
    mcpCmd.command.replace(/\\/g, '/'),
    ...argsWithoutMcp.map((arg) => arg.replace(/\\/g, '/')),
  ];
}

export type HookShell = 'bash' | 'powershell';

export function buildHookCommand(
  args: string[],
  shell: HookShell = os.platform() === 'win32' ? 'powershell' : 'bash',
): string {
  const rendered = [...getBclawCliParts(), ...args].map(quoteShellArg).join(' ');
  if (shell === 'powershell') {
    return `& ${rendered} 2>$null`;
  }
  return `${rendered} 2>/dev/null`;
}
