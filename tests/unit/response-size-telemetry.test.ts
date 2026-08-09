/**
 * pln#598 étape 1 — télémétrie de taille de réponse.
 *
 * POURQUOI MESURER AVANT D'OPTIMISER. Le plan demande explicitement « baseline documentée
 * AVANT toute optimisation ». Sans chiffre de départ, une optimisation se juge au
 * ressenti — et la moitié des « allègements » de ce genre déplacent le coût au lieu de le
 * réduire, en forçant l'appelant à faire deux tours au lieu d'un.
 *
 * CE QUE CE FICHIER EST, ET CE QU'IL N'EST PAS. C'est un GARDE-FOU, pas un objectif. Il
 * ne dit pas « cette réponse devrait faire 2 Ko » — il dit « elle en faisait tant, et si
 * elle double sans que personne ne l'ait voulu, la CI le signale ». Les plafonds sont donc
 * larges et fixés au-dessus de la mesure, pas dessus : un plafond serré au ras du réel
 * rougirait sur du bruit et finirait relevé machinalement à chaque fois, ce qui revient à
 * ne rien garder.
 *
 * LA MESURE PASSE PAR `executeMcpToolCall` — la vraie dispatch MCP — et non par les
 * handlers internes. Un agent ne reçoit pas la valeur de retour d'un handler : il reçoit
 * le JSON sérialisé de la réponse, enveloppes comprises. Mesurer une couche en dessous
 * mesurerait autre chose que ce qui coûte.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { mutateState } from '../../src/core/state.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { nowISO } from '../../src/core/ids.js';

let ws: TestWorkspace;

/**
 * Un store RÉALISTE, pas vide. Une réponse mesurée sur un store neuf ne dit rien : le
 * coût vient de la densité de mémoire et du travail ouvert, exactement ce que le plan
 * demande de reproduire (« store moyen avec assignment ouverte + mémoire dense »).
 */
function seedDenseStore(cwd: string): void {
  mutateState((state) => {
    for (let i = 0; i < 40; i++) {
      state.known_traps.push({
        id: `trp_seed_${i}`,
        short_label: `trp#${i}`,
        text: `Piège de densité numéro ${i}. `.repeat(8),
        created_at: nowISO(),
        status: 'active',
        author: 'seed',
        severity: 'medium',
        tags: ['seed', 'densité'],
      } as never);
      state.recent_decisions.push({
        id: `dec_seed_${i}`,
        short_label: `dec#${i}`,
        text: `Décision de densité numéro ${i}. `.repeat(8),
        created_at: nowISO(),
        author: 'seed',
        tags: ['seed'],
      } as never);
    }
    for (let i = 0; i < 15; i++) {
      state.plan_items.push({
        id: `pln_seed_${i}`,
        short_label: `pln#${i}`,
        text: `Plan de densité numéro ${i}. `.repeat(10),
        created_at: nowISO(),
        updated_at: nowISO(),
        author: 'seed',
        status: 'todo',
        priority: 'medium',
        type: 'feat',
        tags: ['seed'],
        depends_on: [],
      } as never);
    }
  }, cwd);

  // ── UNE ASSIGNATION À DESCRIPTION LONGUE, ET C'EST INDISPENSABLE ───────────────
  //
  // `compact` ne tronque QUE les descriptions d'`open_work`, lesquelles proviennent des
  // assignations (compactOpenWork, OPEN_WORK_DESCRIPTION_LIMIT = 200). Sans assignation
  // dans le magasin, compact n'a RIEN à compacter : les deux modes rendent exactement la
  // même réponse, et la comparaison ci-dessous devient un pile ou face que trois
  // caractères de variation d'environnement suffisent à faire basculer.
  //
  // C'est très exactement ce qui s'est produit : vert en local (4079 contre 4079, delta
  // nul et parfaitement reproductible sur six paires), rouge en CI Windows (4079 contre
  // 4076). Le test n'attrapait pas une régression du produit — il n'exerçait simplement
  // pas la fonctionnalité qu'il prétendait mesurer.
  //
  // La description dépasse largement la limite pour que la troncature soit AMPLE et non
  // marginale : un écart de quelques caractères ne prouverait rien, un écart de plusieurs
  // centaines ne peut pas venir du bruit.
  saveAssignment({
    id: 'asgn_seed',
    claim_id: 'clm_seed',
    agent: 'seed-agent',
    dispatcher_agent: 'seed-dispatcher',
    scope: 'src/seed',
    description: `Brief de dispatch volontairement long, pour que la troncature de compact ait prise. `.repeat(12),
    status: 'started',
    created_at: nowISO(),
  } as never, cwd);

  saveClaim({
    id: 'clm_seed',
    agent: 'seed-agent',
    scope: 'src/seed',
    description: 'Une réclamation ouverte, pour que le travail en cours pèse dans la réponse.',
    created_at: nowISO(),
    status: 'active',
  } as never, cwd);
}

