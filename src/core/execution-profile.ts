/**
 * Agent execution profile (pln#496 step stp_0339a439).
 *
 * The dispatch system needs to know how to spawn each agent on each host:
 *   - which shell to invoke (`set X=...` for cmd, `$env:X=...` for pwsh,
 *     `X=...` for bash/zsh)
 *   - which OS we are on (path quoting, sandbox semantics)
 *   - where Node lives if we have to invoke the CLI binary directly
 *   - which spawn mechanism (fresh CLI, long-running app-server, IDE
 *     extension IPC) is right for this agent
 *   - how to set the working directory (just spawn from cwd, cd into a
 *     worktree first, or rely solely on env vars)
 *   - which sandbox profile to ask the agent for (codex needs
 *     `workspace-write` on local-only commits per
 *     trap_review_sandbox_blocks_source_access)
 *
 * Today the dispatcher hardcodes most of this in OS-specific branches
 * (`set X=...` strings inside a Windows-only branch, etc.). The agent
 * registry has the right level of granularity but no place to record
 * execution-relevant facts. This module fills that gap.
 *
 * Design choices:
 *
 * 1. **Host vs per-agent fields.** The host detection is one value
 *    (this machine is Windows + pwsh + nodejs). Each agent inherits the
 *    host context and may override individual fields (e.g. an agent that
 *    needs bash even on Windows would override `shell`). Lookup uses
 *    `getExecutionProfile(agentName, inventory)` which merges host +
 *    agent override and supplies safe defaults so the dispatcher never
 *    receives undefined for required fields.
 *
 * 2. **Backward-compatible.** Both the host record and the per-agent
 *    override are optional. Inventories written before this module
 *    deserialize cleanly; the dispatcher applies defaults via
 *    `getExecutionProfile`. The OS-aware spawn step (stp_a9afe59d)
 *    consumes these fields in a follow-up commit.
 *
 * 3. **No assumption about sandbox semantics.** `sandbox_profile` is a
 *    hint to the agent invocation template; not every agent honours it,
 *    and brainclaw does not enforce sandbox at the OS level. The default
 *    is 'none' so legacy invocations stay literally identical.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';

// ── Types ──────────────────────────────────────────────────────────────────

/** Shells brainclaw knows how to emit env-set syntax for. */
export const SHELLS = ['bash', 'pwsh', 'cmd', 'sh', 'zsh'] as const;
export type Shell = (typeof SHELLS)[number];

/** Coarse OS family. Matches process.platform's coverage of brainclaw's tier-A platforms. */
export const OPERATING_SYSTEMS = ['win', 'mac', 'linux'] as const;
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

/** Spawn mechanism the dispatcher should use for this agent. */
export const SPAWN_METHODS = ['cli', 'app-server', 'extension-ipc', 'cli_spawn_legacy'] as const;
export type SpawnMethod = (typeof SPAWN_METHODS)[number];

/** Working-directory strategy at spawn time. */
export const WORKING_DIR_STRATEGIES = ['cwd', 'worktree-cd', 'env-only'] as const;
export type WorkingDirStrategy = (typeof WORKING_DIR_STRATEGIES)[number];

/** Sandbox hint passed to the agent invocation template. */
export const SANDBOX_PROFILES = ['workspace-write', 'read-only', 'none'] as const;
export type SandboxProfile = (typeof SANDBOX_PROFILES)[number];

/**
 * Execution profile fields. All optional at the wire format level; the
 * `getExecutionProfile` resolver fills required defaults so the dispatcher
 * never sees undefined for a field it needs to act on.
 */
export interface ExecutionProfile {
  shell?: Shell;
  os?: OperatingSystem;
  /** Absolute path to the Node binary. Useful on Windows where pwsh/cmd
   *  resolution differs from bash $PATH. */
  node_path?: string;
  spawn_method?: SpawnMethod;
  working_dir_strategy?: WorkingDirStrategy;
  sandbox_profile?: SandboxProfile;
}

/**
 * Resolved execution profile after merging host + per-agent + defaults.
 * Every field is non-optional so consumers can rely on it.
 */
