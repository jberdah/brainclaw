/**
 * ⚠ TEMPORAIRE — échafaudage de campagne pln#622, actif PR1→PR5, RETIRÉ en
 * PR6 ; ne pas pérenniser : la politique produit permanente est le test de
 * concepts, pas l'égalité byte-for-byte.
 *
 * (TEMPORARY — pln#622 campaign scaffolding, active PR1→PR5, REMOVED in PR6;
 * do not keep this beyond the campaign: the permanent product policy is the
 * concept test, not byte-for-byte equality.)
 *
 * Why it exists: the MCP governance fingerprint deliberately EXCLUDES tool
 * descriptions (see stripDescriptions in tests/unit/mcp-governance.test.ts),
 * so while mcp.ts is being decomposed, a silent mangling of a tool
 * description would sail through governance unnoticed. This test freezes the
 * name → sha256(description) map of PUBLISHED_TOOLS against a committed
 * snapshot for the duration of the campaign.
 *
 * To INTENTIONALLY change a tool description, regenerate the snapshot and
 * commit it alongside your change:
 *
 *   UPDATE_MCP_DESCRIPTIONS_SNAPSHOT=1 node --test dist-test/tests/unit/mcp-description-freeze.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLISHED_TOOLS } from '../../src/commands/mcp.js';

// Compiled test lives at dist-test/tests/unit/ → repo root is 3 levels up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'mcp-descriptions.snapshot.json');
const REGEN_HINT =
  'To intentionally accept the new description(s), regenerate and commit the snapshot:\n' +
  '  UPDATE_MCP_DESCRIPTIONS_SNAPSHOT=1 node --test dist-test/tests/unit/mcp-description-freeze.test.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** name → sha256(description), keys sorted by codepoint so the file is canonical. */
function currentDescriptionMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const tools = [...PUBLISHED_TOOLS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const tool of tools) {
    const description = (tool as { description?: unknown }).description;
    assert.equal(
      typeof description,
      'string',
      `published tool "${tool.name}" has no string description`,
    );
    map[tool.name] = sha256(description as string);
  }
  return map;
}

describe('MCP description freeze (pln#622 campaign scaffolding — TEMPORARY)', () => {
  it('matches the committed name → sha256(description) snapshot', () => {
    const actual = currentDescriptionMap();

    // Sanity: an empty map must never be accepted as a baseline.
    assert.ok(
      Object.keys(actual).length >= 20,
      `only ${Object.keys(actual).length} published tools found — import broken?`,
    );

    if (process.env.UPDATE_MCP_DESCRIPTIONS_SNAPSHOT === '1') {
      fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + '\n', 'utf-8');
      console.log(
        `mcp-descriptions snapshot rewritten: ${SNAPSHOT_PATH} (${Object.keys(actual).length} tools)`,
      );
      return;
    }

    assert.ok(
      fs.existsSync(SNAPSHOT_PATH),
      `Missing baseline snapshot ${SNAPSHOT_PATH}.\n${REGEN_HINT}`,
    );
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8')) as Record<string, string>;

    const drift: string[] = [];
    for (const name of Object.keys(actual)) {
      if (!(name in expected)) drift.push(`  + tool added:               ${name}`);
      else if (expected[name] !== actual[name]) drift.push(`  ~ description changed:      ${name}`);
    }
    for (const name of Object.keys(expected)) {
      if (!(name in actual)) drift.push(`  - tool removed:             ${name}`);
    }

    if (drift.length > 0) {
      assert.fail(
        'MCP tool descriptions drifted from the frozen pln#622 baseline (the governance\n' +
          'fingerprint ignores descriptions, so this freeze is the only guard during the campaign):\n' +
          `${drift.join('\n')}\n${REGEN_HINT}`,
      );
    }
  });
});
