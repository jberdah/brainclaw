/**
 * pln#626 phase 4 — le drapeau `dispatch` du tour est SUPPRIMÉ, pas neutralisé.
 *
 * CE QUI ÉTAIT FAUX. `TurnInput.dispatch` était déclaré dans le type, transporté depuis
 * le handler MCP jusqu'à `turn()`, et protégé par une porte de confiance au barreau
 * `trusted`. Il n'était JAMAIS LU.
 *
 * Une porte de confiance sur un no-op est PIRE qu'une porte absente : elle fait croire
 * qu'un chemin sensible est gardé. Un lecteur qui la voit en conclut que `dispatch: true`
 * a un effet — et un auditeur qui cherche « qu'est-ce qui spawne ? » la compte comme une
 * surface de dispatch réelle. Le plan le dit sans détour : « Trust-gater un no-op est
 * trompeur. »
 *
 * CE QUE CE FICHIER VERROUILLE : la suppression, et le fait que la porte de `bind` —
 * qui, elle, spawne de vrais workers — SURVIT. Retirer les deux aurait été le vrai
 * accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Le test COMPILÉ vit à dist-test/tests/unit/ → la racine du dépôt est trois niveaux
// plus haut, pas deux. Même calcul que cli-registry-snapshot.test.ts.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

describe('pln#626 phase 4 — le drapeau mort ne revient pas', () => {
  it('TurnInput ne déclare plus `dispatch`', () => {
    const verbs = read('src/core/loops/verbs.ts');
    const start = verbs.indexOf('export interface TurnInput');
    assert.ok(start > 0, 'TurnInput introuvable — le test doit être remis à jour, pas supprimé');
    const block = verbs.slice(start, verbs.indexOf('\n}', start));
    assert.ok(
      !/^\s*dispatch\??:/m.test(block),
      'TurnInput redéclare `dispatch` — s’il est réintroduit, il doit être LU quelque part',
    );
  });

  it('le handler ne transporte plus `req.dispatch` vers turn()', () => {
    const handlers = read('src/commands/loops-handlers.ts');
    assert.ok(
      !handlers.includes('dispatch: req.dispatch'),
      'le drapeau est de nouveau transporté jusqu’à turn()',
    );
  });

  it('la porte de confiance NO-OP sur turn a disparu', () => {
    const coord = read('src/commands/mcp-write-coordination.ts');
    assert.ok(
      !coord.includes("args?.intent === 'turn' && args?.dispatch === true"),
      'la porte de confiance sur un no-op est revenue',
    );
  });

  it('MAIS la porte de `bind` SURVIT — elle garde un vrai spawn', () => {
    // Le vrai accident aurait été de retirer les deux : `bind` dispatche la séquence
    // liée de la boucle, donc il spawne réellement des workers.
    const coord = read('src/commands/mcp-write-coordination.ts');
    assert.ok(
      coord.includes("args?.intent === 'bind'"),
      'la porte de confiance de bind a été retirée avec celle du no-op — bind SPAWNE',
    );
    const gateIndex = coord.indexOf("args?.intent === 'bind'");
    const following = coord.slice(gateIndex, gateIndex + 400);
    assert.ok(following.includes("'trusted'"), 'bind n’est plus protégé au barreau trusted');
  });
});
