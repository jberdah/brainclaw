import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { AGENT_ENV_KEYS } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-first-'));
}

function run(args: string[], cwd: string, envOverrides: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...envOverrides,
  };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  const configPath = path.join(cwd, '.brainclaw', 'config.yaml');
  if (fs.existsSync(configPath)) {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as { current_agent?: string; current_agent_id?: string };
    if (config.current_agent) {
      env.BRAINCLAW_AGENT_NAME = config.current_agent;
      env.BRAINCLAW_AGENT = config.current_agent;
    }
    if (config.current_agent_id) {
      env.BRAINCLAW_AGENT_ID = config.current_agent_id;
    }
  }
  env.USERNAME = 'testuser';
  env.USER = 'testuser';
  env.BRAINCLAW_STORE_BOUNDARY = cwd;
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  Object.assign(env, envOverrides);
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
    env,
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function enableReputation(dir: string): void {
  const configPath = path.join(dir, '.brainclaw', 'config.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
  config.reputation = {
    ...(config.reputation ?? {}),
    enabled: true,
  };
  fs.writeFileSync(configPath, YAML.stringify(config, { lineWidth: 0 }), 'utf-8');
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

function bootstrapCurator(dir: string): void {
  const res = run(['set-trust', 'testuser', '--level', 'curator'], dir);
  assert.equal(res.exitCode, 0, res.stderr);
}

function registerPendingAuthor(dir: string, name: string = 'worker-bot'): string {
  const register = run(['register-agent', name, '--kind', 'agent'], dir);
  assert.equal(register.exitCode, 0, register.stderr);
  const trust = run(['set-trust', name, '--level', 'contributor'], dir);
  assert.equal(trust.exitCode, 0, trust.stderr);
  return name;
}

describe('Agent-first context and reflective ingestion', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('context outputs compact markdown relevant to target', () => {
    run(['decision', 'OAuth migration now goes through auth-gateway', '--tag', 'auth'], dir);
    run(['trap', 'Auth test is flaky on Windows', '--tag', 'auth'], dir);
    run(['constraint', 'Payments module frozen', '--tag', 'payments'], dir);

    const res = run(['context', '--for', 'auth'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('# Agent Context'));
    assert.ok(res.stdout.includes('Project ID: prj_'));
    assert.ok(res.stdout.includes('Agent ID: agt_'));
    assert.ok(res.stdout.includes('Resolved agent: testuser (agt_'));
    assert.ok(res.stdout.includes('Project mode: auto (manual)'));
    assert.ok(res.stdout.includes('auth-gateway'));
  });

  it('context --explain shows ranking reasons in markdown output', () => {
    run(['decision', 'OAuth migration now goes through auth-gateway', '--tag', 'auth'], dir);

    const res = run(['context', '--for', 'auth', '--explain'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('{why:'));
    assert.ok(res.stdout.includes('auth'));
  });

  it('context supports JSON output and profile override', () => {
    run(['decision', 'Use queue worker', '--tag', 'jobs'], dir);

    const res = run(['context', '--profile', 'openclaw', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.match(parsed.project_id, /^prj_[a-f0-9]+$/);
    assert.match(parsed.agent_id, /^agt_[a-f0-9]+$/);
    assert.equal(parsed.profile, 'openclaw');
    assert.equal(parsed.project_mode, 'auto');
    assert.equal(parsed.agent, 'testuser');
    assert.ok(Array.isArray(parsed.selected));
  });

  it('context JSON exposes ranking reasons for selected items', () => {
    run(['decision', 'Auth gateway now handles OAuth', '--tag', 'auth'], dir);

    const res = run(['context', '--for', 'auth', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.selected.length > 0);
    assert.ok(Array.isArray(parsed.selected[0].reasons));
    assert.ok(parsed.selected[0].reasons.some((reason: string) => reason.includes('auth')));
  });

  it('context JSON exposes provenance for runtime notes', () => {
    run(['runtime-note', 'Implicit provenance note', '--tag', 'auth'], dir, { BRAINCLAW_SESSION_ID: 'sess_ctx_1' });

    const res = run(['context', '--for', 'auth', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    const runtimeItem = parsed.selected.find((item: any) => item.section === 'runtime');
    assert.ok(runtimeItem);
    assert.equal(runtimeItem.provenance.actor, 'testuser');
    assert.match(runtimeItem.provenance.actor_id, /^agt_[a-f0-9]+$/);
    assert.match(runtimeItem.provenance.project_id, /^prj_[a-f0-9]+$/);
    assert.equal(runtimeItem.provenance.session_id, 'sess_ctx_1');
  });

  it('context max-chars limits selected payload size', () => {
    run(['decision', 'A very long auth decision that should consume part of the context budget', '--tag', 'auth'], dir);
    run(['trap', 'Another auth-related trap that should be dropped when the character budget is small', '--tag', 'auth'], dir);

    const res = run(['context', '--for', 'auth', '--json', '--max-chars', '120'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.selected.length >= 1);
    assert.ok(parsed.selected.length <= 1);
  });

  it('context supports prompt template output', () => {
    run(['decision', 'Use queue worker', '--tag', 'jobs'], dir);

    const res = run(['context', '--for', 'jobs', '--template'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('```memory-context'));
    assert.ok(res.stdout.includes('items:'));
  });

  it('context JSON exposes mono-agent resume summary when reputation is enabled', () => {
    enableReputation(dir);
    const rResume = run(['reflect', 'Useful proposal', '--type', 'decision'], dir);
    bootstrapCurator(dir);
    run(['accept', extractId(rResume.stdout), '--by', 'testuser'], dir);
    run(['runtime-note', 'Resume-worthy observation', '--plan', 'pln_missing'], dir);

    const res = run(['context', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.resume_summary);
    assert.equal(parsed.resume_summary.agent_name, 'testuser');
    assert.match(parsed.resume_summary.agent_id, /^agt_[a-f0-9]+$/);
    assert.ok(parsed.resume_summary.internal_trust >= 0);
    assert.ok(Array.isArray(parsed.resume_summary.strengths));
    assert.ok(Array.isArray(parsed.resume_summary.cautions));
    assert.ok(Array.isArray(parsed.resume_summary.suggested_focus));
  });

  it('context markdown includes resume summary when reputation is enabled', () => {
    enableReputation(dir);
    const rMd = run(['reflect', 'Useful proposal', '--type', 'decision'], dir);
    bootstrapCurator(dir);
    run(['accept', extractId(rMd.stdout), '--by', 'testuser'], dir);
    run(['runtime-note', 'Resume-worthy observation'], dir);

    const res = run(['context'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Resume summary for testuser:'));
    assert.ok(res.stdout.includes('Internal trust:'));
    assert.ok(res.stdout.includes('Focus:'));
  });

  it('context keeps semantic matches ahead of higher-trust but irrelevant memory', () => {
    enableReputation(dir);
    bootstrapCurator(dir);

    run(['register-agent', 'trusted-bot', '--kind', 'agent', '--set-current'], dir);
    const rSem1 = run(['reflect', 'Legacy queue fallback', '--type', 'decision', '--tag', 'queue'], dir);
    run(['accept', extractId(rSem1.stdout), '--by', 'testuser'], dir);
    const rSem2 = run(['reflect', 'Worker pool tuning', '--type', 'decision', '--tag', 'ops'], dir);
    run(['accept', extractId(rSem2.stdout), '--by', 'testuser'], dir);
    const rSem3 = run(['reflect', 'Retry budget calibration', '--type', 'decision', '--tag', 'ops'], dir);
    run(['accept', extractId(rSem3.stdout), '--by', 'testuser'], dir);

    run(['register-agent', 'novice-bot', '--kind', 'agent', '--set-current'], dir);
    const rSem4 = run(['reflect', 'Auth gateway token validation', '--type', 'decision', '--tag', 'auth'], dir);
    run(['accept', extractId(rSem4.stdout), '--by', 'testuser'], dir);

    const res = run(['context', '--for', 'auth', '--json'], dir);
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.selected[0].text, 'Auth gateway token validation');
    assert.ok(parsed.selected[0].reasons.some((reason: string) => reason.includes('auth')));
  });

  it('context uses bounded trust bonus to break otherwise similar ties', () => {
    enableReputation(dir);
    bootstrapCurator(dir);

    run(['register-agent', 'trusted-bot', '--kind', 'agent', '--set-current'], dir);
    const rTrust1 = run(['reflect', 'Worker stability baseline', '--type', 'decision', '--tag', 'ops'], dir);
    run(['accept', extractId(rTrust1.stdout), '--by', 'testuser'], dir);
    const rTrust2 = run(['reflect', 'Retry stability baseline', '--type', 'decision', '--tag', 'ops'], dir);
    run(['accept', extractId(rTrust2.stdout), '--by', 'testuser'], dir);
    const rTrust3 = run(['reflect', 'Queue worker rollout step trusted', '--type', 'decision', '--tag', 'queue'], dir);
    run(['accept', extractId(rTrust3.stdout), '--by', 'testuser'], dir);

    run(['register-agent', 'novice-bot', '--kind', 'agent', '--set-current'], dir);
    const rTrust4 = run(['reflect', 'Queue worker rollout step novice', '--type', 'decision', '--tag', 'queue'], dir);
    run(['accept', extractId(rTrust4.stdout), '--by', 'testuser'], dir);

    const res = run(['context', '--for', 'queue', '--json'], dir);
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);
    const queueItems = parsed.selected.filter((item: any) => item.text.includes('Queue worker rollout step'));
    assert.equal(queueItems[0].provenance.actor, 'trusted-bot');
    assert.ok(queueItems[0].reasons.some((reason: string) => reason.includes('reputation signal')));
  });

  it('context template includes resume focus when reputation is enabled', () => {
    enableReputation(dir);
    const rTempl = run(['reflect', 'Useful proposal', '--type', 'decision'], dir);
    bootstrapCurator(dir);
    run(['accept', extractId(rTempl.stdout), '--by', 'testuser'], dir);

    const res = run(['context', '--template'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('resume_summary:'));
    assert.ok(res.stdout.includes('suggested_focus:'));
  });

  it('context resolves layered instructions for project and agent scopes', () => {
    const configPath = path.join(dir, '.brainclaw', 'config.yaml');
    const config = fs.readFileSync(configPath, 'utf-8').replace('known: []', 'known:\n  - auth');
    fs.writeFileSync(configPath, config, 'utf-8');

    run(['instruction', 'Always read project memory before edits'], dir);
    run(['instruction', 'Prefer auth gateway conventions', '--layer', 'project', '--project', 'auth'], dir);
    run(['instruction', 'OpenClaw must summarize blockers explicitly', '--layer', 'agent', '--agent', 'openclaw'], dir);

    const res = run(['context', '--for', 'auth/routes.ts', '--agent', 'openclaw'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Instructions:'));
    assert.ok(res.stdout.includes('Always read project memory before edits'));
    assert.ok(res.stdout.includes('Prefer auth gateway conventions'));
    assert.ok(res.stdout.includes('OpenClaw must summarize blockers explicitly'));
  });

  it('context includes current-host machine-local runtime notes and excludes remote hosts by default', () => {
    const register = run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    assert.equal(register.exitCode, 0, register.stderr);
    run(['runtime-note', 'Local npm workaround', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['runtime-note', 'Remote host workaround', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

    const res = run(['context', '--for', 'npm windows', '--json', '--max-items', '20'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);
    const runtimeTexts = parsed.selected.filter((item: any) => item.section === 'runtime').map((item: any) => item.text);
    assert.equal(parsed.current_host, 'host-a');
    assert.ok(runtimeTexts.includes('Local npm workaround'));
    assert.ok(!runtimeTexts.includes('Remote host workaround'));
  });

  it('context can inspect machine-local runtime notes across all hosts explicitly', () => {
    const register = run(['register-agent', 'copilot', '--kind', 'agent'], dir);
    assert.equal(register.exitCode, 0, register.stderr);
    run(['runtime-note', 'Local npm workaround', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['runtime-note', 'Remote host workaround', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

    const res = run(['context', '--for', 'npm windows', '--all-hosts', '--json', '--max-items', '20'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);
    const runtimeTexts = parsed.selected.filter((item: any) => item.section === 'runtime').map((item: any) => item.text);
    assert.equal(parsed.all_hosts, true);
    assert.ok(runtimeTexts.includes('Local npm workaround'));
    assert.ok(runtimeTexts.includes('Remote host workaround'));
  });

  it('context includes visible machine-local traps for the current host', () => {
    run(['trap', 'Windows npm path workaround', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['trap', 'Remote-only trap', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

    const res = run(['context', '--for', 'npm windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Windows npm path workaround'));
    assert.ok(!res.stdout.includes('Remote-only trap'));
  });

  it('doctor reports stale context when visible memory changed after the last read', () => {
    run(['context'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    run(['decision', 'Freshness-changing decision'], dir, { BRAINCLAW_HOST_ID: 'host-a' });

    const res = run(['doctor'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
    assert.ok(res.stdout.includes('stale for this host') || res.stderr.includes('stale for this host'));
  });

  it('context openclaw template defaults to compact format', () => {
    run(['decision', 'Queue policy for autonomous tasks', '--tag', 'openclaw'], dir);

    const res = run(['context', '--profile', 'openclaw', '--template'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('```memory-context'));
    assert.ok(res.stdout.includes('p=openclaw'));
    assert.ok(res.stdout.includes('i:'));
  });

  it('reflect --batch imports runtime events from file', () => {
    const batchPath = path.join(dir, 'batch-events.json');
    const events = [
      {
        id: 'evt_001',
        agent: 'openclaw',
        event_type: 'risk_detected',
        created_at: '2026-03-14T10:00:00Z',
        text: 'Payment retries can duplicate charges',
        tags: ['payments', 'risk'],
      },
      {
        id: 'evt_002',
        agent: 'openclaw',
        event_type: 'observation',
        created_at: '2026-03-14T10:01:00Z',
        text: 'Auth flow now depends on gateway policy v2',
        tags: ['auth'],
      },
    ];

    fs.writeFileSync(batchPath, JSON.stringify(events, null, 2), 'utf-8');

    const res = run(['reflect', '--batch', batchPath], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Created 2 candidate'));

    const candidates = fs
      .readdirSync(path.join(dir, '.brainclaw', 'coordination', 'inbox'))
      .filter((file) => file.endsWith('.json'));
    assert.equal(candidates.length, 2);
  });

  it('adapter-openclaw-import imports events as candidates', () => {
    const batchPath = path.join(dir, 'openclaw-events.json');
    const events = [
      {
        id: 'evt_010',
        agent: 'openclaw',
        event_type: 'observation',
        created_at: '2026-03-14T11:00:00Z',
        text: 'Gateway policy changed',
        tags: ['auth'],
      },
    ];
    fs.writeFileSync(batchPath, JSON.stringify(events, null, 2), 'utf-8');

    const res = run(['adapter-openclaw-import', batchPath], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Created 1 candidate'));
  });

  it('adapter-openclaw-import dry-run previews without creating candidates', () => {
    const batchPath = path.join(dir, 'openclaw-events-dry.json');
    const events = [
      {
        id: 'evt_012',
        agent: 'openclaw',
        event_type: 'risk_detected',
        created_at: '2026-03-14T11:10:00Z',
        text: 'Potential retry storm',
        tags: ['risk'],
      },
    ];
    fs.writeFileSync(batchPath, JSON.stringify(events, null, 2), 'utf-8');

    const res = run(['adapter-openclaw-import', batchPath, '--dry-run'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Dry-run'));
    assert.ok(res.stdout.includes('No candidates were created'));

    const inboxDir = path.join(dir, '.brainclaw', 'coordination', 'inbox');
    if (fs.existsSync(inboxDir)) {
      const candidates = fs
        .readdirSync(inboxDir)
        .filter((file) => file.endsWith('.json'));
      assert.equal(candidates.length, 0);
    } else {
      // No inbox directory is also valid for dry-run mode.
      assert.ok(true);
    }
  });

  it('adapter-openclaw-import supports session mode', () => {
    const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime', 'openclaw');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeEvents = {
      events: [
        {
          id: 'evt_011',
          agent: 'openclaw',
          event_type: 'observation',
          created_at: '2026-03-14T11:05:00Z',
          text: 'Session-specific insight',
          tags: ['session'],
          metadata: { session: 'sess_adapter' },
        },
      ],
    };
    fs.writeFileSync(path.join(runtimeDir, 'openclaw-session.json'), JSON.stringify(runtimeEvents, null, 2), 'utf-8');

    const res = run(['adapter-openclaw-import', '--session', 'sess_adapter'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes("session 'sess_adapter'"));
  });

  it('reflect --session imports runtime events filtered by session id', () => {
    const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime', 'openclaw');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeEvents = {
      events: [
        {
          id: 'evt_003',
          agent: 'openclaw',
          event_type: 'handoff_requested',
          created_at: '2026-03-14T10:02:00Z',
          text: 'Need human validation on refund policy',
          tags: ['refunds'],
          from: 'openclaw',
          to: 'human-review',
          metadata: { session: 'sess_42' },
        },
        {
          id: 'evt_004',
          agent: 'openclaw',
          event_type: 'observation',
          created_at: '2026-03-14T10:03:00Z',
          text: 'Ignored event from another session',
          tags: ['ignore'],
          metadata: { session: 'sess_99' },
        },
      ],
    };

    fs.writeFileSync(path.join(runtimeDir, 'session-events.json'), JSON.stringify(runtimeEvents, null, 2), 'utf-8');

    const res = run(['reflect', '--session', 'sess_42'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes("session 'sess_42'"));

    const inboxFiles = fs
      .readdirSync(path.join(dir, '.brainclaw', 'coordination', 'inbox'))
      .filter((file) => file.endsWith('.json'));
    assert.equal(inboxFiles.length, 1);

    const candidate = JSON.parse(
      fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'inbox', inboxFiles[0]), 'utf-8')
    );
    assert.equal(candidate.type, 'handoff');
    assert.equal(candidate.from, 'openclaw');
    assert.equal(candidate.to, 'human-review');
  });

  it('reflect single mode still works with --type', () => {
    const res = run(['reflect', 'Use canary for rollout', '--type', 'decision'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Candidate created') || res.stdout.includes('Direct write:'));
  });

  it('reflect fails when text and type are missing', () => {
    const res = run(['reflect'], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(res.stderr.includes('requires <text> and --type'));
  });

  it('review supports prioritized mode with SLA metadata', () => {
    const author = registerPendingAuthor(dir);
    run(['reflect', 'Review this handoff first', '--type', 'handoff', '--from', 'a', '--to', 'b', '--author', author], dir);
    run(['reflect', 'General decision item', '--type', 'decision', '--author', author], dir);

    const res = run(['review', '--prioritized'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Priority mode enabled'));
    assert.ok(res.stdout.includes('SLA'));

    const handoffIndex = res.stdout.indexOf('(handoff)');
    const decisionIndex = res.stdout.indexOf('(decision)');
    assert.ok(handoffIndex >= 0);
    assert.ok(decisionIndex >= 0);
    assert.ok(handoffIndex < decisionIndex);
  });

  it('review supports assignee and overdue filters', () => {
    const author = registerPendingAuthor(dir);
    // Backdate first candidate to make it overdue
    const inboxDir = path.join(dir, '.brainclaw', 'coordination', 'inbox');
    const firstPath = path.join(inboxDir, `${extractId(run(['reflect', 'First item', '--type', 'decision', '--tag', 'assignee:alice', '--author', author], dir).stdout)}.json`);
    run(['reflect', 'Second item', '--type', 'decision', '--tag', 'assignee:bob', '--author', author], dir);
    const c1 = JSON.parse(fs.readFileSync(firstPath, 'utf-8'));
    c1.created_at = '2025-01-01T00:00:00Z';
    fs.writeFileSync(firstPath, JSON.stringify(c1, null, 2), 'utf-8');

    const assigneeRes = run(['review', '--assignee', 'alice'], dir);
    assert.equal(assigneeRes.exitCode, 0);
    assert.ok(assigneeRes.stdout.includes('First item'));
    assert.ok(!assigneeRes.stdout.includes('Second item'));

    const overdueRes = run(['review', '--only-overdue'], dir);
    assert.equal(overdueRes.exitCode, 0);
    assert.ok(overdueRes.stdout.includes('First item'));
    assert.ok(!overdueRes.stdout.includes('Second item'));
  });

  it('review supports curator queue and take limit', () => {
    const author = registerPendingAuthor(dir);
    run(['reflect', 'Curator item A', '--type', 'decision', '--tag', 'assignee:curator-a', '--author', author], dir);
    run(['reflect', 'Curator item B', '--type', 'trap', '--tag', 'assignee:curator-a', '--author', author], dir);
    run(['reflect', 'Other curator item', '--type', 'decision', '--tag', 'assignee:curator-b', '--author', author], dir);

    const res = run(['review', '--for-curator', 'curator-a', '--take', '1', '--prioritized'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Showing 1 of 2'));
    assert.ok(res.stdout.includes('Curator item'));
    assert.ok(!res.stdout.includes('Other curator item'));
  });

  it('review --claim assigns candidates atomically and skips conflicting assignees', () => {
    const author = registerPendingAuthor(dir);
    const rClaim1 = run(['reflect', 'Unassigned item', '--type', 'decision', '--author', author], dir);
    const rClaim2 = run(['reflect', 'Already bob item', '--type', 'decision', '--tag', 'assignee:bob', '--author', author], dir);
    const claimId1 = extractId(rClaim1.stdout);
    const claimId2 = extractId(rClaim2.stdout);

    const res = run(['review', '--claim', 'alice', '--take', '2'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes("Claimed 1 candidate(s) for curator 'alice'"));
    assert.ok(res.stdout.includes('Skipped 1 candidate(s)'));

    const c1 = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'inbox', `${claimId1}.json`), 'utf-8'));
    const c2 = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'coordination', 'inbox', `${claimId2}.json`), 'utf-8'));
    assert.ok(c1.tags.includes('assignee:alice'));
    assert.ok(c2.tags.includes('assignee:bob'));
  });

  it('review --claim --json returns claimed and skipped blocks', () => {
    const author = registerPendingAuthor(dir);
    run(['reflect', 'Needs claim', '--type', 'decision', '--author', author], dir);
    run(['reflect', 'Owned by bob', '--type', 'decision', '--tag', 'assignee:bob', '--author', author], dir);

    const res = run(['review', '--claim', 'alice', '--take', '2', '--json'], dir);
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout);

    assert.ok(Array.isArray(parsed.claimed));
    assert.ok(Array.isArray(parsed.skipped));
    assert.equal(parsed.claimed.length, 1);
    assert.equal(parsed.skipped.length, 1);
    assert.equal(parsed.claimed[0].review_assignee, 'alice');
  });

  it('review --json includes SLA fields', () => {
    const author = registerPendingAuthor(dir);
    run(['reflect', 'Decision for JSON review', '--type', 'decision', '--author', author], dir);
    const res = run(['review', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed));
    assert.ok(typeof parsed[0].age_hours === 'number');
    assert.ok(typeof parsed[0].sla_hours === 'number');
    assert.ok(typeof parsed[0].overdue === 'boolean');
  });

  it('accept enforces strict governance for non-curator', () => {
    bootstrapCurator(dir);
    const author = registerPendingAuthor(dir);
    const rGov = run(['reflect', 'Use canary for rollout', '--type', 'decision', '--author', author], dir);
    const cndIdGov = extractId(rGov.stdout);

    run(['register-agent', 'curator-user', '--kind', 'human'], dir);
    run(['set-trust', 'curator-user', '--level', 'curator'], dir);

    const denied = run(['accept', cndIdGov, '--by', 'random-user'], dir);
    assert.notEqual(denied.exitCode, 0);
    assert.ok(denied.stderr.includes('Error:'));

    const allowed = run(['accept', cndIdGov, '--by', 'curator-user'], dir);
    assert.equal(allowed.exitCode, 0);
    assert.ok(allowed.stdout.includes('accepted and archived'));
  });

  it('doctor warns on runtime sessions without task_finished', () => {
    const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime', 'openclaw');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeEvents = {
      events: [
        {
          id: 'evt_020',
          agent: 'openclaw',
          event_type: 'task_started',
          created_at: '2026-03-14T12:00:00Z',
          text: 'Start workflow',
          tags: ['flow'],
          metadata: { session: 'sess_incomplete' },
        },
      ],
    };
    fs.writeFileSync(path.join(runtimeDir, 'doctor-events.json'), JSON.stringify(runtimeEvents, null, 2), 'utf-8');

    const res = run(['doctor'], dir);
    assert.ok(res.stdout.includes("sess_incomplete") || res.stderr.includes("sess_incomplete"));
    assert.ok(res.stdout.includes('Governance review KPI'));
  });

  it('doctor recognizes top-level runtime event session_id metadata', () => {
    const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime', 'openclaw');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const runtimeEvents = {
      events: [
        {
          id: 'evt_021',
          agent: 'openclaw',
          agent_id: 'agt_top_001',
          project_id: 'prj_top_001',
          host_id: 'host-top',
          session_id: 'sess_top_level',
          event_type: 'task_started',
          created_at: '2026-03-14T12:05:00Z',
          text: 'Start workflow with top-level session',
          tags: ['flow'],
        },
      ],
    };
    fs.writeFileSync(path.join(runtimeDir, 'doctor-events-top-level.json'), JSON.stringify(runtimeEvents, null, 2), 'utf-8');

    const res = run(['doctor'], dir);
    assert.ok(res.stdout.includes('sess_top_level') || res.stderr.includes('sess_top_level'));
  });

  it('doctor supports JSON dashboard output', () => {
    run(['reflect', 'JSON dashboard candidate', '--type', 'decision'], dir);
    const res = run(['doctor', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(typeof parsed.ok, 'boolean');
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.checks.some((check: { name: string }) => check.name === 'project_mode'));
    assert.equal(typeof parsed.metrics.pending_candidates, 'number');
    assert.equal(typeof parsed.metrics.review_sla_hours, 'number');
  });

  it('doctor JSON includes prudent reputation metrics when enabled', () => {
    enableReputation(dir);
    const rDoc = run(['reflect', 'JSON dashboard candidate', '--type', 'decision'], dir);
    bootstrapCurator(dir);
    run(['accept', extractId(rDoc.stdout), '--by', 'testuser'], dir);

    const res = run(['doctor', '--json'], dir);
    assert.equal(res.exitCode, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.metrics.reputation_enabled, true);
    assert.equal(typeof parsed.metrics.reputation_tracked_agents, 'number');
    assert.equal(typeof parsed.metrics.reputation_avg_internal_trust, 'number');
  });

  it('doctor warns when multi-project mode has no known projects', () => {
    run(['init', '--force', '-y', '--project-mode', 'multi-project'], dir);
    const res = run(['doctor'], dir);
    assert.ok(res.stdout.includes('no project namespaces are configured yet') || res.stderr.includes('no project namespaces are configured yet'));
  });
});



