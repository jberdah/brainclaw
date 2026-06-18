/**
 * pln#520 step 2 — `brainclaw doctor --spawn-check`.
 *
 * A real, minimal spawn round-trip per installed agent BEFORE any real dispatch
 * (and in CI). For each CLI-spawnable agent whose binary is on PATH, it spawns
 * an ack-wrapped probe and waits for the ack + completed sentinels on the
 * current host. This validates delivery + the spawn/handshake/sentinel
 * mechanism on the actual agent×OS cell — it would have caught the 6 silent
 * deaths of can_f792cacd before launching them (a worker that spawns but never
 * reaches completion shows up here as `delivered_no_completion`).
 *
 * Uninstalled agents are skipped (`not_installed`), so this is safe to run in
 * CI where most agent CLIs are absent.
 *
 * @module
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildInvokeCommand,
  getSpawnableAgents,
  getCapabilityProfile,
  type InvokeCommand,
} from './agent-capability.js';
import { defaultExecutionAdapter, resolveBinaryOnPath } from './execution-adapters.js';
import { signalExists, readLogTail } from './runtime-signals.js';
import { recognizeStderrSignature } from './dispatch-status.js';

export type SpawnCheckStatus =
  | 'ok'                      // ack + completed round-trip
  | 'delivered_no_completion' // spawned + ack, but never completed within timeout (the silent-death symptom)
  | 'failed'                  // wrapper reported failure, or delivery never happened
  | 'not_installed'           // binary not on PATH — skipped
  | 'no_template'             // known agent, but no CLI invoke template (IDE-only)
  | 'unknown_agent';          // name resolves to no known/custom profile (often a casing/typo error)

export interface SpawnCheckEntry {
  agent: string;
  binary?: string;
  status: SpawnCheckStatus;
  delivered: boolean;
  completed: boolean;
  duration_ms: number;
  detail: string;
  /** Captured stderr tail lines on a fault, for boot-signature recognition (pln#533). */
  stderr_tail?: string[];
}

export interface SpawnCheckReport {
  host_os: NodeJS.Platform;
  total: number;
  ok: number;
  failures: number;
  not_installed: number;
  entries: SpawnCheckEntry[];
  /** Non-zero when any installed agent failed its round-trip. */
  exit_code: 0 | 1;
}

export interface SpawnCheckOptions {
  cwd?: string;
  /** Restrict the check to these agents (default: all CLI-spawnable). */
  agents?: string[];
  /** Per-agent round-trip timeout (default 15 s). */
  timeoutMs?: number;
  /** Prompt used for the probe round-trip. */
  probePrompt?: string;
  /** Test seam: build the probe invoke command for an agent. */
  probeFor?: (agent: string) => InvokeCommand | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_PROMPT = 'Reply with exactly: OK';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Make the probe's temp dir a real (empty) git repo so the round-trip is
 * representative of a real dispatch (workers always run inside a git worktree)
 * and so CLIs with a boot-time git-repo / trusted-directory check don't refuse
 * it (pln#533 fix). Best-effort: if git is unavailable the probe still runs.
 */
function initProbeGitRepo(root: string): void {
  try {
    const run = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 5000 });
    run('init', '-q');
    run('config', 'user.email', 'spawn-check@brainclaw.local');
    run('config', 'user.name', 'brainclaw spawn-check');
    run('config', 'commit.gpgsign', 'false');
    run('commit', '--allow-empty', '-q', '-m', 'spawn-check probe');
  } catch { /* git absent or failed — probe proceeds without it */ }
}

