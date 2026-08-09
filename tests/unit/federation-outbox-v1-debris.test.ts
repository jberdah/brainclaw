/**
 * Les débris de l'outbox v1 ne doivent pas faire planter la fédération v2.
 *
 * ── LE DÉFAUT, CONSTATÉ EN PRODUCTION LE 2026-08-09 ───────────────────────────
 * dec#156 a abandonné le format de fil v1 SANS migration — décision assumée. Mais la v2
 * réutilise le MÊME répertoire sur disque (`coordination/federation/outbox`), et les
 * entrées v1 y sont restées : 129 sur le magasin de l'auteur.
 *
 * Leur forme n'a rien de commun avec la v2 — `op`, `entity_type`, `enqueued_at`,
 * `last_status` — et surtout, pas de `created_at`. Le tri final de `list()` appelait donc
 * `undefined.localeCompare`, et `brainclaw cloud status` levait une TypeError.
 *
 * C'était la PREMIÈRE commande qu'un utilisateur lance après un appairage réussi : la
 * cérémonie fonctionnait, l'agent était approuvé, et la commande qui devait le confirmer
 * rendait une trace de pile.
 *
 * ── CE QUE CE TEST GÈLE, ET CE QU'IL REFUSE DE GELER ──────────────────────────
 * Il exige que les débris soient IGNORÉS À LA LECTURE et CONSERVÉS SUR DISQUE. Les
 * supprimer serait plus propre en apparence, mais effacerait la seule trace d'opérations
 * peut-être jamais émises — et « peut-être jamais émises » est précisément ce qu'on ne
 * peut pas trancher depuis la v2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import { enqueue, list, counters, transition } from '../../src/core/federation-outbox-v2.js';

/** Débris v1 AUTHENTIQUE, recopié d'une entrée réelle du magasin de l'auteur. */
const V1_DEBRIS = {
  op: 'upsert',
  entity_type: 'claim',
  entity_id: 'clm_05e2b755',
  rev: 1,
  from_status: null,
  to_status: 'active',
  content_hash: 'sha256:deadbeef',
  payload: { scope: 'src/legacy' },
  enqueued_at: '2026-06-01T10:00:00.000Z',
  attempts: 0,
  last_status: null,
  last_error: null,
  last_attempt_at: null,
};

function outboxDir(cwd: string): string {
  return path.join(cwd, '.brainclaw', 'coordination', 'federation', 'outbox');
}

describe('outbox v2 — débris v1 dans le même répertoire', () => {
  it('ne plante pas au tri quand une entrée v1 est présente', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-outbox-v1-' });
    try {
      const dir = outboxDir(ws.dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'clm_05e2b755@r1.json'), JSON.stringify(V1_DEBRIS), 'utf-8');

      // Sans le filtre, cette ligne lève :
      // TypeError: Cannot read properties of undefined (reading 'localeCompare')
      const entries = list('pending', ws.dir);
      assert.deepEqual(entries, [], 'une entrée v1 ne doit pas être exposée comme entrée v2');
    } finally {
      ws.cleanup();
    }
  });

  it('conserve le débris SUR DISQUE — la lecture ne doit rien détruire', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-outbox-v1-' });
    try {
      const dir = outboxDir(ws.dir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'clm_05e2b755@r1.json');
      fs.writeFileSync(file, JSON.stringify(V1_DEBRIS), 'utf-8');

      list('pending', ws.dir);
      counters(ws.dir);

      assert.ok(fs.existsSync(file), 'le débris v1 a été supprimé — la seule trace d\'une opération peut-être jamais émise');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), V1_DEBRIS, 'le débris a été modifié à la lecture');
    } finally {
      ws.cleanup();
    }
  });

  it('compte correctement les entrées v2 malgré des débris v1 mêlés', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-outbox-v1-' });
    try {
      const dir = outboxDir(ws.dir);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(dir, `clm_legacy_${i}@r1.json`), JSON.stringify(V1_DEBRIS), 'utf-8');
      }

      enqueue(
        { idempotency_key: 'idem_v2_1', operation_id: 'op_1', key_epoch: 1, sealed: { ct: 'x' } } as never,
        ws.dir,
      );

      const entries = list('pending', ws.dir);
      assert.equal(entries.length, 1, `attendu 1 entrée v2, obtenu ${entries.length}`);
      assert.equal(entries[0]?.idempotency_key, 'idem_v2_1');
      // Le compteur affiché doit refléter la v2 SEULE : montrer 4 ferait croire à quatre
      // opérations en attente d'émission alors que trois ne partiront jamais.
      assert.equal(counters(ws.dir).pending, 1, 'les débris v1 sont comptés comme du travail en attente');
    } finally {
      ws.cleanup();
    }
  });
});

describe('outbox v2 — mise à jour sur place', () => {
  it("transition(pending → pending) NE SUPPRIME PAS l'entrée", () => {
    // Bug trouvé le 2026-08-09 par le test de transport « un 500 laisse aussi en attente ».
    // `from === to` est le cas légitime où un échec d'envoi note `attempts`/`last_error`
    // sans quitter la file. Sans garde, src et dest sont le MÊME chemin : on écrit puis on
    // supprime, et l'opération jamais émise perd sa seule trace — au moment précis de
    // l'incident où elle compte.
    const ws = createTestWorkspace({ prefix: 'bclaw-outbox-inplace-' });
    try {
      enqueue(
        { idempotency_key: 'x@r1', operation_id: 'op', key_epoch: 1, sealed: { ct: 'x' } } as never,
        ws.dir,
      );
      const moved = transition('x@r1', 'pending', 'pending', ws.dir, (e) => ({
        ...e,
        attempts: e.attempts + 1,
        last_error: 'HTTP 500',
      }));

      assert.equal(moved, true);
      assert.equal(counters(ws.dir).pending, 1, "l'entrée a disparu de la file");
      const entry = list('pending', ws.dir)[0];
      assert.equal(entry?.attempts, 1, 'la tentative doit être comptée');
      assert.equal(entry?.last_error, 'HTTP 500', "l'erreur doit être conservée");
    } finally {
      ws.cleanup();
    }
  });
});
