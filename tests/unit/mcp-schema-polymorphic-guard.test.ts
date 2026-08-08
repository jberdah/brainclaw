/**
 * pln#599 étape 1 — le critère d'exclusion des façades polymorphes, rendu EXÉCUTABLE.
 *
 * POURQUOI UN TEST ET NON UNE LIGNE DE PLAN. Le plan nommait TROIS façades à exclure de la
 * migration vers les schémas zod-dérivés : `bclaw_work`, `bclaw_coordinate`,
 * `bclaw_dispatch`. La mesure en trouve QUATRE — `bclaw_loop` porte aussi un enum
 * d'`intent`. Une liste de noms écrite à la main a donc déjà dérivé une fois ; elle
 * dérivera encore à la prochaine façade ajoutée.
 *
 * LE CRITÈRE EST MÉCANIQUE : un schéma est intent-polymorphe si sa propriété `intent`
 * porte un enum. La forme valide du RESTE du schéma dépend alors de la valeur choisie —
 * ce qu'un schéma zod dérivé à plat ne peut pas exprimer sans perdre la contrainte.
 * Migrer un tel outil produirait un schéma qui valide des combinaisons impossibles.
 *
 * CE TEST NE FIGE PAS LA LISTE. Ajouter une façade polymorphe est légitime ; ce qui ne
 * l'est pas, c'est qu'elle passe inaperçue. Le test échoue alors, et son message dit quoi
 * faire — inscrire l'outil dans l'exclusion, pas relâcher le critère.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_TOOLS } from '../../src/commands/mcp-catalog.js';

/**
 * Façades reconnues comme intent-polymorphes au 2026-08-08.
 *
 * `bclaw_loop` a été AJOUTÉE ici par la mesure, pas par la lecture du plan — c'est
 * précisément la valeur de ce test.
 */
const KNOWN_POLYMORPHIC = new Set([
  'bclaw_work',
  'bclaw_coordinate',
  'bclaw_dispatch',
  'bclaw_loop',
]);

interface ToolLike {
  name: string;
  inputSchema?: { properties?: Record<string, { enum?: unknown[] }> };
}

/** Applique le critère : propriété `intent` portant un enum. */
function isIntentPolymorphic(tool: ToolLike): boolean {
  const intent = tool.inputSchema?.properties?.['intent'];
  return Array.isArray(intent?.enum) && intent.enum.length > 0;
}

describe('pln#599 — le critère d’exclusion est mécanique, pas nominatif', () => {
  it('détecte exactement les façades intent-polymorphes connues', () => {
    const detected = (ALL_TOOLS as unknown as ToolLike[])
      .filter(isIntentPolymorphic)
      .map((t) => t.name)
      .sort();

    assert.deepEqual(
      detected,
      [...KNOWN_POLYMORPHIC].sort(),
      'la liste des façades polymorphes a changé. Si un outil est APPARU, inscris-le dans'
      + " KNOWN_POLYMORPHIC et EXCLUS-le de la migration zod — ne relâche pas le critère."
      + ' Si un outil a DISPARU de la détection, vérifie que son enum d’intent n’a pas été'
      + ' retiré par accident.',
    );
  });

  it('bclaw_loop EST détectée — le plan l’avait omise', () => {
    // Assertion nommée exprès : c'est la correction concrète que cette étape apporte, et
    // une régression silencieuse ici ferait migrer un schéma qui ne doit pas l'être.
    const loop = (ALL_TOOLS as unknown as ToolLike[]).find((t) => t.name === 'bclaw_loop');
    assert.ok(loop, 'bclaw_loop a disparu du catalogue');
    assert.equal(isIntentPolymorphic(loop), true);
  });

  it('un outil SANS enum d’intent n’est pas exclu à tort', () => {
    // Le critère doit discriminer : s'il attrapait tout, il n'exclurait rien d'utile.
    const find = (ALL_TOOLS as unknown as ToolLike[]).find((t) => t.name === 'bclaw_find');
    assert.ok(find, 'bclaw_find a disparu du catalogue');
    assert.equal(isIntentPolymorphic(find), false);
  });

  it('les façades polymorphes sont une MINORITÉ — sinon la migration n’a pas d’objet', () => {
    // Garde de cohérence : si la moitié du catalogue devenait polymorphe, le plan de
    // migration lui-même n'aurait plus de sens et devrait être re-discuté.
    const total = (ALL_TOOLS as unknown as ToolLike[]).length;
    assert.ok(
      KNOWN_POLYMORPHIC.size < total / 4,
      `${KNOWN_POLYMORPHIC.size} façades polymorphes sur ${total} outils — au-delà d’un quart,`
      + ' la stratégie de migration zod doit être re-discutée, pas poursuivie.',
    );
  });
});