/** Check one agent's spawn round-trip. Exposed for focused testing. */
export async function checkAgentSpawn(agent: string, options: SpawnCheckOptions = {}): Promise<SpawnCheckEntry> {
  const start = Date.now();
  const profile = getCapabilityProfile(agent);
  if (!profile) {
    // Distinct from no_template: the name didn't resolve to any profile at all
    // (resolution is case-insensitive, so this is a genuine typo/unknown agent,
    // not a casing slip). Reported separately so the pre-flight reason points at
    // the spelling instead of the misleading "IDE-only?" template message.
    return { agent, status: 'unknown_agent', delivered: false, completed: false, duration_ms: 0, detail: `unknown agent '${agent}' — not a registered brainclaw profile` };
  }
  if (!profile.invoke_template || !profile.invoke_binary || !profile.runtime.canBeSpawnedCli) {
    return { agent, status: 'no_template', delivered: false, completed: false, duration_ms: 0, detail: 'no CLI invoke template' };
  }

  const binary = resolveBinaryOnPath(profile.invoke_binary);
  if (!binary) {
    return { agent, binary: profile.invoke_binary, status: 'not_installed', delivered: false, completed: false, duration_ms: 0, detail: `binary '${profile.invoke_binary}' not on PATH` };
  }

  const invoke = options.probeFor?.(agent)
    ?? buildInvokeCommand(agent, options.probePrompt ?? DEFAULT_PROBE_PROMPT, { mode: 'consult' });
  if (!invoke) {
    return { agent, binary, status: 'no_template', delivered: false, completed: false, duration_ms: 0, detail: 'could not build invoke command' };
  }

  // Isolated signals root so the probe never pollutes the project's runtime dir.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bclaw-spawncheck-${agent}-`));
  // pln#533 fix: make the probe dir a real git repo. Real workers run inside a
  // git worktree, and some CLIs refuse a non-git / untrusted dir at boot (codex:
  // "Not inside a trusted directory and --skip-git-repo-check was not specified")
  // — a non-git temp dir would otherwise produce a false-negative spawn failure.
  initProbeGitRepo(root);
  const assignmentId = 'spawn_check';
  try {
    defaultExecutionAdapter.start(invoke, { agent, assignmentId, ackRoot: root, worktreePath: root });

    const timeout = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (signalExists(root, assignmentId, 'completed')) break;
      if (signalExists(root, assignmentId, 'failed')) break;
      await sleep(100);
    }

    const delivered = signalExists(root, assignmentId, 'ack');
    const completed = signalExists(root, assignmentId, 'completed');
    const failed = signalExists(root, assignmentId, 'failed');
    const duration_ms = Date.now() - start;

    // Capture the stderr tail once (used both for the detail string and for
    // pln#533 boot-signature recognition on the preflight path).
    const stderrRaw = readLogTail(root, assignmentId, 'stderr', 800).trim();
    const stderrTail = stderrRaw ? stderrRaw.split(/\r?\n/).filter(Boolean) : undefined;

    if (completed) {
      return { agent, binary, status: 'ok', delivered, completed: true, duration_ms, detail: 'ack + completed round-trip' };
    }
    if (failed) {
      const tail = stderrRaw || readLogTail(root, assignmentId, 'stdout', 400).trim();
      return { agent, binary, status: 'failed', delivered, completed: false, duration_ms, detail: `wrapper reported failure${tail ? ` — ${tail.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`, stderr_tail: stderrTail };
    }
    if (delivered) {
      return { agent, binary, status: 'delivered_no_completion', delivered: true, completed: false, duration_ms, detail: `spawned + ack but no completion within ${timeout}ms (silent-death symptom)`, stderr_tail: stderrTail };
    }
    return { agent, binary, status: 'failed', delivered: false, completed: false, duration_ms, detail: `no ack within ${timeout}ms — delivery failed`, stderr_tail: stderrTail };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export async function runSpawnCheck(options: SpawnCheckOptions = {}): Promise<SpawnCheckReport> {
  const agentNames = options.agents ?? getSpawnableAgents().map((a) => a.name);
  const entries: SpawnCheckEntry[] = [];
  for (const agent of agentNames) {
    try {
      entries.push(await checkAgentSpawn(agent, options));
    } catch (err) {
      entries.push({
        agent, status: 'failed', delivered: false, completed: false, duration_ms: 0,
        detail: `spawn-check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const installed = entries.filter((e) => e.status !== 'not_installed' && e.status !== 'no_template' && e.status !== 'unknown_agent');
  const ok = installed.filter((e) => e.status === 'ok').length;
  const failures = installed.filter((e) => e.status === 'failed' || e.status === 'delivered_no_completion').length;
  const not_installed = entries.filter((e) => e.status === 'not_installed').length;

  return {
    host_os: process.platform,
    total: entries.length,
    ok,
    failures,
    not_installed,
    entries,
    exit_code: failures > 0 ? 1 : 0,
  };
}

export function renderSpawnCheckReport(report: SpawnCheckReport): string {
  const lines: string[] = [];
  lines.push(`Spawn-check — ${report.ok} ok / ${report.failures} failed / ${report.not_installed} not installed (host: ${report.host_os})`);
  lines.push('');
  for (const e of report.entries) {
    const icon = e.status === 'ok' ? '✔'
      : e.status === 'not_installed' || e.status === 'no_template' ? '·'
      : '✗';
    lines.push(`  ${icon} ${e.agent.padEnd(16)} ${e.status}${e.duration_ms ? ` (${e.duration_ms}ms)` : ''} — ${e.detail}`);
  }
  if (report.failures > 0) {
    lines.push('');
    lines.push('✗ One or more installed agents failed their spawn round-trip — fix before dispatching.');
  }
  return lines.join('\n');
}

// ── pln#533: pre-flight spawn gate ──────────────────────────────────────────
//
// Before engaging a sequence / review-loop on a target agent, run ONE trivial
// validation spawn so an environment death (config rejected, auth fail, model
// mismatch) surfaces instantly AND with a clear reason — instead of a generic
// "did not acknowledge 30000ms" verdict after the loop has already burned a
// cycle. Field proof (a cross-project field session): codex died 2× at boot
// (service_tier), gemini died at auth (no subscription); both showed only the
// generic timeout after the loop opened. The fix reuses checkAgentSpawn for the
// round-trip and recognizeStderrSignature (pln#527 #5) for the human reason.

export interface PreflightResult {
  agent: string;
  /** true ⇒ safe to engage; false ⇒ block / skip this agent with `reason`. */
  ok: boolean;
  status: SpawnCheckStatus | 'skipped';
  /** Short, agent-facing reason a pre-flight failed (or why it was skipped). */
  reason: string;
  /** Targeted remediation when a known boot signature matched. */
  recommended_next_action?: string;
}

/**
 * Pre-flight a single target agent. Pass criteria:
 *   - `ok` (ack + completed) → pass.
 *   - `delivered_no_completion` (ack but the trivial probe didn't finish in the
 *     short window) → PASS: the ack proves spawn + wrapper + delivery work; a
 *     boot death never acks. We don't want a slow-but-healthy agent to block.
 *   - `failed` / no-ack → BLOCK with a reason (enriched by a recognized boot
 *     signature when the stderr matches one).
 *   - `not_installed` / `no_template` → BLOCK: the agent cannot be spawned here,
 *     so opening a loop on it would only time out.
 * When BRAINCLAW_NO_SPAWN is set (tests/CI), pre-flight is skipped (ok:true).
 */
/**
 * Pure mapper: SpawnCheckEntry → PreflightResult. No spawning — exposed so the
 * pass/block policy (and the boot-signature enrichment) can be unit-tested with
 * synthetic entries.
 */
export function preflightResultFromEntry(entry: SpawnCheckEntry): PreflightResult {
  const agent = entry.agent;

  if (entry.status === 'ok' || entry.status === 'delivered_no_completion') {
    return { agent, ok: true, status: entry.status, reason: entry.detail };
  }

  if (entry.status === 'unknown_agent') {
    return {
      agent, ok: false, status: entry.status,
      reason: `unknown agent '${agent}' — not a registered brainclaw profile (check spelling/case)`,
      recommended_next_action: `Use a registered agent name (e.g. codex, claude-code, github-copilot). Names are case-insensitive — list installed agents with \`brainclaw doctor --spawn-check\`.`,
    };
  }

  if (entry.status === 'not_installed') {
    return {
      agent, ok: false, status: entry.status,
      reason: `${agent} binary not on PATH — cannot spawn it here`,
      recommended_next_action: `Install the ${agent} CLI (or target a different agent), then retry.`,
    };
  }
  if (entry.status === 'no_template') {
    return {
      agent, ok: false, status: entry.status,
      reason: `${agent} has no CLI spawn template — it cannot be auto-dispatched (IDE-only?)`,
      recommended_next_action: `Target a CLI-spawnable agent, or hand this work to ${agent} interactively.`,
    };
  }

  // failed (or no-ack) — try to attach a recognized boot signature.
  const sig = recognizeStderrSignature(entry.stderr_tail);
  return {
    agent, ok: false, status: entry.status,
    reason: sig?.summary ?? `${agent} failed its pre-flight spawn — ${entry.detail}`,
    recommended_next_action: sig?.recommended_next_action
      ?? `Inspect the ${agent} CLI config/auth (run \`brainclaw doctor --spawn-check\` for detail), fix it, then retry.`,
  };
}

export async function preflightAgentSpawn(agent: string, options: SpawnCheckOptions = {}): Promise<PreflightResult> {
  if (process.env.BRAINCLAW_NO_SPAWN === '1') {
    return { agent, ok: true, status: 'skipped', reason: 'pre-flight skipped (BRAINCLAW_NO_SPAWN)' };
  }

  // Pre-flight uses a tighter window than the full doctor round-trip: a boot
  // death fails fast, and an ack is enough to pass, so we don't need to wait
  // out a healthy agent's full probe completion.
  const entry = await checkAgentSpawn(agent, { timeoutMs: 8_000, ...options });
  return preflightResultFromEntry(entry);
}

/**
 * Pre-flight a set of target agents (deduped), one trivial probe each. Returns
 * the per-agent results plus `blocked` (the agents that failed). Callers use
 * `blocked` to skip those agents and surface their reasons instead of opening a
 * loop / dispatching work that would only time out.
 */
export async function preflightAgents(agents: string[], options: SpawnCheckOptions = {}): Promise<{
  results: PreflightResult[];
  blocked: PreflightResult[];
  all_ok: boolean;
}> {
  const unique = [...new Set(agents)];
  const results: PreflightResult[] = [];
  for (const agent of unique) {
    try {
      results.push(await preflightAgentSpawn(agent, options));
    } catch (err) {
      results.push({
        agent, ok: false, status: 'failed',
        reason: `pre-flight threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const blocked = results.filter((r) => !r.ok);
  return { results, blocked, all_ok: blocked.length === 0 };
}
