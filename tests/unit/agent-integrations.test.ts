import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../../src/core/config.js';
import { assessAgentIntegrationReadiness, buildAgentIntegrationDeclaration, upsertAgentIntegrationDeclaration } from '../../src/core/agent-integrations.js';

describe('core/agent-integrations', () => {
  it('builds default agent declarations with expected surfaces', () => {
    const declaration = buildAgentIntegrationDeclaration('windsurf', 'detected');

    assert.equal(declaration.agent_name, 'windsurf');
    assert.equal(declaration.declaration_source, 'detected');
    assert.ok(declaration.surfaces.some((surface) => surface.kind === 'instructions' && surface.location === 'workspace'));
    assert.ok(declaration.surfaces.some((surface) => surface.kind === 'mcp' && surface.location === 'machine'));
  });

  it('upserts declarations idempotently and upgrades source to manual when needed', () => {
    const config = defaultConfig('brainclaw');

    const first = upsertAgentIntegrationDeclaration(config, 'cursor', 'detected');
    const second = upsertAgentIntegrationDeclaration(config, 'cursor', 'detected');
    const third = upsertAgentIntegrationDeclaration(config, 'cursor', 'manual');

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(third, true);
    assert.equal(config.agent_integrations.declarations.length, 1);
    assert.equal(config.agent_integrations.declarations[0]?.declaration_source, 'manual');
  });

  it('assesses workspace and machine-local readiness from declared surfaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-int-readiness-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-int-home-'));
    try {
      const config = defaultConfig('brainclaw');
      upsertAgentIntegrationDeclaration(config, 'windsurf', 'manual');
      fs.mkdirSync(path.join(dir, '.windsurfrules'), { recursive: true });
      fs.rmSync(path.join(dir, '.windsurfrules'), { recursive: true, force: true });
      fs.writeFileSync(path.join(dir, '.windsurfrules'), '# rules', 'utf-8');

      const readinessBefore = assessAgentIntegrationReadiness(config, dir, { ...process.env, HOME: homeDir, USERPROFILE: homeDir });
      assert.equal(readinessBefore[0]?.ready, false);
      assert.ok(readinessBefore[0]?.missing_surfaces.some((surface) => surface.location === 'machine'));

      fs.mkdirSync(path.join(homeDir, '.codeium', 'windsurf'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'), '{}', 'utf-8');
      const readinessAfter = assessAgentIntegrationReadiness(config, dir, { ...process.env, HOME: homeDir, USERPROFILE: homeDir });
      assert.equal(readinessAfter[0]?.ready, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});