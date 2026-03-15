import fs from 'node:fs';
import path from 'node:path';
import { listArchivedCandidates } from './candidates.js';
import { loadConfig } from './config.js';
import { memoryDir } from './io.js';
import { withLock } from './lock.js';

const OVERRIDES_FILE = '.circuit-breaker-overrides.json';

function overridesPath(cwd?: string): string {
  return path.join(memoryDir(cwd), OVERRIDES_FILE);
}

function readOverrides(cwd?: string): Record<string, string> {
  const fp = overridesPath(cwd);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Record a manual reset for a given agent key (resets the rolling window for that agent). */
export function resetCircuitBreaker(agentKey: string, cwd?: string): void {
  const fp = overridesPath(cwd);
  withLock(fp, () => {
    const overrides = readOverrides(cwd);
    overrides[agentKey.trim().toLowerCase()] = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(overrides, null, 2), 'utf-8');
  });
}

export interface CircuitBreakerStatus {
  tripped: boolean;
  agent_key: string;
  rejection_count: number;
  threshold: number;
  window_days: number;
  window_start: string;
}

export interface CircuitBreakerSnapshot {
  checked_at: string;
  window_days: number;
  threshold: number;
  tripped_agents: CircuitBreakerStatus[];
  clear_agents: CircuitBreakerStatus[];
}

/**
 * Check circuit-breaker state for a single agent.
 * Counts accepted rejections in the rolling window and compares to threshold.
 */
export function checkCircuitBreaker(
  agentNameOrId: string,
  cwd?: string,
): CircuitBreakerStatus {
  const config = loadConfig(cwd);
  const threshold = config.reflective_memory?.circuit_breaker_threshold ?? 5;
  const windowDays = config.reflective_memory?.circuit_breaker_window_days ?? 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const key = agentNameOrId.trim().toLowerCase();

  // Honour manual reset: if a reset was recorded more recently than the window start, use it
  const overrides = readOverrides(cwd);
  const resetAt = overrides[key] ? new Date(overrides[key]!) : null;
  const windowStart = resetAt
    ? new Date(Math.max(Date.now() - windowMs, resetAt.getTime()))
    : new Date(Date.now() - windowMs);

  const rejected = listArchivedCandidates('rejected', cwd);

  const recentRejections = rejected.filter((c) => {
    const matchesAgent =
      (c.author_id?.trim().toLowerCase() === key) ||
      (c.author.trim().toLowerCase() === key);
    if (!matchesAgent) return false;
    const resolvedAt = c.resolved_at ?? c.created_at;
    return new Date(resolvedAt) >= windowStart;
  });

  return {
    tripped: recentRejections.length >= threshold,
    agent_key: key,
    rejection_count: recentRejections.length,
    threshold,
    window_days: windowDays,
    window_start: windowStart.toISOString(),
  };
}

/**
 * Build a snapshot of circuit-breaker state for all agents that have
 * any recent rejection activity. Agents with no activity are omitted.
 */
export function buildCircuitBreakerSnapshot(cwd?: string): CircuitBreakerSnapshot {
  const config = loadConfig(cwd);
  const threshold = config.reflective_memory?.circuit_breaker_threshold ?? 5;
  const windowDays = config.reflective_memory?.circuit_breaker_window_days ?? 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const overrides = readOverrides(cwd);

  const rejected = listArchivedCandidates('rejected', cwd);
  const agentCounts = new Map<string, { name: string; id?: string; count: number; windowStart: Date }>();

  for (const c of rejected) {
    const key = (c.author_id?.trim().toLowerCase() ?? c.author.trim().toLowerCase());
    const resetAt = overrides[key] ? new Date(overrides[key]!) : null;
    const windowStart = resetAt
      ? new Date(Math.max(Date.now() - windowMs, resetAt.getTime()))
      : new Date(Date.now() - windowMs);

    const resolvedAt = c.resolved_at ?? c.created_at;
    if (new Date(resolvedAt) < windowStart) continue;

    const existing = agentCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      agentCounts.set(key, { name: c.author, id: c.author_id, count: 1, windowStart });
    }
  }

  const tripped: CircuitBreakerStatus[] = [];
  const clear: CircuitBreakerStatus[] = [];

  for (const [key, data] of agentCounts.entries()) {
    const status: CircuitBreakerStatus = {
      tripped: data.count >= threshold,
      agent_key: key,
      rejection_count: data.count,
      threshold,
      window_days: windowDays,
      window_start: data.windowStart.toISOString(),
    };
    if (status.tripped) {
      tripped.push(status);
    } else {
      clear.push(status);
    }
  }

  return {
    checked_at: new Date().toISOString(),
    window_days: windowDays,
    threshold,
    tripped_agents: tripped,
    clear_agents: clear,
  };
}
