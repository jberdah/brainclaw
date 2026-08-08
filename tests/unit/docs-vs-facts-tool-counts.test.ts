/**
 * pln#599 — test docs-vs-faits sur le catalogue MCP.
 *
 * LA DÉRIVE MESURÉE. `docs/integrations/mcp.md` annonçait « 44 tools » par défaut alors
 * que le catalogue en déclare 46 (7 façades + 39 standard, 21 avancés, 67 au total). Le
 * plan lui-même citait 65/6 — donc la documentation ET le plan avaient dérivé, chacun de
 * son côté, par rapport au code.
 *
 * POURQUOI UN TEST PLUTÔT QU'UNE CORRECTION UNIQUE. Corriger le chiffre à la main le
 * remet juste jusqu'au prochain outil ajouté. La documentation d'un catalogue est une
 * assertion sur le code : elle doit être vérifiée par le code, sinon elle redevient fausse
 * en silence — et un agent qui la lit pour décider quels outils demander se trompe sans
 * jamais l'apprendre.
 *
 * CE QUE CE TEST NE FAIT PAS : il ne fige pas les COMPTES. Ajouter un outil est normal et
 * ne doit pas rougir la CI pour la mauvaise raison. Il vérifie que la doc et le code
 * DISENT LA MÊME CHOSE — le jour où l'un bouge sans l'autre.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOLS, MCP_TOOL_NAMES } from '../../src/commands/mcp-catalog.js';

// Le test COMPILÉ vit à dist-test/tests/unit/ → racine trois niveaux plus haut.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOC = path.join(REPO_ROOT, 'docs', 'integrations', 'mcp.md');

type Tier = 'facade' | 'standard' | 'advanced';

/**
 * Le palier vit dans `annotations`, PAS a la racine de l'outil.
 *
 * Le lire a la racine avec un defaut 'standard' rangeait les 67 outils dans un seul
 * palier — et le test passait quand meme sa verification de somme, puisque 0+67+0 = 67.
 * Une agregation qui se verifie contre elle-meme ne prouve rien : c'est la comparaison
 * a la DOC qui a revele l'erreur.
 */
function countByTier(): Record<Tier, number> {
  const by: Record<Tier, number> = { facade: 0, standard: 0, advanced: 0 };
  for (const tool of ALL_TOOLS as Array<{ annotations?: { tier?: string } }>) {
    const tier = (tool.annotations?.tier ?? 'standard') as Tier;
    if (tier in by) by[tier]++;
  }
  return by;
}

describe('catalogue MCP — le code est cohérent avec lui-même', () => {
  it('MCP_TOOL_NAMES ne porte aucun doublon', () => {
    // Un doublon ferait diverger « nombre d'outils » de « nombre de noms », et tous les
    // comptes documentés en dépendent.
    assert.equal(new Set(MCP_TOOL_NAMES).size, MCP_TOOL_NAMES.length);
  });

  it('chaque outil porte un palier reconnu', () => {
    for (const tool of ALL_TOOLS as Array<{ name: string; annotations?: { tier?: string } }>) {
      const tier = tool.annotations?.tier;
      assert.ok(
        tier !== undefined && ['facade', 'standard', 'advanced'].includes(tier),
        `palier absent ou inconnu sur ${tool.name} : ${String(tier)}`,
      );
    }
  });

  it('les paliers additionnés font le total', () => {
    const by = countByTier();
    assert.equal(by.facade + by.standard + by.advanced, ALL_TOOLS.length);
  });
});

describe('catalogue MCP — la documentation dit ce que le code fait', () => {
  it('le compte par défaut annoncé dans mcp.md correspond à facade + standard', () => {
    // C'est la dérive corrigée : la doc annonçait 44, le code en sert 46.
    const doc = fs.readFileSync(DOC, 'utf-8');
    const match = /returns \*\*facade \+ standard\*\* tools \((\d+) tools\)/.exec(doc);
    assert.ok(match, "la phrase de compte par défaut est introuvable dans mcp.md — si elle a été reformulée, ce test doit suivre, pas être supprimé");

    const by = countByTier();
    assert.equal(
      Number(match[1]),
      by.facade + by.standard,
      `mcp.md annonce ${match[1]} outils par défaut, le catalogue en sert ${by.facade + by.standard}`
      + ` (${by.facade} façades + ${by.standard} standard).`,
    );
  });

  it('les lignes du TABLEAU DE CATALOGUE ne citent que des outils existants', () => {
    // PORTÉE VOLONTAIREMENT RESTREINTE, et c'est le résultat d'une première version trop
    // stricte. Interdire toute mention d'un outil disparu rougissait sur la table de
    // REMPLACEMENT — « bclaw_context remplace bclaw_get_context / bclaw_get_agent_board »
    // — où citer l'ancien nom est précisément l'information utile. Un test qui casse la
    // documentation historique pour faire respecter le présent est un mauvais test.
    //
    // La garde porte donc sur la PREMIÈRE colonne des tableaux, celle qui PRESCRIT un
    // appel. Un outil retiré cité là enverrait un agent appeler quelque chose qui
    // n'existe plus, et l'erreur remonterait au pire endroit : à l'exécution.
    const doc = fs.readFileSync(DOC, 'utf-8');
    const known = new Set(MCP_TOOL_NAMES);
    const ghosts: string[] = [];

    for (const line of doc.split('\n')) {
      if (!line.startsWith('|')) continue;
      const firstCell = line.split('|')[1] ?? '';
      for (const m of firstCell.matchAll(/`(bclaw_[a-z_]+)/g)) {
        if (!known.has(m[1]) && !ghosts.includes(m[1])) ghosts.push(m[1]);
      }
    }

    assert.deepEqual(
      ghosts, [],
      `outils PRESCRITS par mcp.md mais absents du catalogue : ${ghosts.join(', ')}`,
    );
  });
});
