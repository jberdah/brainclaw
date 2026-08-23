import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_TOOLS } from '../../src/commands/mcp-catalog.js';

describe('published bclaw_loop contract', () => {
  it('describes real dispatch, full fencing, CAS and idempotency truthfully', () => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === 'bclaw_loop');
    assert.ok(tool);
    const properties = (tool.inputSchema as {
      properties: Record<string, { description?: string }>;
    }).properties;
    assert.match(properties.dispatch?.description ?? '', /real worker launch|production driver/);
    assert.match(properties.dry_run?.description ?? '', /bind never spawns/);
    assert.match(properties.lanes?.description ?? '', /ignored/);
    assert.match(properties.max_assignments?.description ?? '', /ignored/);
    for (const field of [
      'turn_id', 'assignment_id', 'run_id', 'nonce', 'attempt_epoch',
      'execution_contract_hash', 'workspace_digest',
    ]) {
      assert.ok(properties[field], `missing complete_turn fence field ${field}`);
    }
    assert.match(properties.expected_version?.description ?? '', /enforced|CAS/);
    assert.doesNotMatch(properties.expected_version?.description ?? '', /not enforced/);
    assert.match(properties.client_request_id?.description ?? '', /Idempotency key enforced/);
    assert.doesNotMatch(properties.client_request_id?.description ?? '', /not enforced/);
  });
});
