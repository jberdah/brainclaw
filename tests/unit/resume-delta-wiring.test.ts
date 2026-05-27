import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Phase 4 Sprint 1 Lane A step 5 — pin the resume→sinceSession wiring
 * in bclaw_work. Exercising the full MCP path end-to-end requires the
 * session + context + policy stack. Until a thin seam is extracted,
 * keep a source-level regression guard so the branch is not accidentally
 * reverted.
 */
describe('commands/mcp — bclaw_work(intent="resume") auto-delta', () => {
  const source = readFileSync(path.join('src', 'commands', 'mcp.ts'), 'utf-8');

  it('resume branch computes sinceSession from previous agent session', () => {
    // Guard the exact wiring: when intent === 'resume', find previous
    // session for the same agent and pass its session_id as sinceSession.
    assert.match(
      source,
      /if \(workReq\.intent === 'resume'\)[\s\S]{0,200}loadAllSessions\(\w+\)[\s\S]{0,200}sinceSession = previousSession\?\.session_id/,
      'resume intent must look up previous session and set sinceSession',
    );
  });

  it('buildContext receives sinceSession in the work facade', () => {
    // The call sites passes sinceSession as an option. Matches
    // session-start.ts:91 pattern.
    assert.match(
      source,
      /contextResult = buildContext\([\s\S]{0,300}sinceSession,/,
      'buildContext in bclaw_work must pass sinceSession',
    );
  });
});
