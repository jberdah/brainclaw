import { performance } from 'node:perf_hooks';

export interface ScenarioMetrics {
  /** Wall-clock in ms (perf_hooks.performance.now differences). */
  duration_ms: number;
  /** Distinct "brainclaw calls" the scenario performed (session start, context build, …). */
  calls: number;
  /**
   * Total chars of returned payload the agent would have to read.
   * Proxy for token cost — /4 gives an order-of-magnitude token estimate.
   */
  payload_chars: number;
  /** Free-form counters the scenario wants to publish (item counts, hits…). */
  extras?: Record<string, number>;
}

export interface ScenarioResult extends ScenarioMetrics {
  name: string;
  /** Store volume used for this scenario (empty | small | medium | large). */
  volume: string;
  /** Non-fatal diagnostic messages captured during the scenario run. */
  notes: string[];
  /** Millisecond timestamp when the scenario started (Date.now). */
  started_at: string;
  /** True if the scenario ran without throwing. */
  ok: boolean;
  /** Set when ok=false. */
  error?: string;
}

/**
 * Snapshot payload size for an unknown value. Objects → JSON length; strings
 * pass through; nullish → 0. Cheap to compute (single JSON.stringify) and
 * good enough as a proxy for token cost. Uses a replacer to guard against
 * circular refs so a bench never crashes on an accidental cycle.
 */
export function payloadChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    const seen = new WeakSet<object>();
    const s = JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      return v;
    });
    return s?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface RunScenarioContext {
  /** Record a chargeable brainclaw call the agent would issue. */
  addCall(payload?: unknown): void;
  /** Record an ad-hoc counter (e.g., number of results). */
  addExtra(key: string, delta?: number): void;
  /** Attach a short note (visible in the report). */
  note(message: string): void;
}

export type ScenarioFn = (ctx: RunScenarioContext) => Promise<void> | void;

export async function runScenario(
  name: string,
  volume: string,
  fn: ScenarioFn,
): Promise<ScenarioResult> {
  let calls = 0;
  let payload = 0;
  const extras: Record<string, number> = {};
  const notes: string[] = [];
  const ctx: RunScenarioContext = {
    addCall(response?: unknown) {
      calls += 1;
      payload += payloadChars(response);
    },
    addExtra(key: string, delta = 1) {
      extras[key] = (extras[key] ?? 0) + delta;
    },
    note(message: string) {
      notes.push(message);
    },
  };
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  try {
    await fn(ctx);
    return {
      name,
      volume,
      started_at: startedAt,
      duration_ms: Math.round(performance.now() - t0),
      calls,
      payload_chars: payload,
      extras: Object.keys(extras).length ? extras : undefined,
      notes,
      ok: true,
    };
  } catch (err) {
    return {
      name,
      volume,
      started_at: startedAt,
      duration_ms: Math.round(performance.now() - t0),
      calls,
      payload_chars: payload,
      extras: Object.keys(extras).length ? extras : undefined,
      notes,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
