/**
 * Security scan parity across write paths (pln#623 S2).
 *
 * The CLI write adapters (commands/{constraint,decision,plan,…}.ts) scan their
 * text through scanText and refuse the write on a `block` verdict. The MCP write
 * adapters historically did NOT scan at all, so an agent could write
 * secret-bearing content via MCP that the CLI would have blocked. S2 routes the
 * MCP path through the same detection via the shared control point
 * `scanMcpWriteText` (mcp-write-support.ts), which every MCP write handler now
 * calls before persisting.
 *
 * This matrix pins:
 *   1. the shared control point (scanMcpWriteText) — clean / warn / block / no-config;
 *   2. the response decorator (appendSecurityWarnings) — pure, no-op on empty;
 *   3. PARITY — the MCP control point sees exactly what the CLI's scanText sees
 *      for the same text (it wraps the identical detector, so a secret blocked
 *      on the CLI is blocked on MCP and vice-versa).
 *
 * Handler-level wiring (each write handler calls scanMcpWriteText before the
 * write) is additionally exercised end-to-end by tests/mcp.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { scanText } from '../../src/core/security.js';
import { scanMcpWriteText, appendSecurityWarnings } from '../../src/commands/mcp-write-support.js';
import type { McpToolResponse } from '../../src/commands/mcp-contract.js';

/** A valid .brainclaw store cwd (default config), optionally in strict-redaction mode. */
function makeStore(strict = false): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-sec-parity-'));
  ensureMemoryDir(cwd);
  const config = defaultConfig('test-project', { projectId: 'prj_sec_parity' });
  if (strict && config.security) {
    config.security.strict_redaction = true;
  }
  saveConfig(config, cwd);
  return cwd;
}

// A real GitHub PAT shape (ghp_ + 36 chars) — matches the github_pat structural detector.
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const CLEAN = 'A perfectly ordinary planning note about the roadmap.';

describe('security scan parity — MCP write path (pln#623 S2)', () => {
  describe('scanMcpWriteText — shared control point', () => {
    it('returns nothing for clean text', () => {
      const cwd = makeStore();
      const r = scanMcpWriteText(CLEAN, cwd);
      assert.equal(r.blockResponse, undefined);
      assert.equal(r.warnings.length, 0);
    });

    it('surfaces warnings (no block) for a secret in warn mode', () => {
      const cwd = makeStore();
      const r = scanMcpWriteText(`deploy with ${SECRET}`, cwd);
      assert.equal(r.blockResponse, undefined, 'warn mode must not block');
      assert.ok(r.warnings.length >= 1, 'the secret must surface a warning');
      for (const m of r.warnings) assert.ok(!m.includes(SECRET), `warning leaks the secret: ${m}`);
    });

    it('returns a block response for a secret under strict_redaction', () => {
      const cwd = makeStore(true);
      const r = scanMcpWriteText(`deploy with ${SECRET}`, cwd);
      assert.ok(r.blockResponse, 'strict mode must produce a block response');
      assert.equal(r.blockResponse!.isError, true);
      assert.equal((r.blockResponse!.structuredContent as { error?: string }).error, 'security_block');
      for (const c of r.blockResponse!.content) assert.ok(!c.text.includes(SECRET), 'block message leaks the secret');
    });

    it('is graceful (no throw, no findings) when there is no store/config', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-sec-nostore-'));
      const r = scanMcpWriteText(`deploy with ${SECRET}`, cwd);
      assert.equal(r.blockResponse, undefined);
      assert.equal(r.warnings.length, 0);
    });
  });

  describe('appendSecurityWarnings — response decorator', () => {
    const base: McpToolResponse = { content: [{ type: 'text', text: '✔ done' }], structuredContent: { id: 'x1' }, isError: false };

    it('is a no-op when there are no warnings (clean writes stay identical)', () => {
      const out = appendSecurityWarnings(base, []);
      assert.equal(out, base);
    });

    it('appends a warning content block + structured field when warnings exist', () => {
      const out = appendSecurityWarnings(base, ['Sensitive path .env mentioned']);
      assert.equal(out.content.length, 2);
      assert.match(out.content[1]!.text, /security: Sensitive path \.env/);
      assert.deepEqual((out.structuredContent as { security_warnings?: string[] }).security_warnings, ['Sensitive path .env mentioned']);
      // original preserved
      assert.equal((out.structuredContent as { id?: string }).id, 'x1');
    });
  });

  describe('CLI ↔ MCP detection parity', () => {
    it('the MCP control point sees exactly what the CLI scanText sees (same text)', () => {
      const cwd = makeStore();
      const config = loadConfig(cwd);
      const cliFindings = scanText(`deploy with ${SECRET}`, config); // what the CLI adapters call
      const mcp = scanMcpWriteText(`deploy with ${SECRET}`, cwd);     // what the MCP adapters call
      assert.equal(mcp.warnings.length, cliFindings.length, 'MCP must surface the same number of findings as the CLI');
      assert.deepEqual(mcp.warnings, cliFindings.map((w) => w.message), 'MCP messages must match the CLI findings verbatim');
    });

    it('a secret blocked on the CLI (strict) is blocked on MCP (strict)', () => {
      const cwd = makeStore(true);
      const config = loadConfig(cwd);
      const cliBlocks = scanText(`deploy with ${SECRET}`, config).some((w) => w.level === 'block');
      const mcpBlocks = Boolean(scanMcpWriteText(`deploy with ${SECRET}`, cwd).blockResponse);
      assert.equal(mcpBlocks, cliBlocks, 'block decision must match across adapters');
      assert.ok(mcpBlocks, 'both must block this secret under strict');
    });
  });
});
