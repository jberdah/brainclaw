import fs from 'fs';
import path from 'path';
import { memoryDir } from './io.js';

export interface CodevResponseMetric {
  thread_id: string;
  round: number;
  persona: string;
  agent_name: string;
  dispatched_at: string;
  responded_at: string;
  duration_ms: number;
}

function sanitizeForPath(slug: string): string {
  return slug.replace(/[<>:"/\\|?*]/g, '_');
}

export function metricsPath(threadSlug: string, cwd?: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'ideation', sanitizeForPath(threadSlug), 'metrics.jsonl');
}

export function recordResponse(threadSlug: string, metric: CodevResponseMetric, cwd?: string): void {
  const file = metricsPath(threadSlug, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(metric)}\n`, 'utf8');
}

function isMetric(v: unknown): v is CodevResponseMetric {
  const m = v as Record<string, unknown>;
  return !!m && typeof m.thread_id === 'string' && typeof m.round === 'number' &&
    typeof m.persona === 'string' && typeof m.agent_name === 'string' &&
    typeof m.dispatched_at === 'string' && typeof m.responded_at === 'string' &&
    typeof m.duration_ms === 'number';
}

export function loadMetrics(threadSlug: string, cwd?: string): CodevResponseMetric[] {
  try {
    const data = fs.readFileSync(metricsPath(threadSlug, cwd), 'utf8');
    const out: CodevResponseMetric[] = [];
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isMetric(parsed)) out.push(parsed);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export interface MetricsSummary {
  avg_ms: number;
  p95_ms: number;
  by_agent: Record<string, { avg_ms: number; count: number }>;
}

export interface MetricsByRound {
  round: number;
  avg_ms: number;
  p95_ms: number;
  by_agent: Record<string, { avg_ms: number; count: number }>;
  count: number;
}

function computeSummary(entries: CodevResponseMetric[]): MetricsSummary {
  if (!entries.length) return { avg_ms: 0, p95_ms: 0, by_agent: {} };
  const durations = entries.map((m) => m.duration_ms).sort((a, b) => a - b);
  const avg_ms = durations.reduce((s, d) => s + d, 0) / durations.length;
  const p95_ms = durations[Math.ceil(0.95 * durations.length) - 1];
  const sums: Record<string, { sum: number; count: number }> = {};
  for (const m of entries) {
    const entry = sums[m.agent_name] ?? { sum: 0, count: 0 };
    entry.sum += m.duration_ms;
    entry.count += 1;
    sums[m.agent_name] = entry;
  }
  const by_agent: Record<string, { avg_ms: number; count: number }> = {};
  for (const [agent, v] of Object.entries(sums)) by_agent[agent] = { avg_ms: v.sum / v.count, count: v.count };
  return { avg_ms, p95_ms, by_agent };
}

export function summarizeMetrics(threadSlug: string, cwd?: string): MetricsSummary {
  return computeSummary(loadMetrics(threadSlug, cwd));
}

export function summarizeMetricsByRound(threadSlug: string, cwd?: string): MetricsByRound[] {
  const metrics = loadMetrics(threadSlug, cwd);
  const byRound: Record<number, CodevResponseMetric[]> = {};
  for (const m of metrics) {
    (byRound[m.round] ??= []).push(m);
  }
  return Object.entries(byRound)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([round, entries]) => ({
      round: Number(round),
      ...computeSummary(entries),
      count: entries.length,
    }));
}
