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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-reflect-'));
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

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

describe('Reflective Memory (Phase 1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('reflect', () => {
    it('creates a pending candidate in inbox', () => {
      const res = run(['reflect', 'Consider using Redis for caching', '--type', 'decision', '--tag', 'cache'], dir, { BRAINCLAW_SESSION_ID: 'sess_reflect_1' });
      assert.equal(res.exitCode, 0);
      const cndId = extractId(res.stdout);
      assert.ok(res.stdout.includes(`[${cndId}]`));
      assert.ok(res.stdout.includes('Candidate created'));

      // Verify file exists
      const inboxDir = path.join(dir, '.brainclaw', 'inbox');
      assert.ok(fs.existsSync(inboxDir));
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);
      assert.equal(files[0], `${cndId}.json`);

      const candidate = JSON.parse(fs.readFileSync(path.join(inboxDir, `${cndId}.json`), 'utf-8'));
      assert.equal(candidate.status, 'pending');
      assert.equal(candidate.type, 'decision');
      assert.equal(candidate.author, 'testuser');
      assert.match(candidate.author_id, /^agt_[a-f0-9]+$/);
      assert.match(candidate.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(candidate.host_id, os.hostname().toLowerCase());
      assert.equal(candidate.session_id, 'sess_reflect_1');
      assert.deepEqual(candidate.tags, ['cache']);
    });

    it('increments candidate IDs', () => {
      const r1 = run(['reflect', 'First', '--type', 'decision'], dir);
      const r2 = run(['reflect', 'Second', '--type', 'trap'], dir);
      const r3 = run(['reflect', 'Third', '--type', 'constraint'], dir);
      const id1 = extractId(r1.stdout);
      const id2 = extractId(r2.stdout);
      const id3 = extractId(r3.stdout);
      assert.ok(id1.startsWith('cnd_'));
      assert.notEqual(id1, id2);
      assert.notEqual(id2, id3);
      assert.notEqual(id1, id3);
    });

    it('detects duplicates against state', () => {
      run(['decision', 'Use PostgreSQL for persistence'], dir);
      const res = run(['reflect', 'Use PostgreSQL for persistence', '--type', 'decision'], dir);
      assert.ok(res.stderr.includes('duplicate') || res.stdout.includes('duplicate'));
    });

    it('detects duplicates against pending candidates', () => {
      run(['reflect', 'Freeze payments module', '--type', 'constraint'], dir);
      const res = run(['reflect', 'Freeze payments module', '--type', 'constraint'], dir);
      assert.ok(res.stderr.includes('duplicate') || res.stdout.includes('duplicate'));
    });

    it('warns on sensitive content', () => {
      const res = run(['reflect', 'Store api_key in config', '--type', 'decision'], dir);
      assert.ok(res.stderr.includes('sensitive content'));
    });

    it('supports handoff type with from/to', () => {
      const res = run(['reflect', 'Review auth changes', '--type', 'handoff', '--from', 'alice', '--to', 'bob'], dir);
      assert.equal(res.exitCode, 0);
      const cndId = extractId(res.stdout);
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'inbox', `${cndId}.json`), 'utf-8'));
      assert.equal(candidate.from, 'alice');
      assert.equal(candidate.to, 'bob');
    });

    it('reflect-runtime-note promotes a visible machine-local note into a candidate', () => {
      const rtnRes1 = run(['runtime-note', 'Node is not on PATH on this host', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows', '--tag', 'npm'], dir, { BRAINCLAW_HOST_ID: 'host-a', BRAINCLAW_SESSION_ID: 'sess_runtime_note' });
      const rtnId1 = extractId(rtnRes1.stdout);

      const res = run(['reflect-runtime-note', rtnId1, '--type', 'trap'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Candidate created'));

      const cndId1 = extractId(res.stdout);
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'inbox', `${cndId1}.json`), 'utf-8'));
      assert.equal(candidate.text, 'Node is not on PATH on this host');
      assert.equal(candidate.type, 'trap');
      assert.equal(candidate.source, `runtime-note:copilot:${rtnId1}`);
      assert.match(candidate.author_id, /^agt_[a-f0-9]+$/);
      assert.match(candidate.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(candidate.host_id, 'host-a');
      assert.equal(candidate.session_id, 'sess_runtime_note');
      assert.deepEqual(candidate.tags, ['windows', 'npm']);
    });

    it('reflect-runtime-note can rewrite the candidate text during promotion', () => {
      const rtnRes2 = run(['runtime-note', 'Node is not on PATH on this host', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      const rtnId2 = extractId(rtnRes2.stdout);

      const res = run([
        'reflect-runtime-note',
        rtnId2,
        'On some Windows environments, validation should use the absolute Node binary when PATH is missing Node.',
        '--type',
        'trap',
        '--tag',
        'validation',
      ], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.equal(res.exitCode, 0);

      const cndId2 = extractId(res.stdout);
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'inbox', `${cndId2}.json`), 'utf-8'));
      assert.equal(candidate.text, 'On some Windows environments, validation should use the absolute Node binary when PATH is missing Node.');
      assert.deepEqual(candidate.tags, ['windows', 'validation']);
    });

    it('reflect-runtime-note respects host visibility boundaries unless explicitly widened', () => {
      const rtnRes3 = run(['runtime-note', 'Host B only note', '--agent', 'copilot', '--visibility', 'machine'], dir, { BRAINCLAW_HOST_ID: 'host-b' });
      const rtnId3 = extractId(rtnRes3.stdout);

      let res = run(['reflect-runtime-note', rtnId3, '--type', 'decision'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.notEqual(res.exitCode, 0);
      assert.ok(res.stderr.includes('not found'));

      res = run(['reflect-runtime-note', rtnId3, '--type', 'decision', '--all-hosts'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Candidate created'));
    });

    it('reflect-runtime-note suggests candidate types when no type is provided', () => {
      const rtnRes4 = run(['runtime-note', 'Node is not on PATH on this host', '--agent', 'copilot', '--visibility', 'machine', '--tag', 'windows'], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      const rtnId4 = extractId(rtnRes4.stdout);

      const res = run(['reflect-runtime-note', rtnId4], dir, { BRAINCLAW_HOST_ID: 'host-a' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Promotion suggestions'));
      assert.ok(res.stdout.includes('trap'));
      const inboxCndFiles = fs.existsSync(path.join(dir, '.brainclaw', 'inbox'))
        ? fs.readdirSync(path.join(dir, '.brainclaw', 'inbox')).filter(f => f.endsWith('.json') && f.startsWith('cnd_'))
        : [];
      assert.equal(inboxCndFiles.length, 0);
    });
  });

  describe('review', () => {
    it('shows pending candidates', () => {
      const r1 = run(['reflect', 'First item', '--type', 'decision'], dir);
      const r2 = run(['reflect', 'Second item', '--type', 'trap'], dir);
      const id1 = extractId(r1.stdout);
      const id2 = extractId(r2.stdout);
      const res = run(['review'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('2 pending'));
      assert.ok(res.stdout.includes(`[${id1}]`));
      assert.ok(res.stdout.includes(`[${id2}]`));
    });

    it('filters by type', () => {
      run(['reflect', 'A decision', '--type', 'decision'], dir);
      run(['reflect', 'A trap', '--type', 'trap'], dir);
      const res = run(['review', '--type', 'trap'], dir);
      assert.ok(res.stdout.includes('1 pending'));
      assert.ok(res.stdout.includes('A trap'));
      assert.ok(!res.stdout.includes('A decision'));
    });

    it('outputs JSON', () => {
      run(['reflect', 'Test', '--type', 'decision'], dir);
      const res = run(['review', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].status, 'pending');
    });

    it('shows message when empty', () => {
      const res = run(['review'], dir);
      assert.ok(res.stdout.includes('No pending'));
    });

    it('shows promotion recommendation when a candidate reaches the star threshold', () => {
      const rStar = run(['reflect', 'Adopt this decision', '--type', 'decision'], dir);
      const cndIdStar = extractId(rStar.stdout);
      run(['star-candidate', cndIdStar, '--by', 'copilot'], dir);
      run(['star-candidate', cndIdStar, '--by', 'claude'], dir);
      run(['star-candidate', cndIdStar, '--by', 'cursor'], dir);

      const res = run(['review', '--prioritized'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('stars 3/3'));
      assert.ok(res.stdout.includes('PROMOTE?'));
    });

    it('includes promotion fields in review JSON output', () => {
      const rJson = run(['reflect', 'JSON recommendation', '--type', 'decision'], dir);
      const cndIdJson = extractId(rJson.stdout);
      run(['star-candidate', cndIdJson, '--by', 'copilot'], dir);
      run(['star-candidate', cndIdJson, '--by', 'claude'], dir);
      run(['star-candidate', cndIdJson, '--by', 'cursor'], dir);

      const res = run(['review', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed[0].promotion_stars, 3);
      assert.equal(parsed[0].promotion_threshold, 3);
      assert.equal(parsed[0].promotion_uses, 0);
      assert.equal(parsed[0].promotion_recommended, true);
    });

    it('shows promotion recommendation when a candidate is reused multiple times', () => {
      const rReuse = run(['reflect', 'Widely reused proposal', '--type', 'decision'], dir);
      const cndIdReuse = extractId(rReuse.stdout);
      run(['use-candidate', cndIdReuse, '--by', 'copilot', '--context', 'auth rollout'], dir);
      run(['use-candidate', cndIdReuse, '--by', 'claude', '--context', 'refund workflow'], dir);

      const res = run(['review', '--prioritized'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('uses 2/2'));
      assert.ok(res.stdout.includes('PROMOTE?'));
    });

    it('uses author trust as a prudent tie-breaker in prioritized review mode', () => {
      enableReputation(dir);
      run(['set-trust', 'testuser', '--level', 'curator'], dir);

      run(['register-agent', 'trusted-bot', '--kind', 'agent', '--set-current'], dir);
      const rTb1 = run(['reflect', 'Trusted baseline one', '--type', 'decision'], dir);
      run(['accept', extractId(rTb1.stdout), '--by', 'testuser'], dir);
      const rTb2 = run(['reflect', 'Trusted baseline two', '--type', 'decision'], dir);
      run(['accept', extractId(rTb2.stdout), '--by', 'testuser'], dir);

      run(['register-agent', 'novice-bot', '--kind', 'agent', '--set-current'], dir);
      run(['reflect', 'Novice pending candidate', '--type', 'decision'], dir);

      run(['register-agent', 'trusted-bot', '--kind', 'agent', '--set-current'], dir);
      run(['reflect', 'Trusted pending candidate', '--type', 'decision'], dir);

      const res = run(['review', '--prioritized'], dir);
      assert.equal(res.exitCode, 0);
      const trustedIndex = res.stdout.indexOf('Trusted pending candidate');
      const noviceIndex = res.stdout.indexOf('Novice pending candidate');
      assert.ok(trustedIndex >= 0);
      assert.ok(noviceIndex >= 0);
      assert.ok(trustedIndex < noviceIndex);
    });
  });

  describe('star-candidate', () => {
    it('increments star count once per actor', () => {
      const rStarCount = run(['reflect', 'Popular proposal', '--type', 'decision'], dir);
      const cndIdSc = extractId(rStarCount.stdout);

      let res = run(['star-candidate', cndIdSc, '--by', 'copilot'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('(1/3)'));

      res = run(['star-candidate', cndIdSc, '--by', 'copilot'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('already starred'));

      const candidate = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'inbox', `${cndIdSc}.json`), 'utf-8'));
      assert.equal(candidate.star_count, 1);
      assert.deepEqual(candidate.starred_by, ['copilot']);
    });
  });

  describe('use-candidate', () => {
    it('increments usage count once per actor and context pair', () => {
      const rUse = run(['reflect', 'Practical idea', '--type', 'decision'], dir);
      const cndIdUse = extractId(rUse.stdout);

      let res = run(['use-candidate', cndIdUse, '--by', 'copilot', '--context', 'auth rollout'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('(1/2 uses)'));

      res = run(['use-candidate', cndIdUse, '--by', 'copilot', '--context', 'auth rollout'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('already marked used'));

      const candidate = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'inbox', `${cndIdUse}.json`), 'utf-8'));
      assert.equal(candidate.usage_count, 1);
      assert.equal(candidate.usage_events.length, 1);
      assert.equal(candidate.usage_events[0].context, 'auth rollout');
    });
  });

  describe('show-candidate', () => {
    it('shows full candidate JSON', () => {
      const rShow = run(['reflect', 'Test candidate', '--type', 'decision'], dir);
      const cndIdShow = extractId(rShow.stdout);
      const res = run(['show-candidate', cndIdShow], dir);
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.id, cndIdShow);
      assert.equal(parsed.text, 'Test candidate');
    });

    it('fails for non-existent candidate', () => {
      const res = run(['show-candidate', 'cnd_999'], dir);
      assert.notEqual(res.exitCode, 0);
    });
  });

  describe('accept', () => {
    it('promotes decision candidate into state', () => {
      const rDec = run(['reflect', 'Use Redis for caching', '--type', 'decision', '--tag', 'cache'], dir, { BRAINCLAW_SESSION_ID: 'sess_accept_1' });
      const cndIdDec = extractId(rDec.stdout);
      const res = run(['accept', cndIdDec], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Promoted to decision'));
      assert.ok(res.stdout.includes('accepted and archived'));

      // Verify state was updated
      const decFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'decisions')).filter(f => f.endsWith('.json'));
      assert.equal(decFiles.length, 1);
      const dec = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'decisions', decFiles[0]), 'utf-8'));
      assert.equal(dec.text, 'Use Redis for caching');
      assert.equal(dec.author, 'testuser');
      assert.match(dec.author_id, /^agt_[a-f0-9]+$/);
      assert.match(dec.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(dec.host_id, os.hostname().toLowerCase());
      assert.equal(dec.session_id, 'sess_accept_1');

      // Verify project.md was rebuilt
      const md = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
      assert.ok(md.includes('Use Redis for caching'));

      // Verify candidate was archived
      assert.ok(!fs.existsSync(path.join(dir, '.brainclaw', 'inbox', `${cndIdDec}.json`)));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'inbox', 'accepted', `${cndIdDec}.json`)));
    });

    it('promotes constraint candidate', () => {
      const rCst = run(['reflect', 'Payments frozen', '--type', 'constraint'], dir);
      run(['accept', extractId(rCst.stdout)], dir);
      const cstFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'constraints')).filter(f => f.endsWith('.json'));
      assert.equal(cstFiles.length, 1);
      const constraint = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'constraints', cstFiles[0]), 'utf-8'));
      assert.equal(constraint.status, 'active');
    });

    it('promotes trap candidate with severity', () => {
      const rTrp = run(['reflect', 'Flaky test', '--type', 'trap', '--severity', 'high'], dir);
      run(['accept', extractId(rTrp.stdout)], dir);
      const trpFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'traps')).filter(f => f.endsWith('.json'));
      assert.equal(trpFiles.length, 1);
      const trap = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'traps', trpFiles[0]), 'utf-8'));
      assert.equal(trap.severity, 'high');
    });

    it('promotes handoff candidate', () => {
      const rHnd = run(['reflect', 'Review PR', '--type', 'handoff', '--from', 'alice', '--to', 'bob'], dir);
      run(['accept', extractId(rHnd.stdout)], dir);
      const hndFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'handoffs')).filter(f => f.endsWith('.json'));
      assert.equal(hndFiles.length, 1);
      const handoff = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'handoffs', hndFiles[0]), 'utf-8'));
      assert.equal(handoff.from, 'alice');
      assert.equal(handoff.to, 'bob');
    });

    it('fails on already-accepted candidate', () => {
      const rAlready = run(['reflect', 'Test', '--type', 'decision'], dir);
      const cndIdAlready = extractId(rAlready.stdout);
      run(['accept', cndIdAlready], dir);
      // Candidate is now in accepted/ archive, not in inbox
      const res = run(['accept', cndIdAlready], dir);
      assert.notEqual(res.exitCode, 0);
    });
  });

  describe('reject', () => {
    it('rejects and archives a candidate', () => {
      const rRej = run(['reflect', 'Bad idea', '--type', 'decision'], dir);
      const cndIdRej = extractId(rRej.stdout);
      const res = run(['reject', cndIdRej, '--reason', 'Not relevant'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('rejected and archived'));

      // Verify removed from inbox
      assert.ok(!fs.existsSync(path.join(dir, '.brainclaw', 'inbox', `${cndIdRej}.json`)));

      // Verify in rejected archive
      const archived = JSON.parse(fs.readFileSync(
        path.join(dir, '.brainclaw', 'inbox', 'rejected', `${cndIdRej}.json`), 'utf-8'
      ));
      assert.equal(archived.status, 'rejected');
      assert.equal(archived.resolved_by, 'testuser');
      assert.equal(archived.resolution_reason, 'Not relevant');
    });

    it('supports explicit reviewer attribution on rejection', () => {
      const rRej2 = run(['reflect', 'Another bad idea', '--type', 'decision'], dir);
      const cndIdRej2 = extractId(rRej2.stdout);
      const res = run(['reject', cndIdRej2, '--by', 'curator-bot', '--reason', 'Duplicate of accepted decision'], dir);
      assert.equal(res.exitCode, 0);

      const archived = JSON.parse(fs.readFileSync(
        path.join(dir, '.brainclaw', 'inbox', 'rejected', `${cndIdRej2}.json`), 'utf-8'
      ));
      assert.equal(archived.resolved_by, 'curator-bot');
      assert.equal(archived.resolution_reason, 'Duplicate of accepted decision');
    });
  });

  describe('prune-candidates', () => {
    it('prunes old rejected candidates', () => {
      const rPrune = run(['reflect', 'Old item', '--type', 'decision'], dir);
      const cndIdPrune = extractId(rPrune.stdout);
      run(['reject', cndIdPrune], dir);

      // Manually backdate the rejected candidate
      const rejectedPath = path.join(dir, '.brainclaw', 'inbox', 'rejected', `${cndIdPrune}.json`);
      const candidate = JSON.parse(fs.readFileSync(rejectedPath, 'utf-8'));
      candidate.resolved_at = '2025-01-01T00:00:00Z';
      candidate.created_at = '2025-01-01T00:00:00Z';
      fs.writeFileSync(rejectedPath, JSON.stringify(candidate, null, 2));

      const res = run(['prune-candidates', '--days', '1'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Pruned 1'));
      assert.ok(!fs.existsSync(rejectedPath));
    });

    it('supports dry-run', () => {
      const rDry = run(['reflect', 'Old item', '--type', 'decision'], dir);
      const cndIdDry = extractId(rDry.stdout);
      run(['reject', cndIdDry], dir);

      const rejectedPath = path.join(dir, '.brainclaw', 'inbox', 'rejected', `${cndIdDry}.json`);
      const candidate = JSON.parse(fs.readFileSync(rejectedPath, 'utf-8'));
      candidate.resolved_at = '2025-01-01T00:00:00Z';
      fs.writeFileSync(rejectedPath, JSON.stringify(candidate, null, 2));

      const res = run(['prune-candidates', '--days', '1', '--dry-run'], dir);
      assert.ok(res.stdout.includes('Would prune'));
      // File should still exist
      assert.ok(fs.existsSync(rejectedPath));
    });
  });

  describe('doctor with reflective memory', () => {
    it('reports reflective memory stats', () => {
      run(['reflect', 'Pending item', '--type', 'decision'], dir);
      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('1 pending'));
    });

    it('warns on sensitive content in candidates', () => {
      run(['reflect', 'Check api_key config', '--type', 'decision'], dir);
      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('Candidate warnings') || res.stderr.includes('sensitive'));
    });

    it('warns when candidates reached the promotion star threshold', () => {
      const rThresh = run(['reflect', 'Promotion threshold candidate', '--type', 'decision'], dir);
      const cndIdThresh = extractId(rThresh.stdout);
      run(['star-candidate', cndIdThresh, '--by', 'copilot'], dir);
      run(['star-candidate', cndIdThresh, '--by', 'claude'], dir);
      run(['star-candidate', cndIdThresh, '--by', 'cursor'], dir);

      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('Promotion signal') || res.stderr.includes('Promotion signal'));
    });

    it('warns when candidates reached the promotion usage threshold', () => {
      const rUsage = run(['reflect', 'Used several times', '--type', 'decision'], dir);
      const cndIdUsage = extractId(rUsage.stdout);
      run(['use-candidate', cndIdUsage, '--by', 'copilot', '--context', 'auth rollout'], dir);
      run(['use-candidate', cndIdUsage, '--by', 'claude', '--context', 'refund workflow'], dir);

      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('2 use(s)') || res.stderr.includes('2 use(s)'));
    });
  });

  describe('never auto-writes to canonical memory', () => {
    it('reflect does not modify decisions directory', () => {
      const p = path.join(dir, '.brainclaw', 'decisions');
      const filesBefore = fs.readdirSync(p);
      run(['reflect', 'Some idea', '--type', 'decision'], dir);
      const filesAfter = fs.readdirSync(p);
      assert.deepEqual(filesBefore, filesAfter);
    });

    it('reflect does not modify project.md', () => {
      const mdBefore = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
      run(['reflect', 'Some idea', '--type', 'decision'], dir);
      const mdAfter = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
      assert.equal(mdBefore, mdAfter);
    });
  });
});

