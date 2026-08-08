/**
 * pln#626 phase 3 — `autoExecute: true` sur `consult` est un no-op OBSERVABLE.
 *
 * L'HISTOIRE DE CE DÉFAUT. `consult` livre une RFC dans les inbox des cibles et ne spawne
 * jamais. Un appelant qui passe `autoExecute: true` obtient donc exactement rien de ce
 * qu'il demande. La phase 1 avait ajouté un avertissement en TEXTE LIBRE — mieux que le
 * silence, mais illisible pour une machine : un agent ne peut pas brancher dessus, et
 * c'est précisément un agent qui fait cet appel.
 *
 * CE QUE CETTE PHASE AJOUTE, ET CE QU'ELLE LAISSE OUVERT. Le refus passe désormais par le
 * canal structuré, avec un code et les deux appels qui spawnent réellement. Ce qui reste
 * au produit — refuser en erreur dure, ou implémenter un vrai « consult run » — n'est pas
 * tranché ici : casser des appelants existants pour un drapeau qui n'a jamais rien fait
 * serait un choix, pas une correction.
 *
 * Le test passe par `executeMcpToolCall`, la vraie dispatch : un avertissement qui
 * n'atteint pas la réponse MCP n'avertit personne.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

interface WarnCarrier {
  warnings?: string[];
  warning_details?: Array<{ code: string; message: string; next_actions?: Array<{ tool: string }> }>;
}

/** Les avertissements peuvent être portés à plusieurs profondeurs d'enveloppe. */
function warnCarrier(response: unknown): WarnCarrier {
  const out: WarnCarrier = { warnings: [], warning_details: [] };
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj['warnings'])) out.warnings!.push(...(obj['warnings'] as string[]));
    if (Array.isArray(obj['warning_details'])) {
      out.warning_details!.push(...(obj['warning_details'] as NonNullable<WarnCarrier['warning_details']>));
    }
    Object.values(obj).forEach(walk);
  };
  walk(response);
  return out;
}

async function consult(args: Record<string, unknown>): Promise<WarnCarrier> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_coordinate',
    args: { intent: 'consult', task: 'une question à poser', targetAgents: ['codex'], ...args },
    cwd: ws.dir,
  });
  return warnCarrier(outcome.response);
}

beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-consult-' }); });
afterEach(() => { ws.cleanup(); });

describe('consult — le no-op autoExecute est DÉTECTABLE par une machine', () => {
  it('émet un code structuré, pas seulement une phrase', async () => {
    const carrier = await consult({ autoExecute: true });
    const detail = carrier.warning_details?.find((w) => w.code === 'auto_execute_ignored_on_consult');
    assert.ok(
      detail,
      `aucun code structuré — un agent ne peut pas brancher sur du texte libre. Reçu : ${JSON.stringify(carrier.warning_details)}`,
    );
  });

  it('le canal TEXTE reste alimenté — les lecteurs existants ne perdent rien', async () => {
    // Passer au structuré ne doit pas retirer ce que les surfaces humaines affichaient.
    const carrier = await consult({ autoExecute: true });
    assert.ok(
      carrier.warnings?.some((w) => /autoExecute/.test(w)),
      'le canal texte a été vidé en passant au structuré',
    );
  });

  it('nomme les appels qui spawnent RÉELLEMENT', async () => {
    // Dire « ça ne marche pas » sans dire quoi faire laisse l'agent au même point.
    const carrier = await consult({ autoExecute: true });
    const detail = carrier.warning_details?.find((w) => w.code === 'auto_execute_ignored_on_consult');
    const tools = (detail?.next_actions ?? []).map((a) => a.tool);
    assert.ok(tools.includes('bclaw_dispatch'), 'la voie de spawn réelle n’est pas nommée');
    assert.ok(tools.includes('bclaw_coordinate'), 'la voie assign n’est pas nommée');
  });

  it('N’AVERTIT PAS quand autoExecute n’est pas demandé', async () => {
    // Un avertissement systématique serait du bruit, et le bruit apprend à ignorer le
    // canal — exactement ce que la règle de next-actions.ts proscrit.
    for (const args of [{}, { autoExecute: false }]) {
      const carrier = await consult(args);
      assert.equal(
        carrier.warning_details?.some((w) => w.code === 'auto_execute_ignored_on_consult'),
        false,
        `avertissement émis sans autoExecute:true (args ${JSON.stringify(args)})`,
      );
    }
  });
});