export interface ResolvedExecutionProfile {
  shell: Shell;
  os: OperatingSystem;
  node_path: string | undefined;
  spawn_method: SpawnMethod;
  working_dir_strategy: WorkingDirStrategy;
  sandbox_profile: SandboxProfile;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Map process.platform onto our coarse OS enum. Anything outside the
 * tier-A trio resolves to 'linux' as the most permissive default — it
 * does not lie about what the host is, but it lets the dispatcher pick
 * a working set of shell-syntax decisions instead of refusing to spawn.
 */
function detectOs(platform: NodeJS.Platform = process.platform): OperatingSystem {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Sniff the host shell from environment variables. POSIX uses $SHELL;
 * Windows has neither $SHELL nor a single canonical answer — we look at
 * COMSPEC (cmd) and PSModulePath (pwsh) and prefer pwsh when both are
 * set since modern Windows agent integrations rely on it (codex CLI
 * resolves through pwsh.exe on Windows per pln#475).
 */
function detectShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Shell {
  // Windows first because it lacks $SHELL and uses different env vars.
  if (platform === 'win32') {
    if (env.PSModulePath) return 'pwsh';
    if (env.COMSPEC) return 'cmd';
    // Fallback: assume pwsh on modern Windows. Empirically more agents
    // tolerate pwsh than cmd, and this matches the brainclaw dispatch
    // template that ships today.
    return 'pwsh';
  }

  const shellEnv = env.SHELL;
  if (shellEnv) {
    const lower = shellEnv.toLowerCase();
    if (lower.endsWith('/zsh') || lower.endsWith('\\zsh')) return 'zsh';
    if (lower.endsWith('/bash') || lower.endsWith('\\bash')) return 'bash';
    if (lower.endsWith('/sh') || lower.endsWith('\\sh')) return 'sh';
    // Other shells (fish, csh, …) — bash is the safest fallback for
    // brainclaw's `X=value cmd` env-set pattern.
    return 'bash';
  }

  // POSIX without $SHELL — extremely rare but bash is the canonical default.
  return 'bash';
}

/**
 * Best-effort path to the running Node binary.
 *
 * `process.execPath` is the canonical answer for the current process —
 * it always points to the Node that's running brainclaw, which is the
 * Node any spawned agent should also see if PATH is misconfigured.
 *
 * On Windows this is a `.exe`; on POSIX it's a binary. Either way, the
 * dispatcher can fall back to it when `node` is not on PATH.
 */
function detectNodePath(): string | undefined {
  try {
    return process.execPath || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a host-level execution profile from environment + platform. Pure
 * (no side effects), so callers can stub env/platform in unit tests.
 *
 * Defaults applied here:
 *   - spawn_method: 'cli' — every shipping agent today uses fresh CLI.
 *     The app-server / extension-ipc methods come online with pln#496
 *     Phase 3 (stp_2c31f651) and individual agents will set their own
 *     override at that point.
 *   - working_dir_strategy: 'cwd' — matches today's dispatcher behaviour.
 *   - sandbox_profile: 'none' — neutral default. Agents that need
 *     workspace-write set it explicitly in their AgentDefinition.
 */
export interface DetectExecutionProfileOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function detectHostExecutionProfile(options: DetectExecutionProfileOptions = {}): ResolvedExecutionProfile {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    shell: detectShell(env, platform),
    os: detectOs(platform),
    node_path: detectNodePath(),
    spawn_method: 'cli',
    working_dir_strategy: 'cwd',
    sandbox_profile: 'none',
  };
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Hard-coded defaults that apply when neither the host record nor the
 * per-agent override specify a field. Kept centralised here so the
 * dispatcher never has to encode them.
 */
const DEFAULT_PROFILE: ResolvedExecutionProfile = {
  shell: 'bash',
  os: 'linux',
  node_path: undefined,
  spawn_method: 'cli',
  working_dir_strategy: 'cwd',
  sandbox_profile: 'none',
};

/**
 * Merge host + per-agent override + module defaults. The agent override
 * takes priority over the host, the host takes priority over module
 * defaults. Missing fields cascade silently — no exception is ever
 * thrown for a partially populated input, which matters because
 * inventories saved before this module gained the new fields must still
 * resolve cleanly.
 */
export function resolveExecutionProfile(
  host: ExecutionProfile | undefined,
  agentOverride: ExecutionProfile | undefined,
): ResolvedExecutionProfile {
  return {
    shell: agentOverride?.shell ?? host?.shell ?? DEFAULT_PROFILE.shell,
    os: agentOverride?.os ?? host?.os ?? DEFAULT_PROFILE.os,
    node_path: agentOverride?.node_path ?? host?.node_path ?? DEFAULT_PROFILE.node_path,
    spawn_method: agentOverride?.spawn_method ?? host?.spawn_method ?? DEFAULT_PROFILE.spawn_method,
    working_dir_strategy: agentOverride?.working_dir_strategy ?? host?.working_dir_strategy ?? DEFAULT_PROFILE.working_dir_strategy,
    sandbox_profile: agentOverride?.sandbox_profile ?? host?.sandbox_profile ?? DEFAULT_PROFILE.sandbox_profile,
  };
}

// ── Env-set rendering ──────────────────────────────────────────────────────

/**
 * Render a single `KEY=VALUE` environment assignment in the syntax of
 * the named shell. Used by the OS-aware spawn step (stp_a9afe59d) to
 * generate spawn commands the host shell will actually parse.
 *
 *   bash/zsh/sh   →  KEY="VALUE"
 *   pwsh          →  $env:KEY="VALUE"
 *   cmd           →  set KEY=VALUE
 *
 * Values are double-quoted in shells that support it; cmd uses the bare
 * `set NAME=VALUE` form because cmd's quoting rules are pathological for
 * embedded equals/quotes. Callers who need cmd-safe values must escape
 * upstream — this helper is intentionally thin.
 */
export function renderEnvSet(shell: Shell, key: string, value: string): string {
  switch (shell) {
    case 'pwsh': return `$env:${key}="${value}"`;
    case 'cmd':  return `set ${key}=${value}`;
    case 'bash':
    case 'zsh':
    case 'sh':
    default:     return `${key}="${value}"`;
  }
}

// ── Spawn prefix (used by dispatcher + execution adapters) ─────────────────

/**
 * Build a shell-correct prefix for an inline env-var set followed by a
 * command. Centralises what dispatcher.ts:buildEnvPrefix,
 * execution-adapters.ts:buildManualEnvPrefix, and the inline branch in
 * mcp.ts spawn dispatch were duplicating before pln#496 step
 * stp_a9afe59d.
 *
 * Output by shell:
 *   bash / zsh / sh : `BRAINCLAW_CLAIM_ID="clm_xxx" `   (inline env-set)
 *   pwsh            : `$env:BRAINCLAW_CLAIM_ID="clm_xxx"; `
 *   cmd             : `set BRAINCLAW_CLAIM_ID=clm_xxx && `
 *
 * Returns an empty string when claimId is empty or the dry-run sentinel —
 * callers use the prefix as `${prefix}<command>` so concatenation stays
 * safe.
 *
 * Defaults: when `shell` is omitted, the host shell is detected via
 * detectHostExecutionProfile(). This preserves the pre-pln#496 behaviour
 * (Windows → cmd, POSIX → bash) because Windows hosts without
 * PSModulePath resolve to cmd in detectShell, and POSIX without $SHELL
 * resolves to bash.
 */
export function buildClaimEnvPrefix(claimId: string | undefined, options?: { shell?: Shell }): string {
  if (!claimId || claimId === '(dry-run)') return '';
  const shell = options?.shell ?? detectHostExecutionProfile().shell;
  const assignment = renderEnvSet(shell, 'BRAINCLAW_CLAIM_ID', claimId);
  switch (shell) {
    case 'cmd':  return `${assignment} && `;
    case 'pwsh': return `${assignment}; `;
    case 'bash':
    case 'zsh':
    case 'sh':
    default:     return `${assignment} `;
  }
}

// ── Verification helper (used by setup / doctor) ───────────────────────────

/**
 * Try `node --version` from the resolved profile's `node_path` to confirm
 * the binary actually executes. Returns the version string when it does,
 * undefined otherwise. Cheap enough to call from setup; not called from
 * the dispatch hot path.
 */
export function verifyNodeBinary(nodePath: string | undefined, timeoutMs = 5000): string | undefined {
  if (!nodePath) return undefined;
  try {
    const result = spawnSync(nodePath, ['--version'], { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true });
    if (result.status !== 0) return undefined;
    return (result.stdout ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
}
