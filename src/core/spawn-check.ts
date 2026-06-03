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
import {
  buildInvokeCommand,
  getSpawnableAgents,
  getCapabilityProfile,
  type InvokeCommand,
} from './agent-capability.js';
import { defaultExecutionAdapter, resolveBinaryOnPath } from './execution-adapters.js';
import { signalExists, readLogTail } from './runtime-signals.js';

export type SpawnCheckStatus =
  | 'ok'                      // ack + completed round-trip
  | 'delivered_no_completion' // spawned + ack, but never completed within timeout (the silent-death symptom)
  | 'failed'                  // wrapper reported failure, or delivery never happened
  | 'not_installed'           // binary not on PATH — skipped
  | 'no_template';            // agent has no CLI invoke template

export interface SpawnCheckEntry {
  agent: string;
  binary?: string;
  status: SpawnCheckStatus;
  delivered: boolean;
  completed: boolean;
  duration_ms: number;
  detail: string;
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

/** Check one agent's spawn round-trip. Exposed for focused testing. */
export async function checkAgentSpawn(agent: string, options: SpawnCheckOptions = {}): Promise<SpawnCheckEntry> {
  const start = Date.now();
  const profile = getCapabilityProfile(agent);
  if (!profile?.invoke_template || !profile?.invoke_binary || !profile.runtime.canBeSpawnedCli) {
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

    if (completed) {
      return { agent, binary, status: 'ok', delivered, completed: true, duration_ms, detail: 'ack + completed round-trip' };
    }
    if (failed) {
      const tail = readLogTail(root, assignmentId, 'stderr', 400).trim() || readLogTail(root, assignmentId, 'stdout', 400).trim();
      return { agent, binary, status: 'failed', delivered, completed: false, duration_ms, detail: `wrapper reported failure${tail ? ` — ${tail.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` };
    }
    if (delivered) {
      return { agent, binary, status: 'delivered_no_completion', delivered: true, completed: false, duration_ms, detail: `spawned + ack but no completion within ${timeout}ms (silent-death symptom)` };
    }
    return { agent, binary, status: 'failed', delivered: false, completed: false, duration_ms, detail: `no ack within ${timeout}ms — delivery failed` };
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

  const installed = entries.filter((e) => e.status !== 'not_installed' && e.status !== 'no_template');
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
