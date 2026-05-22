import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { listClaims } from '../../src/core/claims.js';
import { loadAllSessions } from '../../src/core/identity.js';
import { openLoop } from '../../src/core/loops/index.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

async function callTool(
  name: 'bclaw_loop' | 'bclaw_work',
  args: Record<string, unknown>,
  cwd: string,
): Promise<FacadeResponse> {
  const outcome = await executeMcpToolCall({ name, args, cwd });
  assert.equal(outcome.response.isError, false);
  return outcome.response.structuredContent as FacadeResponse;
}

describe('cross-project routing for facade tools', () => {
  let workspaceA: TestWorkspace;
  let workspaceB: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';

    workspaceA = createTestWorkspace({
      prefix: 'bclaw-xroute-a-',
      projectName: 'project-a',
      projectId: 'prj_xroute_a',
      currentAgent: 'codex',
    });
    workspaceB = createTestWorkspace({
      prefix: 'bclaw-xroute-b-',
      projectName: 'project-b',
      projectId: 'prj_xroute_b',
      currentAgent: 'codex',
    });

    const configA = loadConfig(workspaceA.dir);
    configA.cross_project_links = [{ path: workspaceB.dir, name: 'project-b', role: 'publisher' }];
    saveConfig(configA, workspaceA.dir);
    restoreCwd = workspaceA.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspaceB.cleanup();
    workspaceA.cleanup();
    if (previousTestMode === undefined) {
      delete process.env.BRAINCLAW_TEST_MODE;
      return;
    }
    process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('routes bclaw_loop and bclaw_work to project= target, while omitted project stays on caller cwd', async () => {
    const loopB = openLoop({ kind: 'research', title: 'target project loop', created_by: 'agt_b' }, workspaceB.dir);
    const routedLoopResponse = await callTool(
      'bclaw_loop',
      { intent: 'get', loop_id: loopB.id, project: 'project-b' },
      workspaceA.dir,
    );
    assert.equal(routedLoopResponse.status, 'ok');
    assert.equal((routedLoopResponse.result as { loop: { id: string } }).loop.id, loopB.id);

    const missingWithoutProject = await callTool(
      'bclaw_loop',
      { intent: 'get', loop_id: loopB.id },
      workspaceA.dir,
    );
    assert.equal(missingWithoutProject.status, 'error');
    assert.match(missingWithoutProject.error ?? '', /not_found/);

    const loopA = openLoop({ kind: 'research', title: 'source project loop', created_by: 'agt_a' }, workspaceA.dir);
    const localLoopResponse = await callTool(
      'bclaw_loop',
      { intent: 'get', loop_id: loopA.id },
      workspaceA.dir,
    );
    assert.equal(localLoopResponse.status, 'ok');
    assert.equal((localLoopResponse.result as { loop: { id: string } }).loop.id, loopA.id);

    const consultResponse = await callTool(
      'bclaw_work',
      { intent: 'consult', project: 'project-b', agent: 'codex' },
      workspaceA.dir,
    );
    assert.equal(consultResponse.status, 'ok');
    assert.ok(
      loadAllSessions(workspaceB.dir).some((session) => session.session_id === consultResponse.session_id),
      'project-routed consult session should be stored in B',
    );
    assert.equal(
      loadAllSessions(workspaceA.dir).some((session) => session.session_id === consultResponse.session_id),
      false,
      'project-routed consult session should not be stored in A',
    );

    const executeResponse = await callTool(
      'bclaw_work',
      { intent: 'execute', scope: 'src/target.ts', task: 'target claim', project: 'project-b', agent: 'codex' },
      workspaceA.dir,
    );
    assert.equal(executeResponse.status, 'ok');
    assert.equal(executeResponse.claim_status, 'created');
    const targetClaimId = executeResponse.side_effects[0]?.id;
    assert.ok(targetClaimId);
    assert.ok(
      listClaims(workspaceB.dir).some((claim) => claim.id === targetClaimId && claim.scope === 'src/target.ts'),
      'project-routed execute claim should be stored in B',
    );
    assert.equal(
      listClaims(workspaceA.dir).some((claim) => claim.id === targetClaimId),
      false,
      'project-routed execute claim should not be stored in A',
    );

    const localWorkResponse = await callTool(
      'bclaw_work',
      { intent: 'consult', agent: 'codex' },
      workspaceA.dir,
    );
    assert.equal(localWorkResponse.status, 'ok');
    assert.ok(
      loadAllSessions(workspaceA.dir).some((session) => session.session_id === localWorkResponse.session_id),
      'work without project should store its session in A',
    );
  });
});