/** Taille du payload tel qu'un agent le reçoit : le JSON sérialisé complet. */
async function measureIn(cwd: string, name: string, args: Record<string, unknown>): Promise<number> {
  const outcome = await executeMcpToolCall({ name, args, cwd });
  return JSON.stringify(outcome.response).length;
}

async function measure(name: string, args: Record<string, unknown>): Promise<number> {
  return measureIn(ws.dir, name, args);
}

/**
 * Exécute une mesure dans un workspace NEUF et le nettoie.
 *
 * Indispensable pour comparer deux modes : le premier appel d'un workspace paie le
 * démarrage de session, et cette différence écrase celle qu'on cherche à mesurer.
 */
async function inFreshWorkspace(fn: (cwd: string) => Promise<number>): Promise<number> {
  const fresh = createTestWorkspace({ prefix: 'bclaw-telemetry-cmp-' });
  try {
    seedDenseStore(fresh.dir);
    return await fn(fresh.dir);
  } finally {
    fresh.cleanup();
  }
}

/**
 * PLAFONDS PAR OUTIL — larges par construction.
 *
 * Ce ne sont pas des cibles de performance : ce sont des seuils au-delà desquels quelque
 * chose a changé sans qu'on l'ait voulu. Ils sont fixés bien au-dessus de la mesure
 * observée pour ne rougir que sur une dérive franche — un plafond au ras du réel se
 * relèverait machinalement et ne garderait plus rien.
 */
const CEILINGS: Record<string, number> = {
  // Mesuré le 2026-08-08 sur le store dense ci-dessus : work 4 079, find 18 765,
  // search 6 082, context 7 721. Les plafonds sont posés à ~3x — assez haut pour ne pas
  // rougir sur du bruit ou un fixture qui grossit un peu, assez bas pour attraper un
  // doublement franc. Un plafond au ras du réel se relèverait machinalement à chaque
  // échec et ne garderait plus rien.
  bclaw_work: 15_000,
  bclaw_find: 60_000,
  bclaw_search: 20_000,
  bclaw_context: 25_000,
};

beforeEach(() => {
  ws = createTestWorkspace({ prefix: 'bclaw-telemetry-' });
  seedDenseStore(ws.dir);
});

afterEach(() => { ws.cleanup(); });

