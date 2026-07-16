import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Phase 3 slice 3e + Sonnet review #3 — source-level guard checks.
 * Exercising the bclaw_correct_handoff handler end-to-end requires
 * the full MCP runtime (executeMcpToolCall + trust + auto-session).
 * Until that seam is extracted into a testable helper, pin the guard
 * logic at the source level.
 *
 * pln#622 PR4 — the handler moved from mcp.ts into mcp-write-entities.ts
 * (handleBclawCorrectHandoff); the scraper now reads its new home.
 */
describe('commands/mcp-write-entities — bclaw_correct_handoff guards', () => {
  const source = readFileSync(path.join('src', 'commands', 'mcp-write-entities.ts'), 'utf-8');

  it('refuses to supersede an already-superseded handoff', () => {
    // Guard literal: `if (original.superseded_by)` with an error response
    // pointing at the correction tip.
    assert.match(
      source,
      /if \(original\.superseded_by\)[\s\S]{0,200}Correct the current tip/,
      'double-supersede guard missing',
    );
  });

  it('refuses to supersede a handoff in a terminal status', () => {
    // Guard literal: ENTITY_REGISTRY.handoff.terminal lookup + error.
    assert.match(
      source,
      /ENTITY_REGISTRY\.handoff\.terminal\.includes\(original\.status\)/,
      'terminal-status guard missing',
    );
    assert.match(
      source,
      /Cannot supersede a closed handoff/,
      'terminal-status error message missing',
    );
  });

  it('generates a correction that sets supersedes and clears superseded_by', () => {
    // The correction record assignment must set supersedes and delete
    // any copied superseded_by so the two-way pointer is consistent.
    assert.match(
      source,
      /supersedes: originalId/,
      'correction must set supersedes pointer',
    );
    assert.match(
      source,
      /delete \(correction as Record<string, unknown>\)\.superseded_by/,
      'correction must drop inherited superseded_by',
    );
  });

  it('marks the original as superseded_by the new correction id', () => {
    assert.match(
      source,
      /original\.superseded_by = newId/,
      'original must be marked superseded_by the new id',
    );
  });
});
