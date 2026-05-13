import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { getInstalledBrainclawVersion } from '../src/core/brainclaw-version.js';
import { AGENT_ENV_KEYS, cleanupTestEnv } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;
const DEFAULT_STORAGE_DIR = '.brainclaw';
const ENV_BACKUP_KEYS = [...new Set([
  ...AGENT_ENV_KEYS,
  'BRAINCLAW_SKIP_REPO_ANALYSIS',
  'BRAINCLAW_SKIP_AGENT_BOOTSTRAP',
  'BRAINCLAW_SKIP_SETUP_REQUIREMENT',
  'BRAINCLAW_STORE_BOUNDARY',
  'BRAINCLAW_SESSION_ID',
  'BRAINCLAW_HOST_ID',
  'BRAINCLAW_TEST_MODE',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USER',
  'CODEX_HOME',
])];

let fakeHomes: string[] = [];

function backupEnv(keys: readonly string[]): Record<string, string | undefined> {
  const envBackup: Record<string, string | undefined> = {};
  for (const key of keys) {
    envBackup[key] = process.env[key];
  }
  return envBackup;
}

function createFakeHome(): string {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-fakehome-'));
  fakeHomes.push(fakeHome);
  return fakeHome;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));
}

function run(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  timeoutMs: number = 20000,
): { stdout: string; stderr: string; exitCode: number; fakeHome: string } {
  // Use a separate fake home so ensureUserStore() doesn't create .brainclaw/ in cwd
  const fakeHome = createFakeHome();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '0',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    USERNAME: 'testuser',
    USER: 'testuser',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    // Isolate home to a subdirectory so user store doesn't pollute project dir
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ...envOverrides,
  };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.USERNAME = 'testuser';
  env.USER = 'testuser';
  env.BRAINCLAW_STORE_BOUNDARY = cwd;
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
  Object.assign(env, envOverrides);
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    fakeHome,
  };
}

function readConfig(dir: string): any {
  return YAML.parse(fs.readFileSync(path.join(dir, activeStorageDir(dir), 'config.yaml'), 'utf-8'));
}

function readProjectIdentity(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, activeStorageDir(dir), 'project.identity.json'), 'utf-8'));
}

function readRegisteredAgents(dir: string): any[] {
  const agentsDir = path.join(dir, activeStorageDir(dir), 'agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  return fs.readdirSync(agentsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf-8')));
}

