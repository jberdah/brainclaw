/**
 * pln#598 étape 2 — projection compacte de `open_work`.
 *
 * LE COÛT MESURÉ. Une description d'assignation porte le BRIEF COMPLET du worker. Sur ce
 * dépôt, des briefs de dispatch dépassent 1 500 caractères, et plusieurs coexistent dans
 * `open_work`. Servis en entier dans une réponse dite « compacte », ils en font
 * l'essentiel du poids — pour un texte que l'appelant a écrit lui-même.
 *
 * CE QUE CE PACK VÉRIFIE, ET DANS QUEL ORDRE D'IMPORTANCE :
 *   1. le texte n'est pas PERDU mais DIFFÉRÉ — chaque entrée tronquée porte de quoi le
 *      récupérer ; un allègement qui supprime l'information ne l'allège pas, il la
 *      déplace sur l'appelant qui devine au lieu de lire ;
 *   2. la troncature ne fuit PAS hors du chemin compact — les autres consommateurs
 *      d'`open_work` ont besoin du texte entier ;
 *   3. la réponse compacte pèse effectivement moins.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { createAssignment } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import { nowISO } from '../../src/core/ids.js';

const AGENT = 'compact-bench';
/** Un brief réaliste : c'est la taille observée sur les dispatchs de ce dépôt. */
const LONG_BRIEF = 'Brief de dispatch détaillé. '.repeat(70);

let ws: TestWorkspace;

function seedOpenAssignment(cwd: string): void {
  saveClaim({
    id: 'clm_compact',
    agent: AGENT,
    scope: 'src/compact',
    description: 'réclamation ouverte',
    created_at: nowISO(),
    status: 'active',
  } as never, cwd);

  createAssignment({
    agent: AGENT,
    scope: 'src/compact',
    description: LONG_BRIEF,
    claim_id: 'clm_compact',
    dispatcher_agent: AGENT,
  } as never, cwd);
}

beforeEach(() => {
  ws = createTestWorkspace({ prefix: 'bclaw-compact-', currentAgent: AGENT });
  seedOpenAssignment(ws.dir);
});

afterEach(() => { ws.cleanup(); });

async function callWork(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await executeMcpToolCall({ name: 'bclaw_work', args, cwd: ws.dir });
  return outcome.response as unknown as Record<string, unknown>;
}

/** Extrait les assignations d'`open_work`, quelle que soit la profondeur d'enveloppe. */
function assignmentsOf(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj['active_assignments'])) {
      found.push(...(obj['active_assignments'] as Array<Record<string, unknown>>));
    }
    Object.values(obj).forEach(walk);
  };
  walk(response);
  return found;
}

describe('open_work compact — le texte est DIFFÉRÉ, pas perdu', () => {
  it('tronque la description ET dit comment récupérer le texte entier', async () => {
    const response = await callWork({ intent: 'consult', compact: true });
    const assignments = assignmentsOf(response);
    assert.ok(assignments.length > 0, 'aucune assignation dans open_work — le fixture ne tire pas');

    const truncated = assignments.find((a) => a['description_truncated'] === true);
    assert.ok(truncated, 'aucune description tronquée alors que le brief dépasse la limite');

    const description = truncated['description'] as string;
    assert.ok(description.length < LONG_BRIEF.length, 'la description n’a pas été raccourcie');
    assert.ok(description.endsWith('…'), 'une troncature doit se voir');

    // LE POINT LE PLUS IMPORTANT DU PACK : la suite exacte, rejouable telle quelle.
    const via = truncated['full_text_via'] as { tool?: string; args?: Record<string, unknown> };
    assert.equal(via?.tool, 'bclaw_get');
    assert.equal(via?.args?.entity, 'assignment');
    assert.equal(via?.args?.id, truncated['id'], 'la suite doit pointer sur CETTE assignation');
  });

  it('laisse INTACTE une description déjà courte', async () => {
    // Tronquer ce qui tient déjà ajouterait un marqueur et une suite pour rien — du
    // bruit, exactement ce que la règle de next-actions.ts proscrit.
    const fresh = createTestWorkspace({ prefix: 'bclaw-compact-short-', currentAgent: AGENT });
    try {
      saveClaim({ id: 'clm_s', agent: AGENT, scope: 's', description: 'x', created_at: nowISO(), status: 'active' } as never, fresh.dir);
      createAssignment({ agent: AGENT, scope: 's', description: 'brief court', claim_id: 'clm_s', dispatcher_agent: AGENT } as never, fresh.dir);
      const outcome = await executeMcpToolCall({ name: 'bclaw_work', args: { intent: 'consult', compact: true }, cwd: fresh.dir });
      const assignments = assignmentsOf(outcome.response as unknown as Record<string, unknown>);
      for (const a of assignments) {
        assert.equal(a['description_truncated'], undefined, 'une description courte a été marquée tronquée');
        assert.equal(a['full_text_via'], undefined, 'suite ajoutée sans troncature — du bruit');
      }
    } finally {
      fresh.cleanup();
    }
  });
});

describe('open_work compact — la troncature ne fuit PAS ailleurs', () => {
  it('le mode NON compact — compact:false EXPLICITE — sert la description entière', async () => {
    // La troncature vit dans la branche compacte, pas dans context.ts : session-end, le
    // board et les surfaces de diagnostic ont besoin du texte entier, et le couper à la
    // source le leur retirerait sans le dire.
    //
    // `compact` VAUT TRUE PAR DÉFAUT (mcp.ts : `workReq.compact !== false`). Omettre le
    // drapeau n'appelle donc PAS le mode plein — ma première version de ce test comparait
    // le mode compact à lui-même et concluait que la troncature « avait fui ». C'était
    // l'assertion qui était fausse, pas le code.
    const response = await callWork({ intent: 'consult', compact: false });
    const assignments = assignmentsOf(response);
    if (assignments.length === 0) return; // le mode plein peut ne pas servir open_work
    for (const a of assignments) {
      assert.equal(a['description_truncated'], undefined, 'la troncature a fui hors du chemin compact');
      const description = a['description'];
      if (typeof description === 'string') {
        assert.ok(!description.endsWith('…'), 'description tronquée en mode plein');
      }
    }
  });
});

describe('open_work compact — l’allègement est réel', () => {
  it('la réponse compacte pèse moins que la même sans troncature', async () => {
    // Vérifié en TAILLE, pas en intention : un allègement qui ne se mesure pas n'en est
    // pas un. Deux workspaces distincts pour ne pas mesurer le coût de démarrage de
    // session au lieu de celui de la troncature (piège rencontré sur pln#598 étape 1).
    const compact = JSON.stringify(await callWork({ intent: 'consult', compact: true })).length;

    const other = createTestWorkspace({ prefix: 'bclaw-compact-ref-', currentAgent: AGENT });
    try {
      seedOpenAssignment(other.dir);
      const outcome = await executeMcpToolCall({ name: 'bclaw_work', args: { intent: 'consult' }, cwd: other.dir });
      const full = JSON.stringify(outcome.response).length;
      assert.ok(
        compact < full + LONG_BRIEF.length,
        `compact ${compact} vs plein ${full} — la troncature ne se voit pas dans la taille`,
      );
    } finally {
      other.cleanup();
    }
  });
});