describe('télémétrie — la baseline est MESURÉE, pas supposée', () => {
  it('mesure chaque outil de lecture et reste sous son plafond', async () => {
    const measured: Array<[string, number, number]> = [];

    const cases: Array<[string, Record<string, unknown>]> = [
      ['bclaw_work', { intent: 'consult', compact: true }],
      ['bclaw_find', { entity: 'trap' }],
      ['bclaw_search', { query: 'densité' }],
      ['bclaw_context', { kind: 'memory' }],
    ];

    for (const [name, args] of cases) {
      const size = await measure(name, args);
      const ceiling = CEILINGS[name]!;
      measured.push([name, size, ceiling]);
    }

    // La mesure est IMPRIMÉE, pas seulement assertée : c'est elle la livraison de cette
    // étape. Un plafond vert sans chiffre visible ne documente aucune baseline.
    console.log('\n  baseline de taille de réponse (caractères) :');
    for (const [name, size, ceiling] of measured) {
      console.log(`    ${name.padEnd(16)} ${String(size).padStart(7)}  (plafond ${ceiling})`);
    }

    for (const [name, size, ceiling] of measured) {
      assert.ok(
        size <= ceiling,
        `${name} rend ${size} caractères, au-dessus du plafond ${ceiling}.`
        + ` Soit la réponse a grossi sans qu'on le veuille, soit le plafond doit être relevé DÉLIBÉRÉMENT.`,
      );
    }
  });

  it('aucune réponse mesurée n’est vide — un zéro passerait tous les plafonds', async () => {
    // Le mode d'échec le plus discret de ce genre de test : un outil qui casse rend une
    // réponse minuscule, et le garde-fou le félicite.
    for (const [name, args] of [
      ['bclaw_work', { intent: 'consult', compact: true }],
      ['bclaw_find', { entity: 'trap' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const size = await measure(name, args);
      assert.ok(size > 200, `${name} rend ${size} caractères — suspicieusement vide`);
    }
  });
});

describe('télémétrie — comparer deux modes exige deux workspaces NEUFS', () => {
  it('bclaw_work compact rend une projection RÉDUITE, à égalité de conditions', async () => {
    // PIÈGE RENCONTRÉ ICI, ET C'EST LA RAISON DE CE COMMENTAIRE. Mesurer les deux modes
    // dans LE MÊME workspace compare deux choses différentes : le PREMIER appel démarre
    // la session et paie ce coût, le second la reprend. Vérifié dans les deux ordres —
    // premier appel 2105 caractères, second 1804, QUEL QUE SOIT le mode. La différence
    // observée n'était donc pas celle de `compact`, mais celle de « premier appel ».
    //
    // Un test qui aurait conclu « compact n'allège rien » aurait accusé le produit d'un
    // défaut appartenant à sa propre méthode de mesure.
    // INTENT `resume`, PAS `consult` — et ce choix a été MESURÉ, pas supposé.
    //
    // La version précédente comparait les deux modes sur `consult`, où ils rendent
    // RIGOUREUSEMENT la même réponse (4079 contre 4079, delta nul et reproductible sur
    // six paires de workspaces neufs). L'assertion `compact <= full` y était donc
    // satisfaite par égalité, PAR ACCIDENT — jusqu'à ce que trois caractères de variation
    // d'environnement la renversent en CI Windows (4079 contre 4076). Le test n'attrapait
    // aucune régression : il n'exerçait pas la fonctionnalité qu'il prétendait mesurer.
    //
    // Sur `resume`, compact rend une PROJECTION RÉDUITE du payload de contexte
    // (mcp.ts, branche `useCompact`) : ~2100 caractères d'écart, hors de portée du bruit.
    // CONTRE-ÉPREUVE FAITE : en forçant `useCompact = false`, vérifié dans le .js compilé,
    // ce test vire au rouge. Une première tentative visait `compactOpenWork` — neutraliser
    // la troncature laissait le test VERT, parce qu'`open_work` est nul ici. L'économie
    // vient de la projection réduite, pas de la troncature des briefs.
    const compact = await inFreshWorkspace((cwd) =>
      measureIn(cwd, 'bclaw_work', { intent: 'resume', compact: true }));
    const full = await inFreshWorkspace((cwd) =>
      measureIn(cwd, 'bclaw_work', { intent: 'resume', compact: false }));

    // ASSERTION STRICTE, redevenue mesurable. La version précédente écrivait
    // `compact <= full` sur un magasin SANS assignation : les deux valeurs étaient
    // identiques et l'égalité satisfaisait l'assertion par accident, jusqu'à ce qu'une
    // variation d'environnement de trois caractères la renverse en CI.
    //
    // Avec une assignation à description longue semée, compact DOIT rendre strictement
    // moins — et de beaucoup. Exiger un écart substantiel plutôt qu'un simple ordre
    // empêche ce test de redevenir un pile ou face si la troncature disparaissait.
    assert.ok(
      compact < full,
      `compact rend ${compact} caractères contre ${full} en mode plein : la troncature n'a pas eu lieu`,
    );
    assert.ok(
      full - compact > 200,
      `compact n'économise que ${full - compact} caractères — trop peu pour distinguer une ` +
        `troncature réelle du bruit d'environnement (mesuré à 3 caractères en CI Windows)`,
    );
  });

  it('budget_tokens réduit la réponse quand il est serré', async () => {
    const large = await measure('bclaw_context', { kind: 'memory' });
    const tight = await measure('bclaw_context', { kind: 'memory', budget_tokens: 500 });
    assert.ok(
      tight <= large,
      `budget_tokens=500 rend ${tight} caractères contre ${large} sans budget — le budget n'est pas honoré`,
    );
  });
});