function activeStorageDir(dir: string): string {
  return fs.existsSync(path.join(dir, '.brainclaw')) ? '.brainclaw' : DEFAULT_STORAGE_DIR;
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

describe('brainclaw CLI', () => {
  let dir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    dir = tmpDir();
    fakeHomes = [];
    envBackup = backupEnv(ENV_BACKUP_KEYS);
  });

  afterEach(() => {
    for (const fakeHome of fakeHomes.splice(0)) {
      cleanupTestEnv({ fakeHome });
    }
    cleanupTestEnv({ dir, envBackup });
  });

  it('hides legacy codev commands from default help', () => {
    const res = run(['--help'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(!res.stdout.includes('codev'), `expected default help to hide codev, got: ${res.stdout}`);
    assert.ok(!res.stdout.includes('codev-metrics'), `expected default help to hide codev-metrics, got: ${res.stdout}`);
  });

  it('exposes legacy codev commands when BRAINCLAW_ENABLE_CODEV=1', () => {
    const res = run(['--help'], dir, { BRAINCLAW_ENABLE_CODEV: '1' });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('codev [options] [topic]'), `expected experimental help to include codev, got: ${res.stdout}`);
    assert.ok(res.stdout.includes('codev-metrics [options] <thread>'), `expected experimental help to include codev-metrics, got: ${res.stdout}`);
  });

  describe('init', () => {
    it('reports the installed CLI version from package metadata', () => {
      const res = run(['--version'], dir);
      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout.trim(), getInstalledBrainclawVersion());
    });

    it('creates .brainclaw/ directory with expected files', () => {
      const res = run(['init', '-y'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Initialized project memory'));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'memory', 'decisions')));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'coordination', 'plans')));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'memory', 'instructions')));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'project.md')));
      assert.ok(fs.existsSync(path.join(dir, '.brainclaw', 'config.yaml')));
    });

    it('refreshes an existing project safely without --force', () => {
      run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      const res = run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Refreshed existing project memory'));
    });

    it('rebuilds managed initialization with --force', () => {
      run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      const res = run(['init', '--force'], dir, { BRAINCLAW_TEST_MODE: '1' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Refreshed existing project memory'));
    });

    it('detects AGENTS.md', () => {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents');
      const res = run(['init', '-y'], dir, { BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '0' });
      assert.ok(res.stdout.includes('AGENTS.md'), `expected AGENTS.md mention in init output, got: ${res.stdout}`);
    });

    it('records the detected agent in the project integration manifest', () => {
      // Create a minimal .cursor/ dir in the fake home so Cursor detection writes integration files
      const fakeHome = createFakeHome();
      fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
      const res = run(['init', '-y'], dir, {
        BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '0',
        CURSOR_TRACE_ID: 'cursor-session',
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        // Suppress Claude Code env so Cursor is the detected agent
        CLAUDECODE: '',
        CLAUDE_CODE_VERSION: '',
      });
      assert.equal(res.exitCode, 0);
      const config = readConfig(dir);
      const declaration = config.agent_integrations?.declarations?.find((item: any) => item.agent_name === 'cursor');
      assert.ok(declaration, 'expected a cursor agent declaration in config');
      assert.equal(declaration.declaration_source, 'detected');
      assert.ok(declaration.surfaces.some((surface: any) => surface.kind === 'rule'));
    });

    it('defaults project mode to auto in non-interactive init', () => {
      run(['init', '-y'], dir);
      const config = readConfig(dir);
      assert.match(config.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(config.project_mode, 'auto');
      assert.equal(config.projects.strategy, 'manual');
      assert.equal(config.reputation.enabled, false);
      assert.equal(config.reputation.visibility, 'internal-only');
    });

    it('creates a stable project identity document', () => {
      run(['init', '-y'], dir);
      const config = readConfig(dir);
      const projectIdentity = readProjectIdentity(dir);
      const agents = readRegisteredAgents(dir);

      assert.equal(projectIdentity.project_id, config.project_id);
      assert.equal(projectIdentity.project_name, config.project_name);
      assert.equal(projectIdentity.storage_dir, '.brainclaw');
      assert.equal(projectIdentity.topology, 'embedded');
      assert.equal(agents.length, 1);
      assert.equal(config.current_agent, 'testuser');
      assert.equal(config.current_agent_id, agents[0].agent_id);
    });

    it('preserves project_id across re-init with --force', () => {
      run(['init', '-y'], dir);
      const firstConfig = readConfig(dir);

      const res = run(['init', '--force'], dir);
      assert.equal(res.exitCode, 0);

      const secondConfig = readConfig(dir);
      assert.equal(secondConfig.project_id, firstConfig.project_id);
    });

    it('preserves non-managed config when init upserts an existing project', () => {
      run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      const configPath = path.join(dir, '.brainclaw', 'config.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
      config.markdown = { ...config.markdown, max_items_per_section: 42 };
      config.claims = { ...config.claims, auto_release_after_hours: 72 };
      fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');

      const res = run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      assert.equal(res.exitCode, 0, res.stderr);

      const updated = readConfig(dir);
      assert.equal(updated.markdown.max_items_per_section, 42);
      assert.equal(updated.claims.auto_release_after_hours, 72);
    });

    it('resets managed config defaults when init is forced', () => {
      run(['init', '-y'], dir, { BRAINCLAW_TEST_MODE: '1' });
      const configPath = path.join(dir, '.brainclaw', 'config.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
      config.claims = { ...config.claims, auto_release_after_hours: 72 };
      fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');

      const res = run(['init', '--force'], dir, { BRAINCLAW_TEST_MODE: '1' });
      assert.equal(res.exitCode, 0, res.stderr);

      const updated = readConfig(dir);
      assert.equal(updated.claims.auto_release_after_hours, 24);
    });

    it('stores explicit multi-project init options', () => {
      run(['init', '-y', '--project-mode', 'multi-project', '--project-strategy', 'folder'], dir);
      const config = readConfig(dir);
      assert.equal(config.project_mode, 'multi-project');
      assert.equal(config.projects.strategy, 'folder');
    });

    it('prints repo analysis recommendation during init', () => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }, null, 2));
      fs.mkdirSync(path.join(dir, 'packages'));
      const res = run(['init', '-y'], dir, { BRAINCLAW_SKIP_REPO_ANALYSIS: '0' });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Recommended project mode: multi-project'));
    });

    it('rejects the removed --storage-dir option', () => {
      const res = run(['init', '-y', '--storage-dir', '.altmem'], dir);
      assert.equal(res.exitCode, 1);
      assert.ok(res.stderr.includes('unknown option'));
    });

    it('adds storage dir to .gitignore for sidecar mode', () => {
      const res = run(['init', '-y', '--topology', 'sidecar'], dir);
      assert.equal(res.exitCode, 0);
      const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(gitignore.includes('.brainclaw/'));

      const config = readConfig(dir);
      assert.equal(config.topology, 'sidecar');
      assert.equal(config.ignore_strategy, 'project-gitignore');
    });
  });

  describe('memory-rollback', () => {
    it('rejects autonomous agents and reserves the command to registered humans', () => {
      const initRes = run(['init', '-y'], dir, {}, 40000);
      assert.equal(initRes.exitCode, 0);

      const registerRes = run(['register-agent', 'codex', '--kind', 'agent'], dir);
      assert.equal(registerRes.exitCode, 0);

      const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.join(dir, '.brainclaw'),
        encoding: 'utf-8',
      });
      assert.equal(head.status, 0);

      const rollbackRes = run(['memory-rollback', head.stdout.trim(), '--actor', 'codex'], dir, {}, 40000);
      assert.equal(rollbackRes.exitCode, 1);
      const combinedOutput = `${rollbackRes.stdout}\n${rollbackRes.stderr}`;
      assert.ok(combinedOutput.includes('reserved to registered human identities'));
    });
  });

  describe('decision', () => {
    it('adds a decision', () => {
      run(['init', '-y'], dir);
      const res = run(['decision', 'Use PostgreSQL for persistence', '--tag', 'db'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Decision added'));

      const decFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'decisions')).filter(f => f.endsWith('.json'));
      assert.equal(decFiles.length, 1);
      const dPath = path.join(dir, '.brainclaw', 'memory', 'decisions', decFiles[0]);
      assert.ok(fs.existsSync(dPath));
      const decision = JSON.parse(fs.readFileSync(dPath, 'utf-8'));
      assert.equal(decision.text, 'Use PostgreSQL for persistence');
      assert.deepEqual(decision.tags, ['db']);
    });

    it('increments IDs', () => {
      run(['init', '-y'], dir);
      run(['decision', 'First'], dir);
      run(['decision', 'Second'], dir);
      const decFilesAll = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'decisions')).filter(f => f.endsWith('.json'));
      assert.equal(decFilesAll.length, 2);
    });

    it('records related path', () => {
      run(['init', '-y'], dir);
      run(['decision', 'Refactor auth', '--path', 'src/auth'], dir);
      const [decFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'decisions')).filter(f => f.endsWith('.json'));
      const decision = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'decisions', decFile), 'utf-8'));
      assert.deepEqual(decision.related_paths, ['src/auth']);
    });
  });

  describe('constraint', () => {
    it('adds a constraint', () => {
      run(['init', '-y'], dir);
      const res = run(['constraint', 'Payments frozen', '--tag', 'payments'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Constraint added'));

      const [cstFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'constraints')).filter(f => f.endsWith('.json'));
      const cPath = path.join(dir, '.brainclaw', 'memory', 'constraints', cstFile);
      assert.ok(fs.existsSync(cPath));
      const constraint = JSON.parse(fs.readFileSync(cPath, 'utf-8'));
      assert.equal(constraint.status, 'active');
    });
  });

  describe('trap', () => {
    it('adds a trap with severity', () => {
      run(['init', '-y'], dir);
      const res = run(['trap', 'Flaky test on CI', '--severity', 'high', '--tag', 'ci'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Trap added'));

      const [trpFile1] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'traps')).filter(f => f.endsWith('.json'));
      const trap = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'traps', trpFile1), 'utf-8'));
      assert.equal(trap.severity, 'high');
      assert.equal(trap.status, 'active');
    });

    it('defaults severity to medium', () => {
      run(['init', '-y'], dir);
      run(['trap', 'Something weird'], dir);
      const [trpFile2] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'traps')).filter(f => f.endsWith('.json'));
      const trap = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'traps', trpFile2), 'utf-8'));
      assert.equal(trap.severity, 'medium');
      assert.equal(trap.status, 'active');
    });
  });

  describe('handoff', () => {
    it('adds a handoff', () => {
      run(['init', '-y'], dir);
      const res = run(['handoff', '--from', 'alice', '--to', 'bob', 'Review PR #42', '--tag', 'review'], dir);
      assert.equal(res.exitCode, 0);

      const [hndFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'coordination', 'handoffs')).filter(f => f.endsWith('.json'));
      const hPath = path.join(dir, '.brainclaw', 'coordination', 'handoffs', hndFile);
      const handoff = JSON.parse(fs.readFileSync(hPath, 'utf-8'));
      assert.equal(handoff.from, 'alice');
      assert.equal(handoff.to, 'bob');
      assert.equal(handoff.status, 'open');
    });

    it('requires --from and --to', () => {
      run(['init', '-y'], dir);
      const res = run(['handoff', 'Something'], dir);
      assert.notEqual(res.exitCode, 0);
    });
  });

  describe('memory resource command', () => {
    it('creates, lists, updates, and deletes memory items', () => {
      run(['init', '-y'], dir);

      const createDecision = run(['memory', 'create', 'decision', 'Use JWT', '--tag', 'auth'], dir);
      assert.equal(createDecision.exitCode, 0);
      const decisionId = extractId(createDecision.stdout);

      const createConstraint = run(['memory', 'create', 'constraint', 'Auth gateway is frozen', '--category', 'architecture'], dir);
      assert.equal(createConstraint.exitCode, 0);

      const createTrap = run(['memory', 'create', 'trap', 'JWT refresh is flaky', '--severity', 'high'], dir);
      assert.equal(createTrap.exitCode, 0);
      const trapId = extractId(createTrap.stdout);

      const createHandoff = run(['memory', 'create', 'handoff', 'Review auth patch', '--from', 'alice', '--to', 'bob'], dir);
      assert.equal(createHandoff.exitCode, 0);

      const list = run(['memory', 'list', '--type', 'constraint', '--json'], dir);
      assert.equal(list.exitCode, 0);
      const parsedList = JSON.parse(list.stdout);
      assert.equal(parsedList.total, 1);
      assert.equal(parsedList.items[0].type, 'constraint');

      const update = run(['memory', 'update', decisionId, '--text', 'Use JWT everywhere', '--outcome', 'approved'], dir);
      assert.equal(update.exitCode, 0);
      const updateTrap = run(['memory', 'update', trapId, '--status', 'resolved'], dir);
      assert.equal(updateTrap.exitCode, 0);

      const [decisionFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'decisions')).filter(f => f.endsWith('.json'));
      const decision = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'decisions', decisionFile), 'utf-8'));
      assert.equal(decision.text, 'Use JWT everywhere');
      assert.equal(decision.outcome, 'approved');

      const [trapFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'traps')).filter(f => f.endsWith('.json'));
      const trap = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'traps', trapFile), 'utf-8'));
      assert.equal(trap.status, 'resolved');

      const status = run(['status'], dir);
      assert.equal(status.exitCode, 0);
      assert.ok(status.stdout.includes('Traps       : 0 active shared, 1 resolved shared'));

      const markdownStatus = run(['status', '--markdown'], dir);
      assert.equal(markdownStatus.exitCode, 0);
      assert.ok(markdownStatus.stdout.includes('## Known traps'));
      assert.ok(markdownStatus.stdout.includes('- (none)'));
      assert.ok(!markdownStatus.stdout.includes('JWT refresh is flaky'));

      const filteredList = run(['memory', 'list', '--type', 'trap', '--status', 'resolved', '--json'], dir);
      assert.equal(filteredList.exitCode, 0);
      const parsedTrapList = JSON.parse(filteredList.stdout);
      assert.equal(parsedTrapList.total, 1);
      assert.equal(parsedTrapList.items[0].status, 'resolved');

      const deleteRes = run(['memory', 'delete', decisionId], dir);
      assert.equal(deleteRes.exitCode, 0);
      const remainingDecisions = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'decisions')).filter(f => f.endsWith('.json'));
      assert.equal(remainingDecisions.length, 0);
    });
  });

  describe('status', () => {
    it('shows status summary', () => {
      run(['init', '-y'], dir);
      run(['decision', 'Something'], dir);
      run(['constraint', 'Frozen'], dir);
      const res = run(['status'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('2 item(s)'));
      assert.ok(res.stdout.includes('Project ID  : prj_'));
      assert.ok(res.stdout.includes('Current agent: testuser (agt_'));
      assert.ok(res.stdout.includes('Storage dir : .brainclaw'));
      assert.ok(res.stdout.includes('Topology    : embedded'));
      assert.ok(res.stdout.includes('Project mode: auto'));
      assert.ok(res.stdout.includes('Decisions   : 1'));
    });

    it('outputs JSON with --json', () => {
      run(['init', '-y'], dir);
      run(['decision', 'Test'], dir);
      const res = run(['status', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.match(parsed.config.project_id, /^prj_[a-f0-9]+$/);
      assert.equal(parsed.agents.current_name, 'testuser');
      assert.match(parsed.agents.current_id, /^agt_[a-f0-9]+$/);
      assert.equal(parsed.agents.registered.length, 1);
      assert.equal(parsed.config.project_mode, 'auto');
      assert.equal(parsed.state.version, 1);
      assert.equal(parsed.state.recent_decisions.length, 1);
      assert.equal(parsed.reputation.enabled, false);
      assert.equal(parsed.reputation.visibility, 'internal-only');
      assert.deepEqual(parsed.reputation.agents, []);
    });

    it('outputs recomputable reputation stats in JSON when enabled', () => {
      run(['init', '-y'], dir);
      const config = readConfig(dir);
      config.reputation.enabled = true;
      fs.writeFileSync(
        path.join(dir, activeStorageDir(dir), 'config.yaml'),
        YAML.stringify(config, { lineWidth: 0 }),
        'utf-8',
      );

      run(['set-trust', 'testuser', '--level', 'contributor'], dir);
      const reflectRes1 = run(['reflect', 'Useful proposal', '--type', 'decision'], dir);
      const cndId1 = extractId(reflectRes1.stdout);
      run(['star-candidate', cndId1, '--by', 'claude'], dir);
      run(['use-candidate', cndId1, '--by', 'claude', '--context', 'auth rollout'], dir);
      run(['set-trust', 'testuser', '--level', 'curator'], dir);
      run(['accept', cndId1, '--by', 'testuser'], dir);
      run(['runtime-note', 'Tracked useful runtime observation'], dir);

      const res = run(['status', '--json'], dir);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.reputation.enabled, true);
      assert.equal(parsed.reputation.visibility, 'internal-only');
      assert.equal(parsed.reputation.current_agent_id, parsed.agents.current_id);
      assert.ok(parsed.reputation.current_agent);
      assert.equal(parsed.reputation.current_agent.agent_id, parsed.agents.current_id);
      assert.equal(parsed.reputation.current_agent.signals.accepted_candidates, 1);
      assert.equal(parsed.reputation.current_agent.signals.stars_received, 1);
      assert.equal(parsed.reputation.current_agent.signals.uses_received, 1);
      assert.equal(parsed.reputation.current_agent.signals.accepted_reviews, 1);
      assert.equal(parsed.reputation.current_agent.signals.runtime_notes_created, 1);
      assert.ok(parsed.reputation.current_agent.scores.internal_trust > 0);
      assert.ok(parsed.reputation.agents.length >= 1);
    });

    it('outputs markdown with --markdown', () => {
      run(['init', '-y'], dir);
      const res = run(['status', '--markdown'], dir);
      assert.ok(res.stdout.includes('# Project Memory'));
    });
  });

  describe('doctor', () => {
    it('passes on a clean state', () => {
      run(['init', '-y'], dir);
      const res = run(['doctor'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('project identity: prj_'));
      assert.ok(res.stdout.includes('All checks passed'));
    });

    it('detects out-of-sync project.md', () => {
      run(['init', '-y'], dir);
      fs.writeFileSync(path.join(dir, '.brainclaw', 'project.md'), 'tampered');
      const res = run(['doctor'], dir);
      assert.ok(res.stdout.includes('out of sync') || res.stderr.includes('out of sync'));
    });
  });

  describe('cleanup-candidates', () => {
    it('removes only stale auto-generated candidates', () => {
      run(['init', '-y'], dir);
      const staleAuto = run(['reflect', 'Old auto candidate', '--type', 'decision'], dir);
      const staleHuman = run(['reflect', 'Old human candidate', '--type', 'decision'], dir);

      const staleAutoId = extractId(staleAuto.stdout);
      const staleHumanId = extractId(staleHuman.stdout);
      const staleAutoPath = path.join(dir, '.brainclaw', 'coordination', 'inbox', `${staleAutoId}.json`);
      const staleHumanPath = path.join(dir, '.brainclaw', 'coordination', 'inbox', `${staleHumanId}.json`);
      const autoCandidate = JSON.parse(fs.readFileSync(staleAutoPath, 'utf-8'));
      const humanCandidate = JSON.parse(fs.readFileSync(staleHumanPath, 'utf-8'));
      autoCandidate.source = 'auto';
      autoCandidate.created_at = '2025-01-01T00:00:00Z';
      humanCandidate.source = 'human';
      humanCandidate.created_at = '2025-01-01T00:00:00Z';
      fs.writeFileSync(staleAutoPath, JSON.stringify(autoCandidate, null, 2), 'utf-8');
      fs.writeFileSync(staleHumanPath, JSON.stringify(humanCandidate, null, 2), 'utf-8');

      const res = run(['cleanup-candidates', '--max-age', '30'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Removed 1'));
      assert.ok(!fs.existsSync(staleAutoPath));
      assert.ok(fs.existsSync(staleHumanPath));
    });

    it('supports dry-run', () => {
      run(['init', '-y'], dir);
      const staleAuto = run(['reflect', 'Old auto candidate', '--type', 'decision'], dir);
      const staleAutoId = extractId(staleAuto.stdout);
      const staleAutoPath = path.join(dir, '.brainclaw', 'coordination', 'inbox', `${staleAutoId}.json`);
      const autoCandidate = JSON.parse(fs.readFileSync(staleAutoPath, 'utf-8'));
      autoCandidate.source = 'auto';
      autoCandidate.created_at = '2025-01-01T00:00:00Z';
      fs.writeFileSync(staleAutoPath, JSON.stringify(autoCandidate, null, 2), 'utf-8');

      const res = run(['cleanup-candidates', '--max-age', '30', '--dry-run'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Would remove 1'));
      assert.ok(fs.existsSync(staleAutoPath));
    });
  });

  describe('bootstrap', () => {
    it('derives brownfield seeds as JSON and reuses the profile on subsequent runs', () => {
      run(['init', '-y'], dir);
      fs.writeFileSync(path.join(dir, 'README.md'), '# Brownfield Auth\n\n## Test\n\n- npm test\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent Guide\n\n- Read AGENTS.md before edits\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        scripts: { test: 'npm test' },
      }, null, 2), 'utf-8');

      const first = run(['bootstrap', '--for', 'src/auth/routes.ts', '--json'], dir);
      assert.equal(first.exitCode, 0);
      const firstParsed = JSON.parse(first.stdout);
      assert.equal(firstParsed.reused_profile, false);
      assert.ok(firstParsed.seed_count > 0);
      assert.ok(firstParsed.seeds.some((seed: { source_kind: string }) => seed.source_kind === 'agents_md'));

      const second = run(['bootstrap', '--for', 'src/auth/routes.ts', '--json'], dir);
      assert.equal(second.exitCode, 0);
      const secondParsed = JSON.parse(second.stdout);
      assert.equal(secondParsed.reused_profile, true);
    });
  });

  describe('context', () => {
    it('includes session-aware context diffs in JSON output', () => {
      run(['init', '-y'], dir);
      run(['session-start', '--context', 'auth'], dir, { BRAINCLAW_SESSION_ID: 'sess_cli_diff' });
      run(['decision', 'Auth requests now go through the gateway', '--tag', 'auth'], dir);

      const res = run(['context', '--for', 'auth', '--since-session', 'sess_cli_diff', '--json'], dir);
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.context_schema, '1.2');
      assert.equal(parsed.context_diff.since_session, 'sess_cli_diff');
      assert.equal(parsed.context_diff.counts.decisions, 1);
      assert.equal(parsed.context_diff.counts.total, 1);
    });
  });

  describe('env', () => {
    it('prints the execution context and optional agent tooling as JSON', () => {
      run(['init', '-y'], dir);
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent Guide\n\n- Read AGENTS.md before edits\n', 'utf-8');
      const codexHome = path.join(dir, '.codex-home');
      fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'openai-docs'), { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'),
        '# OpenAI Docs\n\nUse when official OpenAI docs are needed.\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(codexHome, 'config.toml'),
        '[mcp_servers.atlassian]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]\n',
        'utf-8',
      );

      const res = run(['env', '--json', '--agent-tooling'], dir, { CODEX_HOME: codexHome });
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.stdout);
      assert.ok(parsed.execution_context);
      assert.deepEqual(parsed.agent_tooling.agents_rules, ['Read AGENTS.md before edits']);
      assert.equal(parsed.agent_tooling.skills[0].name, 'openai-docs');
      assert.equal(parsed.agent_tooling.mcp_servers[0].name, 'atlassian');
      assert.equal(parsed.agent_tooling.mcp_servers[0].availability, 'remote');
    });
  });

  describe('rebuild', () => {
    it('regenerates project.md from state.json', () => {
      run(['init', '-y'], dir);
      run(['decision', 'Test rebuild'], dir);
      fs.writeFileSync(path.join(dir, '.brainclaw', 'project.md'), 'corrupted');
      run(['rebuild'], dir);
      const md = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
      assert.ok(md.includes('Test rebuild'));
      assert.ok(md.includes('# Project Memory'));
    });
  });

  describe('security', () => {
    it('warns on sensitive patterns', () => {
      run(['init', '-y'], dir);
      const res = run(['decision', 'Store the api_key in config'], dir);
      assert.ok(res.stderr.includes('sensitive content') || res.stdout.includes('sensitive content'));
    });

    it('warns on sensitive paths', () => {
      run(['init', '-y'], dir);
      const res = run(['trap', 'Check .env for missing values'], dir);
      assert.ok(res.stderr.includes('.env') || res.stdout.includes('.env'));
    });
  });

  describe('reversibility', () => {
    it('removing .brainclaw/ fully uninstalls', () => {
      run(['init', '-y'], dir);
      run(['decision', 'Test'], dir);
      fs.rmSync(path.join(dir, '.brainclaw'), { recursive: true, force: true });
      assert.ok(!fs.existsSync(path.join(dir, '.brainclaw')));
      // status should fail now
      const res = run(['status'], dir);
      assert.notEqual(res.exitCode, 0);
    });
  });

  describe('agents', () => {
    it('registers a new agent and can set it as current', () => {
      run(['init', '-y'], dir);

      const res = run(['register-agent', 'copilot', '--kind', 'agent', '--set-current'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Agent registered: copilot'));

      const config = readConfig(dir);
      assert.equal(config.current_agent, 'copilot');
      assert.match(config.current_agent_id, /^agt_[a-f0-9]+$/);

      const agents = readRegisteredAgents(dir);
      assert.equal(agents.length, 2);
      assert.ok(agents.some((agent) => agent.agent_name === 'copilot' && agent.kind === 'agent'));
    });

    it('upserts agent capabilities and can generate a fingerprint', () => {
      run(['init', '-y'], dir);
      const codexHome = path.join(dir, '.codex-home');

      const created = run([
        'register-agent',
        'copilot',
        '--kind',
        'agent',
        '--capability',
        'review',
        '--capability',
        'planning',
        '--generate-fingerprint',
        '--json',
      ], dir, { CODEX_HOME: codexHome });
      assert.equal(created.exitCode, 0);
      const createdParsed = JSON.parse(created.stdout);
      assert.deepEqual(createdParsed.capabilities, ['review', 'planning']);
      assert.ok(createdParsed.identity_key?.fingerprint);

      const updated = run([
        'register-agent',
        'copilot',
        '--capability',
        'code-generation',
        '--json',
      ], dir, { CODEX_HOME: codexHome });
      assert.equal(updated.exitCode, 0);
      const updatedParsed = JSON.parse(updated.stdout);
      assert.deepEqual(updatedParsed.capabilities, ['review', 'planning', 'code-generation']);
    });

    it('lists registered agents as JSON', () => {
      run(['init', '-y'], dir);
      run(['register-agent', 'copilot', '--kind', 'agent'], dir);

      const res = run(['list-agents', '--json'], dir);
      assert.equal(res.exitCode, 0);

      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.current_agent, 'testuser');
      assert.equal(parsed.agents.length, 2);
      assert.ok(parsed.agents.some((agent: any) => agent.agent_name === 'copilot'));
    });

    it('can include bounded reputation summaries in list-agents JSON', () => {
      run(['init', '-y'], dir);
      const config = readConfig(dir);
      config.reputation.enabled = true;
      fs.writeFileSync(path.join(dir, activeStorageDir(dir), 'config.yaml'), YAML.stringify(config, { lineWidth: 0 }), 'utf-8');

      const reflectRes2 = run(['reflect', 'Useful proposal', '--type', 'decision'], dir);
      const cndId2 = extractId(reflectRes2.stdout);
      run(['set-trust', 'testuser', '--level', 'curator'], dir);
      run(['accept', cndId2, '--by', 'testuser'], dir);

      const res = run(['list-agents', '--json', '--with-reputation'], dir);
      assert.equal(res.exitCode, 0);
      const parsed = JSON.parse(res.stdout);
      const current = parsed.agents.find((agent: any) => agent.agent_name === 'testuser');
      assert.ok(current);
      assert.ok(current.reputation);
      assert.equal(typeof current.reputation.internal_trust, 'number');
    });

    it('enable-agent activates a late-arriving cursor agent and can set it current', () => {
      run(['init', '-y'], dir);

      const res = run(['enable-agent', 'cursor', '--set-current'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Agent enabled: cursor'));
      assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', 'brainclaw.md')));
      assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc')));

      const config = readConfig(dir);
      assert.equal(config.current_agent, 'cursor');
      const declaration = config.agent_integrations.declarations.find((item: any) => item.agent_name === 'cursor');
      assert.ok(declaration);
      assert.equal(declaration.declaration_source, 'manual');
    });

    it('enable-agent activates a late-arriving windsurf agent with machine-local MCP config', () => {
      run(['init', '-y'], dir);

      const res = run(['enable-agent', 'windsurf'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(fs.existsSync(path.join(dir, '.windsurfrules')));
      // MCP config is written to HOME (machine-level), not project dir
      assert.ok(
        fs.existsSync(path.join(res.fakeHome, '.codeium', 'windsurf', 'mcp_config.json'))
        || fs.existsSync(path.join(dir, '.codeium', 'windsurf', 'mcp_config.json')),
        'expected windsurf MCP config in HOME or project dir',
      );
      const windsurfRules = fs.readFileSync(path.join(dir, '.windsurfrules'), 'utf-8');
      assert.ok(
        windsurfRules.includes('## brainclaw') || windsurfRules.includes('## Brainclaw'),
        'expected brainclaw header in .windsurfrules',
      );
      assert.ok(windsurfRules.includes('brainclaw'), 'expected brainclaw content in .windsurfrules');
    });

    it('version command reports project upgrade policy when configured', () => {
      run(['init', '-y'], dir);
      const configPath = path.join(dir, '.brainclaw', 'config.yaml');
      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as any;
      config.minimum_brainclaw_version = '99.0.0';
      config.brainclaw_upgrade_message = 'Includes auto-agent bootstrap fixes.';
      fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');

      const res = run(['version'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes(`brainclaw ${getInstalledBrainclawVersion()}`));
      assert.ok(res.stdout.includes('Minimum required: 99.0.0'));
      assert.ok(res.stdout.includes('Includes auto-agent bootstrap fixes.'));
    });

    it('version --check reads a configured local-pack manifest', () => {
      run(['init', '-y'], dir);
      const configPath = path.join(dir, '.brainclaw', 'config.yaml');
      const manifestPath = path.join(dir, '.releases', 'brainclaw-local.json');
      const latestInstallableVersion = '99.0.0';
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        channel: 'local-pack',
        package_name: 'brainclaw',
        latest_installable_version: latestInstallableVersion,
        artifact_path: `./brainclaw-${latestInstallableVersion}.tgz`,
        release_notes: 'Local tarball ready for self-upgrade.',
      }, null, 2), 'utf-8');

      const config = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as any;
      config.brainclaw_update_source = {
        type: 'local-pack',
        manifest_path: '.releases/brainclaw-local.json',
      };
      fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');

      const res = run(['version', '--check'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes(`A newer installable brainclaw build is available: ${latestInstallableVersion}`));
      assert.ok(res.stdout.includes(`Latest installable: ${latestInstallableVersion}`));
      assert.ok(res.stdout.includes('Install command:'));
    });

    it('version --publish-local creates the .releases channel and wires config', () => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'brainclaw',
        version: '0.6.1',
        type: 'module',
        files: ['index.js'],
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dir, 'index.js'), 'export const ready = true;\n', 'utf-8');
      run(['init', '-y'], dir);

      const res = run(['version', '--publish-local', '--release-notes', 'Local self-update candidate.'], dir, {
        BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      }, 60000);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('Local release published: 0.6.1'));
      assert.ok(fs.existsSync(path.join(dir, '.releases', 'brainclaw-local.json')));

      const releaseFiles = fs.readdirSync(path.join(dir, '.releases'));
      assert.ok(releaseFiles.some((file) => /^brainclaw-0\.6\.1.*\.tgz$/.test(file)));

      const config = readConfig(dir);
      assert.deepEqual(config.brainclaw_update_source, {
        type: 'local-pack',
        manifest_path: '.releases/brainclaw-local.json',
      });

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.releases', 'brainclaw-local.json'), 'utf-8'));
      assert.equal(manifest.latest_installable_version, '0.6.1');
      assert.equal(manifest.release_notes, 'Local self-update candidate.');
      assert.ok(manifest.install_command.includes('.releases/'));
      assert.ok(manifest.install_command.endsWith('.tgz"'));

      const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(gitignore.includes('.releases/'));
    });
  });

  describe('plan subcommand guard (0.6.1)', () => {
    it('supports the explicit plan resource workflow', () => {
      run(['init', '-y'], dir);

      const created = run(['plan', 'create', 'Fix auth', '--status', 'todo', '--priority', 'high'], dir);
      assert.equal(created.exitCode, 0);
      const planId = extractId(created.stdout);

      const listed = run(['plan', 'list', '--status', 'todo'], dir);
      assert.equal(listed.exitCode, 0);
      assert.ok(listed.stdout.includes('Fix auth'));

      const updated = run(['plan', 'update', planId, '--status', 'done'], dir);
      assert.equal(updated.exitCode, 0);

      const deleted = run(['plan', 'delete', planId], dir);
      assert.equal(deleted.exitCode, 0);

      const afterDelete = run(['plan', 'list', '--all', '--json'], dir);
      const parsed = JSON.parse(afterDelete.stdout);
      assert.equal(parsed.length, 0);
    });

    it('"plan list" lists plans instead of creating a ghost plan', () => {
      run(['init', '-y'], dir);
      run(['plan', 'a real plan item'], dir);

      const res = run(['plan', 'list'], dir);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('a real plan item'), `expected plan list output, got: ${res.stdout}`);
      // must not have created a ghost plan with text "list"
      const listRes = run(['list-plans'], dir);
      const items: string[] = listRes.stdout.split('\n').filter((l) => l.includes('list'));
      // The only "list" hit should be the plan text "list" if present — but there should be none
      const ghostItems = items.filter((l) => /\[pln_[a-f0-9]+\] list/.test(l));
      assert.equal(ghostItems.length, 0, `ghost plan with text "list" was created: ${ghostItems.join('\n')}`);
    });

    it('"plan ls" lists plans instead of creating a ghost plan', () => {
      run(['init', '-y'], dir);

      const res = run(['plan', 'ls'], dir);
      assert.equal(res.exitCode, 0);
      // must not have created a ghost plan
      const listRes = run(['list-plans'], dir);
      assert.ok(!listRes.stdout.includes('] ls'), `ghost plan "ls" was created: ${listRes.stdout}`);
    });

    it('"plan update" shows an actionable error instead of creating a ghost plan', () => {
      run(['init', '-y'], dir);

      const res = run(['plan', 'update'], dir);
      assert.notEqual(res.exitCode, 0);
      assert.ok(res.stderr.includes('brainclaw plan update <id>'), `expected hint to use plan update, got: ${res.stderr}`);
      // must not have created a ghost plan
      const listRes = run(['list-plans'], dir);
      assert.ok(!listRes.stdout.includes('] update'), `ghost plan "update" was created: ${listRes.stdout}`);
    });
  });
});


