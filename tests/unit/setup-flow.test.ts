import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeForQuickSetup, buildQuickSetupProbeResponse, resolveEmptyMemoryRecommendation, repoHasContent } from '../../src/core/setup-flow.js';

function tmpDir(prefix: string = 'bclaw-setup-flow-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
}

describe('setup-flow', () => {
  describe('probeForQuickSetup', () => {
    let dir: string;

    beforeEach(() => {
      dir = tmpDir();
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('detects an empty non-git directory', () => {
      const probe = probeForQuickSetup(dir);
      assert.equal(probe.isGitRepo, false);
      assert.equal(probe.alreadyInitialized, false);
      assert.equal(probe.hasContent, false);
    });

    it('detects a git repo with content', () => {
      initGitRepo(dir);
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test', 'utf-8');
      const probe = probeForQuickSetup(dir);
      assert.equal(probe.isGitRepo, true);
      assert.equal(probe.hasContent, true);
      assert.ok(probe.repoSummary.includes('git repo'));
    });

    it('detects already initialized project', () => {
      initGitRepo(dir);
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.brainclaw', 'config.yaml'), 'project_name: test\n', 'utf-8');
      const probe = probeForQuickSetup(dir);
      assert.equal(probe.alreadyInitialized, true);
    });

    it('defaults to standalone project type', () => {
      initGitRepo(dir);
      const probe = probeForQuickSetup(dir);
      // Without monorepo markers or nearby workspace stores, should suggest standalone
      assert.equal(probe.suggestedProjectType, 'standalone');
    });

    it('returns the directory basename as repoName', () => {
      const probe = probeForQuickSetup(dir);
      assert.equal(probe.repoName, path.basename(dir));
    });
  });

  describe('buildQuickSetupProbeResponse', () => {
    let dir: string;

    beforeEach(() => {
      dir = tmpDir();
      initGitRepo(dir);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns already_initialized for initialized projects', () => {
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.brainclaw', 'config.yaml'), 'project_name: test\n', 'utf-8');
      const probe = probeForQuickSetup(dir);
      const response = buildQuickSetupProbeResponse(probe);
      assert.ok(response.structured.already_initialized);
      assert.ok(response.text.includes('already initialized'));
    });

    it('returns pending_question quick_init for new projects', () => {
      const probe = probeForQuickSetup(dir);
      const response = buildQuickSetupProbeResponse(probe);
      assert.equal(response.structured.pending_question, 'quick_init');
      assert.ok(response.text.includes('What kind of project'));
      assert.ok(response.text.includes('shared with the team'));
    });

    it('includes project_type and topology in choices', () => {
      const probe = probeForQuickSetup(dir);
      const response = buildQuickSetupProbeResponse(probe);
      const choices = response.structured.choices as Record<string, string[]>;
      assert.ok(choices.project_type.includes('standalone'));
      assert.ok(choices.project_type.includes('workspace'));
      assert.ok(choices.topology.includes('embedded'));
      assert.ok(choices.topology.includes('sidecar'));
    });

    it('includes detected agent info in probe', () => {
      const probe = probeForQuickSetup(dir);
      const response = buildQuickSetupProbeResponse(probe);
      const probeData = response.structured.probe as Record<string, unknown>;
      assert.ok('detected_agent' in probeData);
      assert.ok('agent_surfaces' in probeData);
      assert.ok('repo_name' in probeData);
      assert.ok('suggested_project_type' in probeData);
    });

    it('includes nearby stores info', () => {
      const probe = probeForQuickSetup(dir);
      const response = buildQuickSetupProbeResponse(probe);
      const probeData = response.structured.probe as Record<string, unknown>;
      assert.ok(Array.isArray(probeData.nearby_stores));
    });
  });

  describe('resolveEmptyMemoryRecommendation — the shared empty-memory rule', () => {
    let dir: string;

    beforeEach(() => {
      dir = tmpDir('bclaw-empty-memory-');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('routes greenfield repos (only git/brainclaw plumbing) to the bootstrap loop', () => {
      initGitRepo(dir);
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
      assert.equal(repoHasContent(dir), false);
      const rec = resolveEmptyMemoryRecommendation(dir);
      assert.equal(rec.route, 'ideate');
      assert.equal(rec.mcp_next_action, "bclaw_coordinate(intent='ideate', preset='bootstrap')");
      assert.equal(rec.cli_next_action, 'brainclaw bootstrap-loop');
      assert.equal(rec.chained_mcp_action, 'bclaw_bootstrap()');
      assert.match(rec.text, /greenfield/);
    });

    it('routes repos with content to bclaw_bootstrap extraction', () => {
      fs.writeFileSync(path.join(dir, 'README.md'), '# hello', 'utf-8');
      assert.equal(repoHasContent(dir), true);
      const rec = resolveEmptyMemoryRecommendation(dir);
      assert.equal(rec.route, 'extract');
      assert.equal(rec.mcp_next_action, 'bclaw_bootstrap()');
      assert.equal(rec.cli_next_action, 'brainclaw bootstrap');
      assert.equal(rec.chained_mcp_action, "bclaw_coordinate(intent='ideate', preset='bootstrap')");
      assert.match(rec.text, /chain a bootstrap loop/);
    });
  });
});
