/**
 * Gèle la surface publiée des outils MIGRÉS vers des schémas zod-dérivés — DESCRIPTIONS
 * INCLUSES.
 *
 * ── POURQUOI CE TEST EXISTE, ALORS QUE TROIS GARDES EXISTENT DÉJÀ ─────────────
 * Aucune des gardes en place ne peut voir une dérive de description :
 *
 *   - `mcp-governance.test.ts` calcule un fingerprint de la surface publique en
 *     RETIRANT les descriptions avant de hacher. C'est délibéré — il mesure la forme du
 *     contrat, pas sa prose — mais cela le rend aveugle à une description qui change.
 *   - `mcp-zod-parity.test.ts` ne compare que `LoopPhase` et `LoopSlotInput` au regen.
 *   - `cli-registry-snapshot.test.ts` mesure la surface CLI, plus faible encore ; s'y
 *     fier pour affirmer qu'une migration MCP est transparente a déjà produit trois
 *     changements de surface non détectés (PR #220/#221).
 *
 * Or la description EST du contrat pour un agent : c'est ce sur quoi il décide d'appeler
 * l'outil, avec quelles valeurs. La perdre en migrant est une régression silencieuse.
 *
 * ── CE QUE CE TEST GÈLE, ET CE QU'IL NE GÈLE PAS ──────────────────────────────
 * Il fige l'inputSchema COMPLET des outils déjà migrés. Il ne dit rien des outils encore
 * écrits à la main : les y ajouter au fil des migrations est précisément le geste qui rend
 * la protection cumulative.
 *
 * Faire bouger une empreinte ici est autorisé — mais alors c'est un CHANGEMENT DE SURFACE
 * assumé, qui va au CHANGELOG, pas un effet de bord de migration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ALL_TOOLS } from '../../src/commands/mcp-catalog.js';

type CatalogTool = (typeof ALL_TOOLS)[number];

/** Tri récursif des clés : l'ordre d'écriture ne doit pas faire bouger l'empreinte. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function fingerprint(schema: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortDeep(schema))).digest('hex').slice(0, 16);
}

/**
 * Empreintes relevées le 2026-08-08, chacune vérifiée byte-à-byte contre la version
 * ÉCRITE À LA MAIN qu'elle remplace au moment de sa migration.
 */
const FROZEN: Record<string, string> = {
  bclaw_write_note: '91d4fd83c3e2c59a',
  bclaw_quick_capture: '36c6de26f785f4b7',
  bclaw_create_sequence: '4278ba272e8e09c6',
  bclaw_update_sequence: '16c8e6f4a56aaf7a',
  bclaw_claim: '537ea24835d11dfc',
  bclaw_release_claim: '22d1c714107d7acf',
  bclaw_session_start: '377ccbb6f7ba3e14',
  bclaw_session_end: '3c841e0a0b35dc8f',
  bclaw_add_step: '052d645ce0f1cd70',
  bclaw_update_step: '3d8b70b69ab46400',
  bclaw_complete_step: 'acf4a9be6fa290af',
  bclaw_delete_step: '089307e943dd2560',
  bclaw_assignment_update: '09f79cae4c5300a3',
  bclaw_assignment_action: 'ebb8c9b7f0c64024',
  bclaw_assignment_events: '1b0939883047c847',
};

describe('MCP migrated surface freeze — descriptions incluses', () => {
  it('chaque outil migré est présent dans le catalogue', () => {
    const names = new Set<string>(ALL_TOOLS.map((t: CatalogTool) => t.name));
    for (const name of Object.keys(FROZEN)) {
      assert.ok(names.has(name), `${name} a disparu du catalogue MCP`);
    }
  });

  it("l'inputSchema d'un outil migré ne bouge pas sans décision explicite", () => {
    const drift: string[] = [];
    for (const [name, expected] of Object.entries(FROZEN)) {
      const tool = ALL_TOOLS.find((t: CatalogTool) => t.name === name);
      assert.ok(tool, `${name} introuvable`);
      const actual = fingerprint(tool.inputSchema);
      if (expected && actual !== expected) drift.push(`${name}: attendu ${expected}, obtenu ${actual}`);
    }
    assert.deepEqual(
      drift,
      [],
      `Surface migrée modifiée. Si c'est voulu, mettre à jour FROZEN ET le CHANGELOG — ` +
        `le fingerprint de gouvernance ne verra PAS ce changement s'il ne porte que sur ` +
        `des descriptions.\n${drift.join('\n')}`,
    );
  });

  it('aucun outil migré ne réintroduit additionalProperties: false à la racine', () => {
    // Le durcissement le plus facile à commettre : zod l'émet d'office et il rejette des
    // appels qui passaient. Cf. scripts/build-mcp-schemas.mjs, OPEN_SCHEMAS.
    const hardened = Object.keys(FROZEN).filter((name) => {
      const tool = ALL_TOOLS.find((t: CatalogTool) => t.name === name);
      return (tool?.inputSchema as { additionalProperties?: unknown })?.additionalProperties === false;
    });
    assert.deepEqual(hardened, [], `additionalProperties:false réintroduit sur : ${hardened.join(', ')}`);
  });
});
