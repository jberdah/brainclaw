/**
 * Émission des projections — plans et mémoire projet vers l'outbox.
 *
 * ── CE QUE CES TESTS PROTÈGENT ────────────────────────────────────────────────
 * Ce module est le chaînon qui manquait : avant lui, `buildEnvelope` avait ZÉRO appelant de
 * production et le cloud n'avait jamais reçu une enveloppe. Toute la fédération existait et
 * ne servait à rien. Les tests portent donc d'abord sur ce qui rendrait ce chaînon NUISIBLE
 * plutôt que simplement absent :
 *
 *   1. émettre des entités d'EXÉCUTION (claims, assignations) ferait sortir hôte, session
 *      et worktree — la classe exacte que dec#154 garde locale ;
 *   2. réémettre en double gonflerait la file d'opérations qui ne partiront jamais ;
 *   3. émettre SANS appairage produirait des enveloppes que personne ne peut lire, et le
 *      cloud les accepterait sans broncher.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace } from '../helpers/workspace.js';
import { mutateState } from '../../src/core/state.js';
import { nowISO } from '../../src/core/ids.js';
import {
  collectProjectable,
  emitProjections,
  PROJECTED_KINDS,
} from '../../src/core/federation-emit.js';
import { FEDERATED_KINDS } from '../../src/core/federation-projection.js';

function seed(cwd: string): void {
  mutateState((state) => {
    state.plan_items.push({
      id: 'pln_emit_1',
      short_label: 'pln#1',
      text: 'Plan à projeter',
      status: 'todo',
      priority: 'high',
      type: 'feat',
      tags: ['seed'],
      created_at: nowISO(),
      updated_at: nowISO(),
      author: 'seed',
      depends_on: [],
      steps: [
        { id: 'stp_emit_1', text: 'Première étape', status: 'todo', created_at: nowISO(), updated_at: nowISO() },
        { id: 'stp_emit_2', text: 'Seconde étape', status: 'done', created_at: nowISO(), updated_at: nowISO() },
      ],
    } as never);
    state.known_traps.push({
      id: 'trp_emit_1',
      short_label: 'trp#1',
      text: 'Piège à projeter',
      status: 'active',
      author: 'seed',
      severity: 'medium',
      tags: ['seed'],
      created_at: nowISO(),
    } as never);
  }, cwd);
}

describe('émission — collecte', () => {
  it('collecte les plans, leurs étapes et la mémoire projet', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      const items = collectProjectable(ws.dir);
      const kinds = items.map((i) => i.kind);
      assert.ok(kinds.includes('plan'), 'aucun plan collecté');
      assert.equal(kinds.filter((k) => k === 'plan_step').length, 2, 'les deux étapes doivent être collectées');
      assert.ok(kinds.includes('trap'), 'la mémoire projet doit être collectée');
    } finally {
      ws.cleanup();
    }
  });

  it("projette les étapes comme objets À PART, avec un lien vers leur plan", () => {
    // Imbriquer les étapes dans le plan forcerait à re-sceller tout le texte du plan pour
    // cocher une case. Le lien est une DÉPENDANCE — de la structure, que le board aveugle
    // rend sans jamais déchiffrer.
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      const step = collectProjectable(ws.dir).find((i) => i.id === 'stp_emit_1');
      assert.ok(step, 'étape introuvable');
      assert.deepEqual(step.deps, [{ from: 'stp_emit_1', to: 'pln_emit_1' }]);
      assert.equal(step.rank, 1, 'le rang porte l\'ordre des étapes');
      assert.equal(step.status, 'todo', 'une étape a son propre statut, distinct du plan');
    } finally {
      ws.cleanup();
    }
  });

  it("ne collecte AUCUNE entité d'exécution", () => {
    // Le test qui compte vraiment. claims / assignments / agent_runs / inbox_messages
    // portent hôte, session, worktree, commande, pid — exactement FORBIDDEN_LEAF_NAMES.
    // Les collecter serait le défaut le plus coûteux que ce module puisse avoir.
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      const collected = new Set(collectProjectable(ws.dir).map((i) => i.kind));
      for (const forbidden of ['claim', 'assignment', 'agent_run', 'inbox_message', 'action_required']) {
        assert.ok(!collected.has(forbidden as never), `${forbidden} ne doit JAMAIS être collecté`);
      }
    } finally {
      ws.cleanup();
    }
  });

  it('ne projette qu\'un sous-ensemble STRICT des familles fédérables', () => {
    // PROJECTED_KINDS ⊂ FEDERATED_KINDS, et strictement : si un jour les deux coïncident,
    // c'est que les entités d'exécution y sont entrées.
    const federated = new Set<string>(FEDERATED_KINDS);
    for (const kind of PROJECTED_KINDS) {
      assert.ok(federated.has(kind), `${kind} projeté mais absent de FEDERATED_KINDS`);
    }
    assert.ok(
      PROJECTED_KINDS.length < FEDERATED_KINDS.length,
      'PROJECTED_KINDS a rejoint FEDERATED_KINDS — les entités d\'exécution sont-elles entrées ?',
    );
  });
});

describe('émission — refus sans appairage', () => {
  it('REFUSE d\'émettre tant que l\'appairage n\'est pas actif', () => {
    // Émettre « au mieux » produirait des enveloppes illisibles que le cloud accepterait
    // sans broncher — une panne silencieuse qui ne se découvre qu'à la première lecture.
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      assert.throws(
        () => emitProjections({ cwd: ws.dir }),
        /appairage/i,
        'l\'émission sans appairage doit lever, pas produire une file muette',
      );
    } finally {
      ws.cleanup();
    }
  });

  it('la simulation ne met RIEN en file', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      // Sans appairage la simulation lève aussi : le contrôle d'appairage précède, ce qui
      // est voulu — annoncer « 12 objets partiraient » alors que rien ne peut partir serait
      // une promesse que l'état local ne peut pas tenir.
      assert.throws(() => emitProjections({ cwd: ws.dir, dryRun: true }), /appairage/i);
    } finally {
      ws.cleanup();
    }
  });
});

describe('émission — idempotence', () => {
  it('la clé d\'idempotence lie l\'objet À SA RÉVISION', () => {
    // `<id>@r<rev>` devient un NOM DE FICHIER dans l'outbox : deux émissions du même objet
    // à la même révision ne peuvent pas produire deux entrées. C'est le défaut de la v1,
    // qui frappait un id neuf à chaque passage et rendait le dédoublonnage impossible.
    const ws = createTestWorkspace({ prefix: 'bclaw-emit-' });
    try {
      seed(ws.dir);
      const first = collectProjectable(ws.dir);
      const second = collectProjectable(ws.dir);
      const keyOf = (i: { id: string; rev: number }) => `${i.id}@r${i.rev}`;
      assert.deepEqual(
        first.map(keyOf).sort(),
        second.map(keyOf).sort(),
        'deux collectes du même magasin doivent produire les mêmes clés — sinon rien ne dédoublonne',
      );
      assert.equal(new Set(first.map(keyOf)).size, first.length, 'clés d\'idempotence en collision');
    } finally {
      ws.cleanup();
    }
  });
});
