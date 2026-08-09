/**
 * Correspondance id local ↔ id opaque.
 *
 * ── LES DEUX PROPRIÉTÉS QUI COMPTENT, ET ELLES S'OPPOSENT ────────────────────
 * STABILITÉ : sans elle, chaque émission créerait un nouvel objet côté cloud et le board
 * afficherait un doublon à chaque mise à jour.
 * NON-CALCULABILITÉ : l'opaque ne doit pas se déduire du local. Un hachage non clefé
 * serait stable ET réversible par devinette — le cloud connaît la forme des ids locaux
 * (`pln_` + hexadécimal court) et n'aurait qu'à énumérer pour confirmer une correspondance,
 * apprenant ainsi le compteur local et l'ordre de création.
 *
 * Une table locale satisfait les deux. Ces tests gèlent le fait qu'elle les satisfasse
 * encore après une refonte.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import { opaqueIdFor, opaqueMapSize } from '../../src/core/federation-opaque-ids.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ids opaques — stabilité', () => {
  it('rend le MÊME opaque pour le même objet, appel après appel', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      const a = opaqueIdFor('prj_cloud', 'pln_123', ws.dir);
      const b = opaqueIdFor('prj_cloud', 'pln_123', ws.dir);
      assert.equal(a, b, 'un opaque instable créerait un doublon cloud à chaque émission');
      assert.match(a, UUID_RE, 'le projecteur exige un UUID v4');
    } finally { ws.cleanup(); }
  });

  it('survit à un redémarrage — la table est sur disque', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      const first = opaqueIdFor('prj_cloud', 'pln_persist', ws.dir);
      // Aucune mémoire de processus n'est réutilisée ici : la seconde lecture repart du
      // fichier, comme le ferait une commande lancée demain.
      const file = path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'opaque-ids.json');
      assert.ok(fs.existsSync(file), 'la table doit être persistée');
      assert.equal(opaqueIdFor('prj_cloud', 'pln_persist', ws.dir), first);
    } finally { ws.cleanup(); }
  });
});

describe('ids opaques — cloisonnement', () => {
  it('deux objets locaux distincts ne partagent jamais un opaque', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      assert.notEqual(opaqueIdFor('prj_cloud', 'pln_a', ws.dir), opaqueIdFor('prj_cloud', 'pln_b', ws.dir));
    } finally { ws.cleanup(); }
  });

  it('le MÊME objet projeté vers deux clouds reçoit deux opaques DIFFÉRENTS', () => {
    // Sinon deux clouds pourraient recouper leurs tables et découvrir qu'ils regardent le
    // même objet — une corrélation que rien d'autre ne leur donne.
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      const one = opaqueIdFor('prj_cloud_1', 'pln_shared', ws.dir);
      const two = opaqueIdFor('prj_cloud_2', 'pln_shared', ws.dir);
      assert.notEqual(one, two, 'deux clouds peuvent corréler leurs objets');
    } finally { ws.cleanup(); }
  });
});

describe('ids opaques — non-calculabilité', () => {
  it("l'opaque ne contient AUCUN fragment de l'id local", () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      const local = 'pln_5047fdb1';
      const opaque = opaqueIdFor('prj_cloud', local, ws.dir);
      assert.ok(!opaque.includes('5047fdb1'), "l'id local transparaît dans l'opaque");
      assert.ok(!opaque.includes('pln'), "le préfixe de famille transparaît dans l'opaque");
    } finally { ws.cleanup(); }
  });

  it('deux magasins produisent des opaques différents pour le même id local', () => {
    // La preuve que l'opaque n'est PAS une fonction du seul id local : deux machines
    // partant du même objet n'aboutissent pas au même opaque. C'est exactement ce qu'un
    // hachage non clefé ne garantirait pas.
    const a = createTestWorkspace({ prefix: 'bclaw-opaque-a-' });
    const b = createTestWorkspace({ prefix: 'bclaw-opaque-b-' });
    try {
      assert.notEqual(
        opaqueIdFor('prj_cloud', 'pln_same', a.dir),
        opaqueIdFor('prj_cloud', 'pln_same', b.dir),
        'l\'opaque est calculable depuis l\'id local — le cloud peut le deviner par énumération',
      );
    } finally { a.cleanup(); b.cleanup(); }
  });
});

describe('ids opaques — diagnostic', () => {
  it('compte les correspondances par projet cloud', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-opaque-' });
    try {
      opaqueIdFor('prj_x', 'a', ws.dir);
      opaqueIdFor('prj_x', 'b', ws.dir);
      opaqueIdFor('prj_y', 'c', ws.dir);
      assert.equal(opaqueMapSize('prj_x', ws.dir), 2);
      assert.equal(opaqueMapSize('prj_y', ws.dir), 1);
    } finally { ws.cleanup(); }
  });
});
