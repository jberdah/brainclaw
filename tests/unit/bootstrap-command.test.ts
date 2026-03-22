import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBootstrap } from '../../src/commands/bootstrap.js';
import { loadBootstrapApplication } from '../../src/core/bootstrap.js';
import { loadInstructions } from '../../src/core/instructions.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

async function captureConsole(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  try {
    await fn();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('commands/bootstrap', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-bootstrap-command-',
      projectId: 'prj_bootstrap_command',
    });
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Bootstrap Command\n\n## Test\n\n- npm test\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Guide\n\n- Read memory first\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      scripts: { test: 'npm test' },
    }, null, 2), 'utf-8');
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('emits JSON bootstrap output with seeds and reuse metadata', async () => {
    const first = await captureConsole(async () => {
      await runBootstrap({ json: true, cwd: workspace.dir, for: 'src/auth' });
    });
    assert.equal(first.errors.length, 0);
    const firstParsed = JSON.parse(first.logs.at(-1) as string);
    assert.equal(firstParsed.target, 'src/auth');
    assert.equal(firstParsed.reused_profile, false);
    assert.equal(firstParsed.workspace_kind, 'existing');
    assert.equal(firstParsed.confidence, 'high');
    assert.ok(Array.isArray(firstParsed.seeds));
    assert.ok(firstParsed.import_plan);
    assert.ok(firstParsed.seeds.some((seed: { source_kind: string }) => seed.source_kind === 'agents_md'));

    const second = await captureConsole(async () => {
      await runBootstrap({ json: true, cwd: workspace.dir, for: 'src/auth' });
    });
    const secondParsed = JSON.parse(second.logs.at(-1) as string);
    assert.equal(secondParsed.reused_profile, true);
  });

  it('applies and uninstalls the bootstrap import lifecycle', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), '# Claude Guidance\n\n- Read native instructions first\n', 'utf-8');

    const applied = await captureConsole(async () => {
      await runBootstrap({ apply: true, yes: true, refresh: true, cwd: workspace.dir });
    });
    assert.equal(applied.errors.length, 0);
    assert.ok(applied.logs.some((line) => line.includes('Bootstrap import applied:')));
    assert.ok(loadInstructions(workspace.dir).some((entry) => entry.active && entry.tags.includes('bootstrap-import')));
    assert.ok(loadBootstrapApplication(workspace.dir));

    const uninstalled = await captureConsole(async () => {
      await runBootstrap({ uninstall: true, yes: true, cwd: workspace.dir });
    });
    assert.equal(uninstalled.errors.length, 0);
    assert.ok(uninstalled.logs.some((line) => line.includes('Bootstrap uninstall completed:')));
    assert.ok(loadInstructions(workspace.dir).every((entry) => !entry.active || !entry.tags.includes('bootstrap-import')));
  });

  it('renders adaptive interview prompts for CLI and IDE chat audiences', async () => {
    fs.rmSync(path.join(workspace.dir, 'README.md'), { force: true });
    fs.rmSync(path.join(workspace.dir, 'AGENTS.md'), { force: true });
    fs.rmSync(path.join(workspace.dir, 'package.json'), { force: true });

    const cliInterview = await captureConsole(async () => {
      await runBootstrap({ interview: true, audience: 'cli', cwd: workspace.dir });
    });
    assert.equal(cliInterview.errors.length, 0);
    assert.ok(cliInterview.logs.join('\n').includes('Audience: cli'));
    assert.ok(cliInterview.logs.join('\n').includes('For a CLI-only agent'));

    const ideInterview = await captureConsole(async () => {
      await runBootstrap({ interview: true, audience: 'ide_chat', cwd: workspace.dir });
    });
    assert.equal(ideInterview.errors.length, 0);
    assert.ok(ideInterview.logs.join('\n').includes('Audience: ide_chat'));
    assert.ok(ideInterview.logs.join('\n').includes('For an IDE chat agent'));
  });

  it('loads interview answers from file and applies selective memory imports', async () => {
    fs.rmSync(path.join(workspace.dir, 'README.md'), { force: true });
    fs.rmSync(path.join(workspace.dir, 'AGENTS.md'), { force: true });
    fs.rmSync(path.join(workspace.dir, 'package.json'), { force: true });

    const preview = await captureConsole(async () => {
      await runBootstrap({ json: true, cwd: workspace.dir });
    });
    const previewParsed = JSON.parse(preview.logs.at(-1) as string);
    const interview = previewParsed.import_plan.interview as {
      questions: Array<{ id: string; prompt: string }>;
    };
    const projectIntent = interview.questions.find((question) => question.prompt.includes('trying to build in one sentence'));
    const workflow = interview.questions.find((question) => question.prompt.includes('Which coding agents do you expect to use here'));
    assert.ok(projectIntent && workflow);

    const answersPath = path.join(workspace.dir, 'bootstrap-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify([
      {
        question_id: projectIntent.id,
        response_text: 'Build a repo-local memory layer for coding agents.',
        response_items: [],
        suggestions: [],
      },
      {
        question_id: workflow.id,
        response_items: ['Use agents sequentially.', 'Record handoffs before switching agents.'],
        suggestions: [],
      },
    ], null, 2), 'utf-8');

    const enriched = await captureConsole(async () => {
      await runBootstrap({ json: true, cwd: workspace.dir, answersFile: answersPath });
    });
    const enrichedParsed = JSON.parse(enriched.logs.at(-1) as string);
    assert.ok((enrichedParsed.import_plan.confirmed_suggestion_count ?? 0) >= 2);
    assert.ok(enrichedParsed.import_plan.suggestions.some((suggestion: { target: string }) => suggestion.target === 'decision'));
    assert.ok(enrichedParsed.import_plan.suggestions.some((suggestion: { target: string }) => suggestion.target === 'constraint'));

    const applied = await captureConsole(async () => {
      await runBootstrap({ apply: true, yes: true, cwd: workspace.dir, answersFile: answersPath });
    });
    assert.equal(applied.errors.length, 0);
    assert.ok(applied.logs.some((line) => line.includes('Bootstrap import applied:')));
    const state = loadState(workspace.dir);
    assert.ok(state.recent_decisions.some((entry) => entry.text.includes('Project intent:')));
    assert.ok(state.active_constraints.some((entry) => entry.text.includes('Agent workflow expectation:')));
  });
});
