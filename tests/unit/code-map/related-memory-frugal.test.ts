/**
 * pln#598 étape 3 — mémoire liée frugale dans `code_brief`.
 *
 * LE COÛT. Un trap ou une décision de ce dépôt dépasse régulièrement 2 000 caractères —
 * plusieurs des textes écrits pendant la refonte fédération v2 en font le double. Un
 * `code_brief` qui en attache trois sert des milliers de caractères AVANT que l'agent
 * n'ait ouvert un seul fichier, pour un contenu qu'il ne lira peut-être pas.
 *
 * CE QUE CE PACK PROTÈGE, par ordre d'importance :
 *   1. le texte est DIFFÉRÉ, pas perdu — chaque entrée raccourcie porte l'appel exact ;
 *   2. `id`, `kind`, `tags` et `related_paths` restent ENTIERS — ce sont eux qui servent
 *      à décider s'il vaut la peine d'aller lire, et les tronquer économiserait des
 *      octets sur la seule partie utile au tri ;
 *   3. une entrée déjà courte n'est pas marquée — un marqueur pour rien est du bruit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRelatedMemory } from '../../../src/core/code-map/aggregate.js';
import type { RelatedMemoryItem } from '../../../src/core/code-map/query.js';

const LONG = 'Un piège très détaillé sur la fédération. '.repeat(60);
const SHORT = 'Un piège court.';

/**
 * Teste la PROJECTION directement, et voici pourquoi c'est defendable ici.
 *
 * `aggregateBrief` prend une traversee resolue, un head courant et un lecteur de memoire
 * — construire tout cela n'exercerait RIEN de ce que ces assertions verifient, et
 * masquerait la propriete sous du montage. Ce que ce pack protege est le contrat d'une
 * fonction PURE : entree memoire liee, sortie memoire liee resumee.
 *
 * Le cablage — un seul point d'appel dans `aggregateBrief` — est verifie par le
 * typecheck et par les 399 tests de code-map qui traversent l'agregateur complet.
 */
function briefWith(items: RelatedMemoryItem[]): RelatedMemoryItem[] {
  return summarizeRelatedMemory(items);
}

describe('code_brief — la mémoire liée est résumée, pas amputée', () => {
  it('raccourcit un texte long ET dit comment obtenir l’intégralité', () => {
    const [item] = briefWith([
      { id: 'trp_long', kind: 'trap', text: LONG, tags: ['federation'], related_paths: ['src/a.ts'] },
    ]);

    assert.ok(item, 'aucune entrée rendue');
    assert.ok(item.text.length < LONG.length, 'le texte n’a pas été raccourci');
    assert.equal(item.text_truncated, true, 'une troncature doit se voir');
    assert.equal(item.full_text_via?.tool, 'bclaw_get');
    assert.equal(item.full_text_via?.args['entity'], 'trap', 'la suite doit viser le BON type');
    assert.equal(item.full_text_via?.args['id'], 'trp_long', 'la suite doit viser CETTE entrée');
  });

  it('préserve ENTIERS les champs qui servent à trier', () => {
    // Économiser des octets sur id/kind/tags/related_paths reviendrait à couper la seule
    // partie qui permet de décider s'il faut aller lire.
    const [item] = briefWith([
      { id: 'dec_x', kind: 'decision', text: LONG, tags: ['a', 'b', 'c'], related_paths: ['src/a.ts', 'src/b.ts'] },
    ]);
    assert.equal(item!.id, 'dec_x');
    assert.equal(item!.kind, 'decision');
    assert.deepEqual(item!.tags, ['a', 'b', 'c']);
    assert.deepEqual(item!.related_paths, ['src/a.ts', 'src/b.ts']);
  });

  it('laisse INTACTE une entrée déjà courte, sans marqueur ni suite', () => {
    const [item] = briefWith([
      { id: 'trp_court', kind: 'trap', text: SHORT, tags: [], related_paths: [] },
    ]);
    assert.equal(item!.text, SHORT);
    assert.equal(item!.text_truncated, undefined, 'entrée courte marquée tronquée');
    assert.equal(item!.full_text_via, undefined, 'suite ajoutée sans troncature — du bruit');
  });

  it('l’allègement se voit dans la TAILLE, pas seulement dans l’intention', () => {
    const items: RelatedMemoryItem[] = [
      { id: 'a', kind: 'trap', text: LONG, tags: [], related_paths: [] },
      { id: 'b', kind: 'decision', text: LONG, tags: [], related_paths: [] },
      { id: 'c', kind: 'constraint', text: LONG, tags: [], related_paths: [] },
    ];
    const before = JSON.stringify(items).length;
    const after = JSON.stringify(briefWith(items)).length;
    assert.ok(after < before / 2, `résumé ${after} contre ${before} caractères — l’allègement ne se mesure pas`);
  });
});
