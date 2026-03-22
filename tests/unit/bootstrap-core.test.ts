import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyBootstrapImport,
  loadBootstrapApplication,
  loadBootstrapImportPlan,
  loadBootstrapProfile,
  listBootstrapSeeds,
  runBootstrapProfile,
  uninstallBootstrapImport,
} from '../../src/core/bootstrap.js';
import { loadInstructions } from '../../src/core/instructions.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/bootstrap', () => {
  let workspace: TestWorkspace;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-bootstrap-core-',
      projectId: 'prj_bootstrap_core',
      currentAgent: 'copilot',
    });
    const codexHome = path.join(workspace.dir, '.codex-home');
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
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    workspace.cleanup();
  });

  it('derives seeds from README, AGENTS.md, manifests, and repo analysis', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Brownfield App\n\n## Test\n\n- npm test\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Rules\n\n- Read memory first\n- Prefer focused diffs\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), '# Claude Rules\n\n- Check native instructions before editing\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      scripts: {
        build: 'pnpm build',
        test: 'pnpm test',
      },
      workspaces: ['packages/*'],
    }, null, 2), 'utf-8');
    fs.mkdirSync(path.join(workspace.dir, 'packages'), { recursive: true });

    const result = runBootstrapProfile({ target: 'src/auth/routes.ts', cwd: workspace.dir });

    assert.equal(result.reusedProfile, false);
    assert.ok(result.profile.summary.includes('Bootstrap summary for src/auth/routes.ts'));
    assert.equal(result.profile.agents_md_present, true);
    assert.equal(result.profile.workspace_kind, 'existing');
    assert.equal(result.profile.confidence, 'high');
    assert.ok(result.profile.native_instruction_files.includes('CLAUDE.md'));
    assert.ok(result.profile.sources_scanned.includes('README'));
    assert.ok(result.profile.sources_scanned.includes('AGENTS.md'));
    assert.ok(result.profile.sources_scanned.includes('native_instructions'));
    assert.ok(result.profile.sources_scanned.includes('package.json'));
    assert.ok(result.profile.sources_scanned.includes('execution_context'));
    assert.ok(result.profile.sources_scanned.includes('skills'));
    assert.ok(result.profile.sources_scanned.includes('local_mcp'));
    assert.ok(result.profile.sources_scanned.includes('repo-analysis'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'agents_md' && seed.seed_kind === 'agent_rule'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'native_instruction' && seed.seed_kind === 'agent_rule'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'manifest' && seed.seed_kind === 'command'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'machine' && seed.seed_kind === 'tooling'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'skill' && seed.seed_kind === 'tooling'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'mcp' && seed.seed_kind === 'tooling'));
    assert.ok(result.seeds.some((seed) => seed.source_kind === 'repo_analysis'));
    assert.ok(result.importPlan.suggestion_count > 0);
    assert.ok(result.importPlan.suggestions.some((suggestion) => suggestion.target === 'instruction'));
    assert.equal(loadBootstrapProfile(workspace.dir)?.seed_count, result.seeds.length);
    assert.equal(loadBootstrapImportPlan(workspace.dir)?.suggestion_count, result.importPlan.suggestion_count);
    assert.equal(listBootstrapSeeds(workspace.dir).length, result.seeds.length);
  });

  it('marks an empty workspace with explicit onboarding gaps', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bootstrap-empty-'));
    try {
      const result = runBootstrapProfile({ cwd: emptyDir });

      assert.equal(result.profile.workspace_kind, 'empty');
      assert.notEqual(result.profile.confidence, 'high');
      assert.ok(result.profile.gaps.includes('project intent is not documented yet'));
      assert.ok(result.profile.summary.includes('empty workspace'));
      assert.ok((result.importPlan.interview?.question_count ?? 0) >= 4);
      assert.ok(result.importPlan.interview?.questions.some((question) => question.audience === 'cli'));
      assert.ok(result.importPlan.interview?.questions.some((question) => question.audience === 'ide_chat'));
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('adds a selective import interview prompt when native instruction files exist', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Existing Workspace\n\n## Build\n\n- npm run build\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), '# Claude Guidance\n\n- Read native instructions first\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      scripts: { build: 'npm run build' },
    }, null, 2), 'utf-8');

    const result = runBootstrapProfile({ cwd: workspace.dir });

    assert.equal(result.profile.workspace_kind, 'existing');
    assert.ok((result.importPlan.interview?.question_count ?? 0) > 0);
    assert.ok(result.importPlan.interview?.questions.some((question) =>
      question.audience === 'ide_chat' && question.prompt.includes('CLAUDE.md')));
  });

  it('reuses a valid profile and refresh replaces previous seeds', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# First Readme\n\n## Run\n\n- npm start\n', 'utf-8');

    const first = runBootstrapProfile({ target: 'src/api', cwd: workspace.dir });
    const firstIds = first.seeds.map((seed) => seed.id).sort();
    const second = runBootstrapProfile({ target: 'src/api', cwd: workspace.dir });
    assert.equal(second.reusedProfile, true);
    assert.deepEqual(second.seeds.map((seed) => seed.id).sort(), firstIds);

    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Second Readme\n\n## Build\n\n- npm run build\n', 'utf-8');
    const refreshed = runBootstrapProfile({ target: 'src/api', cwd: workspace.dir, refresh: true });
    const refreshedTexts = refreshed.seeds.map((seed) => seed.text);
    assert.equal(refreshed.reusedProfile, false);
    assert.ok(refreshedTexts.some((text) => text.includes('Build guidance') || text.includes('"build" script')));
    assert.ok(refreshed.seeds.every((seed) => !firstIds.includes(seed.id)));
  });

  it('uses git when available to capture fingerprint and hotspots', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Git Repo\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }, null, 2), 'utf-8');
    fs.mkdirSync(path.join(workspace.dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf-8');

    spawnSync('git', ['init'], { cwd: workspace.dir, encoding: 'utf-8' });
    spawnSync('git', ['add', '.'], { cwd: workspace.dir, encoding: 'utf-8' });
    spawnSync('git', ['-c', 'user.name=brainclaw', '-c', 'user.email=brainclaw@example.com', 'commit', '-m', 'init'], {
      cwd: workspace.dir,
      encoding: 'utf-8',
    });
    fs.writeFileSync(path.join(workspace.dir, 'src', 'auth.ts'), 'export const auth = false;\n', 'utf-8');
    spawnSync('git', ['add', 'src/auth.ts'], { cwd: workspace.dir, encoding: 'utf-8' });
    spawnSync('git', ['-c', 'user.name=brainclaw', '-c', 'user.email=brainclaw@example.com', 'commit', '-m', 'touch auth'], {
      cwd: workspace.dir,
      encoding: 'utf-8',
    });

    const result = runBootstrapProfile({ cwd: workspace.dir });

    assert.equal(result.profile.git_available, true);
    assert.ok(typeof result.profile.repo_fingerprint === 'string' && result.profile.repo_fingerprint.length > 0);
    assert.ok(result.seeds.some((seed) => seed.seed_kind === 'hotspot' && seed.source_kind === 'git'));
  });

  it('applies bootstrap suggestions as instructions and can uninstall the last import', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Existing Workspace\n\n## Build\n\n- npm run build\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), '# Claude Rules\n\n- Check native instructions before editing\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Rules\n\n- Read memory first\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      scripts: { build: 'npm run build' },
    }, null, 2), 'utf-8');

    const applied = applyBootstrapImport({ cwd: workspace.dir, refresh: true });
    assert.ok(applied.createdCount > 0);
    assert.ok(applied.receipt);

    const instructionsAfterApply = loadInstructions(workspace.dir).filter((entry) => entry.active);
    assert.ok(instructionsAfterApply.some((entry) => entry.tags.includes('bootstrap-import')));
    assert.equal(loadBootstrapApplication(workspace.dir)?.managed_artifacts.length, applied.createdCount);

    const uninstalled = uninstallBootstrapImport(workspace.dir);
    assert.equal(uninstalled.deactivatedCount, applied.createdCount);
    assert.equal(loadBootstrapApplication(workspace.dir)?.uninstalled_at !== undefined, true);
    const instructionsAfterUninstall = loadInstructions(workspace.dir).filter((entry) => entry.active);
    assert.ok(instructionsAfterUninstall.every((entry) => !entry.tags.includes('bootstrap-import')));
  });

  it('turns interview answers into selective memory imports beyond instructions', () => {
    const base = runBootstrapProfile({ cwd: workspace.dir, refresh: true });
    const interview = base.importPlan.interview;
    assert.ok(interview);
    const firstQuestion = interview!.questions[0];
    const secondQuestion = interview!.questions[1] ?? interview!.questions[0];
    assert.ok(firstQuestion && secondQuestion);

    const interviewAnswers = [
      {
        question_id: firstQuestion.id,
        response_items: [],
        suggestions: [
          {
            target: 'decision' as const,
            text: 'Project intent: Build a local-first agent coordination layer for brownfield repositories.',
            tags: ['bootstrap'],
          },
          {
            target: 'instruction' as const,
            text: 'Load Brainclaw context, inspect claims, then review the target path before editing.',
            layer: 'global' as const,
            tags: ['bootstrap'],
          },
        ],
      },
      {
        question_id: secondQuestion.id,
        response_items: [],
        suggestions: [
          {
            target: 'constraint' as const,
            text: 'Use Codex and Claude Code sequentially in one checkout.',
            category: 'process' as const,
            tags: ['workflow'],
          },
          {
            target: 'trap' as const,
            text: 'Do not run multiple coding agents in the same checkout in parallel.',
            severity: 'high' as const,
            tags: ['workflow'],
          },
        ],
      },
    ];

    const preview = runBootstrapProfile({ cwd: workspace.dir, interviewAnswers });
    assert.ok((preview.importPlan.confirmed_suggestion_count ?? 0) >= 4);
    assert.ok(preview.importPlan.suggestions.some((suggestion) => suggestion.target === 'decision'));
    assert.ok(preview.importPlan.suggestions.some((suggestion) => suggestion.target === 'constraint'));
    assert.ok(preview.importPlan.suggestions.some((suggestion) => suggestion.target === 'instruction'));
    assert.ok(preview.importPlan.suggestions.some((suggestion) => suggestion.target === 'trap'));

    const applied = applyBootstrapImport({ cwd: workspace.dir, interviewAnswers });
    assert.ok(applied.createdCount >= 4);
    assert.ok(applied.receipt);

    const stateAfterApply = loadState(workspace.dir);
    const instructionsAfterApply = loadInstructions(workspace.dir).filter((entry) => entry.active);
    assert.ok(stateAfterApply.recent_decisions.some((entry) => entry.text.includes('Project intent:')));
    assert.ok(stateAfterApply.active_constraints.some((entry) => entry.text.includes('Use Codex and Claude Code sequentially')));
    assert.ok(stateAfterApply.known_traps.some((entry) => entry.text.includes('Do not run multiple coding agents')));
    assert.ok(instructionsAfterApply.some((entry) => entry.text.includes('Load Brainclaw context')));

    const uninstalled = uninstallBootstrapImport(workspace.dir);
    assert.ok(uninstalled.deactivatedCount >= 1);
    assert.ok(uninstalled.deletedCount >= 3);
    const stateAfterUninstall = loadState(workspace.dir);
    assert.equal(stateAfterUninstall.recent_decisions.length, 0);
    assert.equal(stateAfterUninstall.active_constraints.length, 0);
    assert.equal(stateAfterUninstall.known_traps.length, 0);
    assert.ok(loadInstructions(workspace.dir).every((entry) => !entry.active || !entry.tags.includes('bootstrap-import')));
  });
});
