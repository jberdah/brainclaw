/**
 * pln#598 étape 4 — couverture de `next_actions`, GELÉE plutôt que PLANCHONNÉE.
 *
 * ── POURQUOI CE TEST N'EST PAS CELUI QUE L'ÉTAPE DEMANDAIT ────────────────────
 * L'étape demandait « un test assertant next_actions NON VIDE sur les outils standard+ ».
 * Or `src/core/next-actions.ts` porte une règle de conception qui dit l'inverse :
 *
 *   « chaque builder prend le VRAI outcome et rend [] quand il n'y a pas de suite
 *     genuine. Il n'y a délibérément PAS de tables statiques par outil : une action qui
 *     ne découle pas de ce qui s'est réellement passé est du BRUIT, et le bruit apprend
 *     aux agents à ignorer le champ — ce qui est strictement pire qu'un champ absent. »
 *
 * Un plancher de couverture pousserait vers exactement ce que la règle interdit. Ce
 * fichier fait donc l'inverse utile : il FIGE la couverture observée. Une régression —
 * un outil qui cesse d'émettre — devient visible, sans qu'on impose un champ là où il n'a
 * rien à dire.
 *
 * ── CE QUE LA MESURE A CORRIGÉ ────────────────────────────────────────────────
 * L'en-tête de `next-actions.ts` affirme que `bclaw_read_inbox` émet des next_actions.
 * Mesuré ici, il n'en émet PAS — ni sur une inbox vide, ni avec un message. Le
 * commentaire décrit une intention, pas le comportement.
 *
 * L'étape citait aussi « 1 seule occurrence dans mcp-read-handlers.ts » : il y en a 40
 * dans src/, dont 2 dans ce fichier. La prémisse avait dérivé.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * Couverture OBSERVÉE le 2026-08-08, chaque outil mesuré dans un workspace NEUF.
 *
 * Le workspace neuf n'est pas un détail : le premier appel d'un workspace paie le
 * démarrage de session, et mesurer plusieurs outils à la suite compare des états
 * différents (piège rencontré sur l'étape 1 de ce même plan).
 *
 * `true`  = l'outil émet une suite sur ce scénario ;
 * `false` = il n'en émet pas, et c'est ACCEPTÉ — pas un défaut à corriger d'office.
 */
const OBSERVED_COVERAGE: Array<[string, Record<string, unknown>, boolean]> = [
  ['bclaw_find', { entity: 'trap' }, true],
  // MESURÉ à false APRÈS correction. Avant elle, `search` rendait `next_actions: []` —
  // la clé était présente, donc une sonde naïve le comptait comme « émet ». C'est ce
  // fichier qui a révélé l'écart, et la règle du module dit d'omettre la clé.
  ['bclaw_search', { query: 'x' }, false],
  ['bclaw_quick_capture', { text: 'une capture' }, true],
  ['bclaw_work', { intent: 'consult' }, true],
  ['bclaw_context', { kind: 'memory' }, false],
  ['bclaw_write_note', { text: 'une note' }, false],
  ['bclaw_session_start', { agent: 'codex' }, false],
  ['bclaw_read_inbox', {}, false],
];

let ws: TestWorkspace;

beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-nextactions-' }); });
afterEach(() => { ws.cleanup(); });

async function emitsNextActions(name: string, args: Record<string, unknown>): Promise<boolean> {
  const outcome = await executeMcpToolCall({ name, args, cwd: ws.dir });
  assert.equal(outcome.response.isError, false, `${name} a renvoyé une erreur — la mesure ne vaut rien`);
  return JSON.stringify(outcome.response).includes('"next_actions"');
}

describe('next_actions — la couverture est gelée, pas plancheée', () => {
  for (const [name, args, expected] of OBSERVED_COVERAGE) {
    it(`${name} ${expected ? 'ÉMET' : "n'émet pas"} de next_actions`, async () => {
      const actual = await emitsNextActions(name, args);
      assert.equal(
        actual,
        expected,
        actual
          ? `${name} ÉMET désormais des next_actions alors que la couverture gelée dit non.`
            + ' Si c\'est voulu — un vrai follow-up a été ajouté — mets-le à true ici.'
          : `${name} N'ÉMET PLUS de next_actions alors qu'il le faisait.`
            + ' C\'est une RÉGRESSION probable : un agent qui suivait ce guidage ne l\'a plus.',
      );
    });
  }

  it('au moins un outil en émet — sinon le gel ne garde rien', async () => {
    // Garde du garde : si toute la couverture tombait à false, chaque assertion
    // ci-dessus passerait et le fichier féliciterait une surface muette.
    assert.ok(
      OBSERVED_COVERAGE.some(([, , expected]) => expected),
      'la couverture gelée ne contient plus aucun émetteur',
    );
  });
});

describe('next_actions — la règle de conception est respectée', () => {
  it('une suite émise n’est jamais un tableau VIDE', async () => {
    // La règle dit : rendre [] quand il n'y a pas de suite genuine, et OMETTRE la clé.
    // Un tableau vide présent serait le pire des deux mondes — le champ existe, ne dit
    // rien, et apprend quand même à l'ignorer.
    for (const [name, args, expected] of OBSERVED_COVERAGE) {
      if (!expected) continue;
      const outcome = await executeMcpToolCall({ name, args, cwd: ws.dir });
      const serialized = JSON.stringify(outcome.response);
      assert.ok(
        !serialized.includes('"next_actions":[]'),
        `${name} émet un next_actions VIDE — la clé doit être omise, pas rendue vide`,
      );
    }
  });
});
