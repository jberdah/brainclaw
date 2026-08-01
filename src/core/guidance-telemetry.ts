/**
 * pln#634 PR2 — guidance adherence telemetry.
 *
 * brainclaw emits `next_actions` and `warning_details[].next_actions` on more and
 * more surfaces (PR1, pln#635) but has never measured whether an agent's NEXT
 * call follows the suggestion. Without that number the whole guidance backlog
 * (pln#636/#637/#638) is prioritised on opinion: we cannot tell "the signal is
 * missing" from "the signal is ignored", and those two diagnoses have opposite
 * remedies — add more channels vs. stop adding channels and converge state
 * server-side instead.
 *
 * MECHANISM. `executeMcpToolCall` is the single seam every MCP call passes
 * through. After a response is built we remember which tools it suggested; on
 * the next call in the same session we compare. One observation per
 * suggestion→call pair.
 *
 * WHAT IS RECORDED: tool NAMES and a timestamp. Never arguments, never content,
 * never file paths — the adherence question needs no payload, and a telemetry
 * file that accumulated payloads would become a redaction problem
 * (trp_0d79711e). This is also why it is safe to keep on by default.
 *
 * COST. Observations accumulate in memory and flush in batches, so a session of
 * N calls costs ~N/BATCH writes rather than N. No daemon, no store mutation, no
 * journal noise: the file lives beside the other machine-local runtime
 * artifacts (ack/log sentinels).
 *
 * Opt out with `BRAINCLAW_GUIDANCE_TELEMETRY=0` (also false/off/no).
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';

const TELEMETRY_FILE = 'guidance-adherence.jsonl';
/** Flush every N observations — bounds writes without risking much on a crash. */
const FLUSH_EVERY = 20;
/** Rotate past this size so the file cannot grow without bound. */
const MAX_BYTES = 512 * 1024;

export interface AdherenceObservation {
  at: string;
  /** Tool whose response carried the suggestion. */
  suggested_by: string;
  /** Tool names the response suggested. */
  suggested: string[];
  /** Tool the agent actually called next. */
  called: string;
  /** True when `called` is one of `suggested`. */
  followed: boolean;
}

interface PendingSuggestion {
  suggestedBy: string;
  suggested: string[];
}

/** Per-session pending suggestion. Process-scoped: one MCP server per connection. */
const pending = new Map<string, PendingSuggestion>();
/** Buffered observations awaiting flush, keyed by target store cwd. */
const buffered = new Map<string, AdherenceObservation[]>();

function enabled(): boolean {
  const raw = process.env.BRAINCLAW_GUIDANCE_TELEMETRY?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function sessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() || 'no-session';
}

/**
 * Pull suggested tool names out of a built response.
 *
 * Deliberately a SHALLOW scan of the two places affordances actually live —
 * top level (handlers that spread fields into `toolResponse`) and
 * `structuredContent` (facade responses) — plus the per-warning nests. A deep
 * recursive walk would cost more than the signal is worth and would pick up
 * unrelated `next_actions` echoed inside payload data.
 */
export function extractSuggestedTools(response: unknown): string[] {
  if (!response || typeof response !== 'object') return [];
  const tools: string[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry && typeof entry === 'object' && typeof (entry as { tool?: unknown }).tool === 'string') {
        tools.push((entry as { tool: string }).tool);
      }
    }
  };
  const collectWarningNests = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry && typeof entry === 'object') collect((entry as { next_actions?: unknown }).next_actions);
    }
  };

  const top = response as Record<string, unknown>;
  collect(top.next_actions);
  collectWarningNests(top.warning_details);
  const structured = top.structuredContent;
  if (structured && typeof structured === 'object') {
    const inner = structured as Record<string, unknown>;
    collect(inner.next_actions);
    collectWarningNests(inner.warning_details);
  }
  return [...new Set(tools)];
}

