import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-collab-'));
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

function run(args: string[], cwd: string, envOverrides: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
    env: { ...process.env, USERNAME: 'testuser', USER: 'testuser', ...envOverrides },
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

describe('Git-backed Collaboration (Phase 2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('claim', () => {
    it('creates a work claim', () => {
      const res = run(['claim', 'Working on auth refactor', '--agent', 'copilot', '--scope', 'src/auth/'], dir);
      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /\[clm_[a-f0-9]+\]/);
      assert.ok(res.stdout.includes('Claim created'));

      const claimsDir = path.join(dir, '.brainclaw', 'claims');
      const files = fs.readdirSync(claimsDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);

      const claim = JSON.parse(fs.readFileSync(path.join(claimsDir, files[0]), 'utf-8'));
      assert.equal(claim.agent, 'copilot');
      assert.match(claim.agent_id, /^agt_[a-f0-9]+$/);
      assert.equal(claim.scope, 'src/auth/');
      assert.equal(claim.status, 'active');
    });

    it('uses the configured current agent when --agent is omitted', () => {
      const res = run(['claim', 'Current agent claim', '--scope', 'src/current/'], dir, { BRAINCLAW_SESSION_ID: 'sess_claim_1' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('testuser → src/current/'));

      const [clm2File] = fs.readdirSync(path.join(dir, '.brainclaw', 'claims')).filter(f => f.endsWith('.json'));
      const claim = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'claims', clm2File), 'utf-8'));
      assert.equal(claim.agent, 'testuser');
      assert.match(claim.agent_id, /^agt_[a-f0-9]+$/);
      assert.match(claim.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(claim.host_id, os.hostname().toLowerCase());
      assert.equal(claim.session_id, 'sess_claim_1');
    });

    it('warns on overlapping scope claims', () => {
      run(['claim', 'First claim', '--agent', 'copilot', '--scope', 'src/auth/'], dir);
      const res = run(['claim', 'Second claim', '--agent', 'claude', '--scope', 'src/auth/'], dir);
      assert.equal(res.exitCode, 0); // advisory, not blocking
      assert.ok(res.stderr.includes('Active claim') || res.stdout.includes('Active claim'));
    });

    it('increments claim IDs', () => {
      run(['claim', 'First', '--agent', 'a', '--scope', 'x'], dir);
      const res = run(['claim', 'Second', '--agent', 'b', '--scope', 'y'], dir);
      assert.match(res.stdout, /\[clm_[a-f0-9]+\]/);
    });

    it('links a claim to a plan and updates the plan assignee/status', () => {
      const planRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
      const planId = extractId(planRes.stdout);
      const res = run(['claim', 'Taking auth rollout', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', planId], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes(`plan ${planId}`));

      const [clmFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'claims')).filter(f => f.endsWith('.json'));
      const claim = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'claims', clmFile), 'utf-8'));
      assert.equal(claim.plan_id, planId);
      assert.equal(claim.project, 'auth');

      const [plnFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'plans')).filter(f => f.endsWith('.json'));
      const plan = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'plans', plnFile), 'utf-8'));
      assert.equal(plan.assignee, 'copilot');
      assert.equal(plan.status, 'in_progress');
    });
  });

  describe('list-claims', () => {
    it('shows active claims', () => {
      run(['claim', 'Auth work', '--agent', 'copilot', '--scope', 'src/auth/'], dir);
      run(['claim', 'DB work', '--agent', 'claude', '--scope', 'src/db/'], dir);
      const res = run(['list-claims'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('2 active'));
    });

    it('outputs JSON', () => {
      run(['claim', 'Test', '--agent', 'a', '--scope', 'x'], dir);
      const res = run(['list-claims', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.length, 1);
    });

    it('shows empty message', () => {
      const res = run(['list-claims'], dir);
      assert.ok(res.stdout.includes('No active'));
    });

    it('with --all shows released claims too', () => {
      const claimRes = run(['claim', 'Work', '--agent', 'a', '--scope', 'x'], dir);
      run(['release-claim', extractId(claimRes.stdout)], dir);
      const res = run(['list-claims', '--all'], dir);
      assert.ok(res.stdout.includes('1 claim'));
      assert.ok(res.stdout.includes('released'));
    });

    it('filters claims by plan and agent', () => {
      const planRes2 = run(['plan', 'Auth rollout', '--project', 'auth'], dir);
      const pln2Id = extractId(planRes2.stdout);
      run(['claim', 'Auth work', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', pln2Id], dir);
      run(['claim', 'DB work', '--agent', 'claude', '--scope', 'src/db/'], dir);
      const res = run(['list-claims', '--plan', pln2Id, '--agent', 'copilot'], dir);
      assert.ok(res.stdout.includes('Auth work'));
      assert.ok(!res.stdout.includes('DB work'));
    });
  });

  describe('release-claim', () => {
    it('releases an active claim', () => {
      run(['claim', 'Work', '--agent', 'copilot', '--scope', 'src/'], dir);
      const [clmFile3] = fs.readdirSync(path.join(dir, '.brainclaw', 'claims')).filter(f => f.endsWith('.json'));
      const clmId3 = clmFile3.replace('.json', '');
      const res = run(['release-claim', clmId3], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('released'));

      const claim = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'claims', clmFile3), 'utf-8'));
      assert.equal(claim.status, 'released');
      assert.ok(claim.released_at);
    });

    it('updates linked plan when releasing a claim', () => {
      const planRes3 = run(['plan', 'Release linked claim flow', '--project', 'auth'], dir);
      const pln3Id = extractId(planRes3.stdout);
      const claimRes3 = run(['claim', 'Own flow', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', pln3Id], dir);
      const clm3Id = extractId(claimRes3.stdout);

      const res = run(['release-claim', clm3Id, '--plan-status', 'done'], dir);
      assert.equal(res.exitCode, 0);

      const [plnFile3] = fs.readdirSync(path.join(dir, '.brainclaw', 'plans')).filter(f => f.endsWith('.json'));
      const plan = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'plans', plnFile3), 'utf-8'));
      assert.equal(plan.status, 'done');
      assert.equal(plan.assignee, undefined);
    });

    it('fails for non-existent claim', () => {
      const res = run(['release-claim', 'clm_999'], dir);
      assert.notEqual(res.exitCode, 0);
    });
  });

  describe('runtime-note', () => {
    it('creates a runtime note per agent', () => {
      const res = run(['runtime-note', 'Started processing batch', '--agent', 'codex', '--tag', 'batch'], dir);
      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /\[rtn_[a-f0-9]+\]/);

      const noteDir = path.join(dir, '.brainclaw', 'runtime', 'codex');
      assert.ok(fs.existsSync(noteDir));
      const files = fs.readdirSync(noteDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);

      const note = JSON.parse(fs.readFileSync(path.join(noteDir, files[0]), 'utf-8'));
      assert.equal(note.agent, 'codex');
      assert.match(note.agent_id, /^agt_[a-f0-9]+$/);
      assert.deepEqual(note.tags, ['batch']);
    });

    it('uses the configured current agent when --agent is omitted', () => {
      const res = run(['runtime-note', 'Implicit current-agent note'], dir, { BRAINCLAW_SESSION_ID: 'sess_note_1' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('(testuser, shared)'));

      const [rtnFile2] = fs.readdirSync(path.join(dir, '.brainclaw', 'runtime', 'testuser')).filter(f => f.endsWith('.json'));
      const note = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'runtime', 'testuser', rtnFile2), 'utf-8'));
      assert.equal(note.agent, 'testuser');
      assert.match(note.agent_id, /^agt_[a-f0-9]+$/);
      assert.match(note.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(note.host_id, os.hostname().toLowerCase());
      assert.equal(note.session_id, 'sess_note_1');
    });

    it('stores notes per agent in separate dirs', () => {
      run(['runtime-note', 'Note A', '--agent', 'copilot'], dir);
      run(['runtime-note', 'Note B', '--agent', 'claude'], dir);

      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'runtime', 'copilot')));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'runtime', 'claude')));
    });

    it('links runtime notes to a plan', () => {
      const planRes4 = run(['plan', 'Track runtime execution', '--project', 'auth'], dir);
      const pln4Id = extractId(planRes4.stdout);
      run(['runtime-note', 'Started auth work', '--agent', 'copilot', '--plan', pln4Id], dir);

      const [rtnFile4] = fs.readdirSync(path.join(dir, '.brainclaw', 'runtime', 'copilot')).filter(f => f.endsWith('.json'));
      const note = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'runtime', 'copilot', rtnFile4), 'utf-8'));
      assert.equal(note.plan_id, pln4Id);
      assert.equal(note.project, 'auth');
    });

    it('stores machine-local runtime notes under the current host', () => {
      run(['runtime-note', 'Machine fix', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });

      const hostRtnDir = path.join(dir, '.brainclaw', 'runtime-hosts', 'host-a', 'copilot');
      const [rtnHostFile] = fs.readdirSync(hostRtnDir).filter(f => f.endsWith('.json'));
      const notePath = path.join(hostRtnDir, rtnHostFile);
      assert.ok(fs.existsSync(notePath));
      const note = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
      assert.equal(note.visibility, 'machine');
      assert.equal(note.host_id, 'host-a');
    });

    it('stores machine-local traps outside canonical shared traps', () => {
      run(['trap', 'Windows npm path workaround', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });

      const hostTrapDir = path.join(dir, '.brainclaw', 'traps-hosts', 'host-a');
      const localTrapFiles = fs.readdirSync(hostTrapDir).filter(f => f.endsWith('.json'));
      assert.equal(localTrapFiles.length, 1);
      const sharedTrapsDir = path.join(dir, '.brainclaw', 'traps');
      const sharedTrapFiles = fs.existsSync(sharedTrapsDir) ? fs.readdirSync(sharedTrapsDir).filter(f => f.endsWith('.json')) : [];
      assert.equal(sharedTrapFiles.length, 0);
    });
  });

  describe('runtime-status', () => {
    it('shows notes grouped by agent', () => {
      run(['runtime-note', 'Note A', '--agent', 'copilot'], dir);
      run(['runtime-note', 'Note B', '--agent', 'copilot'], dir);
      run(['runtime-note', 'Note C', '--agent', 'claude'], dir);
      const res = run(['runtime-status'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('3 runtime note'));
      assert.ok(res.stdout.includes('2 agent'));
      assert.ok(res.stdout.includes('copilot'));
      assert.ok(res.stdout.includes('claude'));
    });

    it('filters by agent', () => {
      run(['runtime-note', 'Note A', '--agent', 'copilot'], dir);
      run(['runtime-note', 'Note B', '--agent', 'claude'], dir);
      const res = run(['runtime-status', '--agent', 'copilot'], dir);
      assert.ok(res.stdout.includes('1 runtime note'));
      assert.ok(!res.stdout.includes('claude'));
    });

    it('outputs JSON', () => {
      run(['runtime-note', 'Test', '--agent', 'a'], dir);
      const res = run(['runtime-status', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.length, 1);
    });

    it('shows empty message', () => {
      const res = run(['runtime-status'], dir);
      assert.ok(res.stdout.includes('No runtime'));
    });

    it('filters by plan', () => {
      const planRes5 = run(['plan', 'Track runtime execution', '--project', 'auth'], dir);
      const pln5Id = extractId(planRes5.stdout);
      run(['runtime-note', 'Auth note', '--agent', 'copilot', '--plan', pln5Id], dir);
      run(['runtime-note', 'Unlinked note', '--agent', 'copilot'], dir);

      const res = run(['runtime-status', '--plan', pln5Id], dir);
      assert.ok(res.stdout.includes('Auth note'));
      assert.ok(!res.stdout.includes('Unlinked note'));
    });

    it('shows only current-host machine-local notes by default', () => {
      run(['runtime-note', 'Host A note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      run(['runtime-note', 'Host B note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

      const res = run(['runtime-status'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.ok(res.stdout.includes('Host A note'));
      assert.ok(!res.stdout.includes('Host B note'));
      assert.ok(res.stdout.includes('host=host-a'));
    });

    it('can inspect machine-local notes across all hosts explicitly', () => {
      run(['runtime-note', 'Host A note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      run(['runtime-note', 'Host B note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-b' });

      const res = run(['runtime-status', '--visibility', 'machine', '--all-hosts'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.ok(res.stdout.includes('Host A note'));
      assert.ok(res.stdout.includes('Host B note'));
      assert.ok(res.stdout.includes('host=all'));
    });
  });

  describe('agent-board', () => {
    it('shows linked plans, claims, runtime notes, handoffs, and instructions', () => {
      run(['instruction', 'Read auth memory first', '--layer', 'project', '--project', 'auth'], dir);
      const boardPlanRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
      const boardPlanId = extractId(boardPlanRes.stdout);
      run(['claim', 'Taking auth rollout', '--agent', 'copilot', '--scope', 'src/auth/', '--plan', boardPlanId], dir);
      run(['runtime-note', 'Started auth rollout', '--agent', 'copilot', '--plan', boardPlanId], dir);
      run(['handoff', '--from', 'copilot', '--to', 'claude', '--plan', boardPlanId, 'Review auth patch', '--tag', 'auth'], dir);

      const res = run(['agent-board', '--agent', 'copilot', '--project', 'auth'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Agent board for copilot (auth)'));
      assert.ok(res.stdout.includes('Own auth rollout'));
      assert.ok(res.stdout.includes('Started auth rollout'));
      assert.ok(res.stdout.includes('Read auth memory first'));
    });

    it('defaults to the configured current agent when --agent is omitted', () => {
      run(['register-agent', 'copilot', '--kind', 'agent', '--set-current'], dir);
      run(['instruction', 'Copilot must check auth handoffs', '--layer', 'agent'], dir);
      const defaultBoardPlanRes = run(['plan', 'Own auth rollout', '--project', 'auth'], dir);
      const defaultBoardPlanId = extractId(defaultBoardPlanRes.stdout);
      run(['claim', 'Taking auth rollout', '--scope', 'src/auth/'], dir);

      const res = run(['agent-board', '--project', 'auth'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Agent board for copilot (auth)'));
      assert.ok(res.stdout.includes('Copilot must check auth handoffs'));
      assert.ok(res.stdout.includes('copilot -> src/auth/'));
    });

    it('can include bounded reputation in board JSON when explicitly requested', () => {
      enableReputation(dir);
      run(['set-trust', 'testuser', '--level', 'curator'], dir);
      run(['register-agent', 'copilot', '--kind', 'agent', '--set-current'], dir);
      const reflectBoardRes = run(['reflect', 'Copilot useful proposal', '--type', 'decision'], dir);
      const cndBoardId = extractId(reflectBoardRes.stdout);
      run(['accept', cndBoardId, '--by', 'testuser'], dir);

      const res = run(['agent-board', '--agent', 'copilot', '--json', '--with-reputation'], dir);
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.stdout);
      assert.ok(parsed.reputation_summary);
      assert.equal(parsed.reputation_summary.enabled, true);
      assert.ok(parsed.agent_reputation);
      assert.equal(parsed.agent_reputation.agent_name, 'copilot');
      assert.equal(typeof parsed.agent_reputation.internal_trust, 'number');
    });
  });

  describe('sync', () => {
    it('shows memory summary without git', () => {
      run(['decision', 'Test decision'], dir);
      run(['reflect', 'Candidate', '--type', 'trap'], dir);
      run(['claim', 'Work', '--agent', 'a', '--scope', 'x'], dir);
      run(['runtime-note', 'Note', '--agent', 'copilot'], dir);

      const res = run(['sync'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Memory sync summary'));
      assert.ok(res.stdout.includes('1 decisions'));
      assert.ok(res.stdout.includes('Pending candidates: 1'));
      assert.ok(res.stdout.includes('Active claims: 1'));
      assert.ok(res.stdout.includes('Runtime notes: 1'));
    });

    it('creates a git commit with --commit', () => {
      // Initialize a git repo in the temp dir
      spawnSync('git', ['init'], { cwd: dir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: dir });

      run(['decision', 'New decision'], dir);

      const res = run(['sync', '--commit', '--message', 'test sync commit'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Committed'));
      assert.ok(res.stdout.includes('not pushed'));

      // Verify the commit exists
      const log = spawnSync('git', ['log', '--oneline', '-1'], { cwd: dir, encoding: 'utf-8' });
      assert.ok(log.stdout.includes('test sync commit'));
    });

    it('supports summary-only mode without git checks', () => {
      run(['decision', 'Summary only decision'], dir);
      const res = run(['sync', '--summary-only'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Summary-only mode enabled'));
      assert.ok(res.stdout.includes('skipping git status and commit checks'));
    });

    it('supports scope option for targeted sync', () => {
      run(['runtime-note', 'Scoped runtime note', '--agent', 'copilot'], dir);
      const res = run(['sync', '--scope', 'runtime', '--summary-only'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Sync scope: .brainclaw/runtime/'));
    });

    it('keeps machine-local runtime outside the default sync scope', () => {
      run(['runtime-note', 'Shared note', '--agent', 'copilot'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      run(['runtime-note', 'Machine note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      run(['trap', 'Machine trap', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-a' });

      const res = run(['sync', '--summary-only'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.ok(res.stdout.includes('Runtime notes: 1 shared, 1 machine-local'));
      assert.ok(res.stdout.includes('Local traps: 1 machine-local'));
      assert.ok(!res.stdout.includes('.brainclaw/runtime-hosts/'));
    });
  });

  describe('doctor with collaboration features', () => {
    it('reports claims and runtime notes', () => {
      run(['claim', 'Work', '--agent', 'copilot', '--scope', 'src/auth/'], dir);
      run(['runtime-note', 'Started', '--agent', 'copilot'], dir);
      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('Claims: 1 active'));
      assert.ok(res.stdout.includes('Runtime notes: 1'));
    });

    it('warns on duplicate scope claims', () => {
      run(['claim', 'First', '--agent', 'a', '--scope', 'src/auth/'], dir);
      run(['claim', 'Second', '--agent', 'b', '--scope', 'src/auth/'], dir);
      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('Multiple active claims') || res.stderr.includes('Multiple active claims'));
    });
  });

  describe('never modifies files outside .brainclaw/', () => {
    it('claim only writes to .brainclaw/claims/', () => {
      const before = fs.readdirSync(dir);
      run(['claim', 'Work', '--agent', 'a', '--scope', 'x'], dir);
      const after = fs.readdirSync(dir);
      assert.deepEqual(before, after);
    });

    it('runtime-note only writes to .brainclaw/runtime/', () => {
      const before = fs.readdirSync(dir);
      run(['runtime-note', 'Note', '--agent', 'a'], dir);
      const after = fs.readdirSync(dir);
      assert.deepEqual(before, after);
    });
  });
});

