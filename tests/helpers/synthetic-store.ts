import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFastStore } from './fast-store.js';
import { isolateAgentEnv } from './workspace.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import type { AgentIdentityDocument, Claim, Handoff, PlanItem, State } from '../../src/core/schema.js';

/**
 * Volumes calibrated on the real store measured on pln#578 (2026-06 snapshot):
 * medium is the current live store shape; small/large bracket it for regression
 * sensitivity. Values are deliberately conservative — the bench is meant to
 * catch >20% drift, not micro-benchmarks. The seed makes every run identical.
 */
export const SYNTHETIC_STORE_VOLUMES = {
  empty:  { plans:   0, handoffs:    0, claims:   0 },
  small:  { plans:  50, handoffs:  100, claims:  75 },
  medium: { plans: 200, handoffs:  500, claims: 450 },
  large: { plans: 500, handoffs: 1500, claims: 900 },
} as const;

export type SyntheticVolume = keyof typeof SYNTHETIC_STORE_VOLUMES;

export interface SyntheticStoreOptions {
  volume: SyntheticVolume;
  seed?: number;
  isolateEnv?: boolean;
  projectName?: string;
  agentName?: string;
}

export interface SyntheticStore {
  cwd: string;
  fakeHome?: string;
  volume: SyntheticVolume;
  counts: { plans: number; handoffs: number; claims: number };
  cleanup: () => void;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseTimestamp(): number {
  return Date.UTC(2026, 0, 1, 0, 0, 0);
}

function isoAt(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

const SAMPLE_SCOPES = [
  'src/core/context.ts', 'src/core/state.ts', 'src/core/claims.ts',
  'src/commands/mcp.ts', 'src/commands/work.ts', 'src/core/schema.ts',
  'src/core/code-map/backend.ts', 'src/core/dispatcher.ts',
  'tests/helpers/fast-store.ts', 'scripts/emit-site-facts.mjs',
];

const SAMPLE_AGENTS = ['claude-code', 'codex', 'github-copilot'];
const SAMPLE_PRIORITIES = ['low', 'medium', 'high', 'medium', 'medium'] as const;
const SAMPLE_TYPES = ['feat', 'fix', 'chore', 'spike', 'doc'] as const;

function pick<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function makePlan(i: number, base: number, rand: () => number): PlanItem {
  const status = i % 7 === 0 ? 'done' : i % 5 === 0 ? 'in_progress' : 'todo';
  const created = isoAt(base, i * 60_000);
  return {
    id: `plan_${String(i).padStart(6, '0')}`,
    short_label: `pln#${i}`,
    text: `Synthetic plan ${i} — fixture entry for bench harness`,
    type: pick(SAMPLE_TYPES, rand),
    created_at: created,
    updated_at: created,
    author: pick(SAMPLE_AGENTS, rand),
    status,
    priority: pick(SAMPLE_PRIORITIES, rand),
    tags: ['synthetic', `bucket-${i % 4}`],
    depends_on: [],
  };
}

function makeHandoff(i: number, base: number, rand: () => number): Handoff {
  const created = isoAt(base, i * 30_000);
  const from = pick(SAMPLE_AGENTS, rand);
  let to = pick(SAMPLE_AGENTS, rand);
  if (to === from) to = SAMPLE_AGENTS[(SAMPLE_AGENTS.indexOf(from) + 1) % SAMPLE_AGENTS.length]!;
  return {
    id: `handoff_${String(i).padStart(6, '0')}`,
    short_label: `hnd#${i}`,
    from,
    to,
    text: `Synthetic handoff ${i} — pretend cross-agent brief carrying a scope and a short note about progress.`,
    created_at: created,
    author: from,
    status: i % 5 === 0 ? 'accepted' : 'open',
    tags: ['synthetic'],
    related_paths: [pick(SAMPLE_SCOPES, rand)],
  };
}

function makeClaim(i: number, base: number, rand: () => number): Claim {
  const created = isoAt(base, i * 45_000);
  const scope = pick(SAMPLE_SCOPES, rand);
  return {
    id: `clm_${String(i).padStart(8, '0')}`,
    agent: pick(SAMPLE_AGENTS, rand),
    scope,
    description: `Synthetic claim ${i} covering ${scope}`,
    created_at: created,
    status: i % 3 === 0 ? 'released' : 'active',
    released_at: i % 3 === 0 ? created : undefined,
  };
}

function writeStateAndDirs(cwd: string, plans: PlanItem[], handoffs: Handoff[]): void {
  const plansDir = path.join(cwd, '.brainclaw', 'coordination', 'plans');
  const handoffsDir = path.join(cwd, '.brainclaw', 'coordination', 'handoffs');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(handoffsDir, { recursive: true });
  for (const p of plans) {
    fs.writeFileSync(path.join(plansDir, `${p.id}.json`), JSON.stringify(p, null, 2), 'utf8');
  }
  for (const h of handoffs) {
    fs.writeFileSync(path.join(handoffsDir, `${h.id}.json`), JSON.stringify(h, null, 2), 'utf8');
  }
  const state: State = {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: handoffs,
    plan_items: plans,
  };
  const statePath = path.join(cwd, '.brainclaw', 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function writeClaims(cwd: string, claims: Claim[]): void {
  const claimsDir = path.join(cwd, '.brainclaw', 'coordination', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  for (const c of claims) {
    fs.writeFileSync(path.join(claimsDir, `${c.id}.json`), JSON.stringify(c, null, 2), 'utf8');
  }
}

/**
 * Create a calibrated, deterministic .brainclaw store in a fresh tmp dir.
 * Skips security scans and event log writes — this is a benchmark fixture,
 * not a functional workspace. Every run at the same seed produces the same
 * bytes on disk, so wall-clock deltas are attributable to code, not fixture.
 */
export function createSyntheticStore(options: SyntheticStoreOptions): SyntheticStore {
  const volume = options.volume;
  const counts = SYNTHETIC_STORE_VOLUMES[volume];
  const seed = options.seed ?? 42;
  const rand = mulberry32(seed);
  const base = baseTimestamp();
  const agentName = options.agentName ?? 'bench-agent';
  const agentId = `agt_bench_${volume}_${seed}`;

  const envIsolation = options.isolateEnv !== false ? isolateAgentEnv() : undefined;
  const fakeHome = envIsolation?.fakeHome;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bclaw-bench-${volume}-`));
  if (envIsolation) process.env.BRAINCLAW_SESSION_ID = `ses_bench_${volume}_${seed}`;

  // Realistic fixture: a fresh brainclaw store lives in a git repo. Without
  // this, session-start's three `git rev-parse` calls each emit a "not a git
  // repository" line to stderr on every run, polluting CI logs. The init is
  // ~15 ms and stays in the fixture noise floor.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: new Date(base).toISOString(),
    GIT_COMMITTER_DATE: new Date(base).toISOString(),
  };
  const gitOpts = { cwd, stdio: 'ignore' as const, env: gitEnv };
  execFileSync('git', ['init', '--quiet'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'bench@local'], gitOpts);
  execFileSync('git', ['config', 'user.name', 'bench'], gitOpts);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'bench-fixture', '--quiet'], gitOpts);

  createFastStore({
    cwd,
    projectName: options.projectName ?? `bench-${volume}`,
    projectId: `prj_bench_${volume}`,
    agentName,
    agentId,
  });
  const agentIdentity: AgentIdentityDocument = {
    schema_version: 2,
    version: 1,
    agent_id: agentId,
    agent_name: agentName,
    created_at: isoAt(base, seed),
    kind: 'agent',
    trust_level: 'contributor',
    capabilities: [],
  };
  saveAgentIdentity(agentIdentity, cwd);

  const plans: PlanItem[] = [];
  const handoffs: Handoff[] = [];
  const claims: Claim[] = [];
  for (let i = 0; i < counts.plans; i++) plans.push(makePlan(i, base, rand));
  for (let i = 0; i < counts.handoffs; i++) handoffs.push(makeHandoff(i, base, rand));
  for (let i = 0; i < counts.claims; i++) claims.push(makeClaim(i, base, rand));

  writeStateAndDirs(cwd, plans, handoffs);
  writeClaims(cwd, claims);

  return {
    cwd,
    fakeHome,
    volume,
    counts,
    cleanup: () => {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
      envIsolation?.restore();
    },
  };
}