/**
 * Observe a tool call against the suggestion left by the previous call.
 *
 * Returns the observation (for tests) or undefined when there was nothing
 * pending. Consuming the pending entry is intentional: one suggestion set is
 * judged exactly once, by the call that immediately follows it.
 */
export function observeToolCall(input: {
  sessionId?: string;
  tool: string;
  cwd: string;
  now?: string;
}): AdherenceObservation | undefined {
  if (!enabled()) return undefined;
  const key = sessionKey(input.sessionId);
  const prior = pending.get(key);
  if (!prior) return undefined;
  pending.delete(key);
  const observation: AdherenceObservation = {
    at: input.now ?? new Date().toISOString(),
    suggested_by: prior.suggestedBy,
    suggested: prior.suggested,
    called: input.tool,
    followed: prior.suggested.includes(input.tool),
  };
  const list = buffered.get(input.cwd) ?? [];
  list.push(observation);
  buffered.set(input.cwd, list);
  if (list.length >= FLUSH_EVERY) flushAdherence(input.cwd);
  return observation;
}

/** Remember what a response suggested, so the next call can be judged. */
export function recordSuggestion(input: {
  sessionId?: string;
  tool: string;
  suggested: string[];
}): void {
  if (!enabled()) return;
  const key = sessionKey(input.sessionId);
  if (input.suggested.length === 0) {
    // No suggestion means nothing to judge — clear rather than leave a stale
    // set that a later call would be measured against unfairly.
    pending.delete(key);
    return;
  }
  pending.set(key, { suggestedBy: input.tool, suggested: input.suggested });
}

function telemetryPath(cwd: string): string {
  return path.join(cwd, MEMORY_DIR, 'coordination', 'runtime', TELEMETRY_FILE);
}

/** Write buffered observations. Best-effort by construction: never throws. */
export function flushAdherence(cwd: string): void {
  const list = buffered.get(cwd);
  if (!list || list.length === 0) return;
  buffered.set(cwd, []);
  try {
    const file = telemetryPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        // Keep the newest half; adherence is a trend, not an archive.
        const kept = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        fs.writeFileSync(file, kept.slice(Math.floor(kept.length / 2)).join('\n') + '\n', 'utf-8');
      }
    } catch { /* absent file — nothing to rotate */ }
    fs.appendFileSync(file, list.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
  } catch {
    /* telemetry must never break a tool call */
  }
}

export interface AdherenceSummary {
  total: number;
  followed: number;
  ignored: number;
  /** followed / total, or undefined when there is no data yet. */
  rate?: number;
  /** Per-emitting-tool breakdown, worst adherence first. */
  by_tool: Array<{ tool: string; total: number; followed: number; rate: number }>;
}

/** Read the recorded observations and summarise. Never throws. */
export function readAdherence(cwd: string): AdherenceSummary {
  let persisted: AdherenceObservation[] = [];
  try {
    persisted = fs.readFileSync(telemetryPath(cwd), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AdherenceObservation);
  } catch {
    /* absent or unreadable — an empty history, not an error */
  }
  // Include anything still buffered so a read right after a call is not stale.
  const observations = [...persisted, ...(buffered.get(cwd) ?? [])];

  const followed = observations.filter((o) => o.followed).length;
  const perTool = new Map<string, { total: number; followed: number }>();
  for (const o of observations) {
    const entry = perTool.get(o.suggested_by) ?? { total: 0, followed: 0 };
    entry.total += 1;
    if (o.followed) entry.followed += 1;
    perTool.set(o.suggested_by, entry);
  }
  return {
    total: observations.length,
    followed,
    ignored: observations.length - followed,
    ...(observations.length > 0 ? { rate: followed / observations.length } : {}),
    by_tool: [...perTool.entries()]
      .map(([tool, v]) => ({ tool, total: v.total, followed: v.followed, rate: v.followed / v.total }))
      .sort((a, b) => a.rate - b.rate),
  };
}

/** Test hook — the maps are process-scoped by design. */
export function __resetAdherenceForTests(): void {
  pending.clear();
  buffered.clear();
}
