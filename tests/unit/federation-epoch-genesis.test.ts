/**
 * Genèse de la première clé d'epoch — et surtout, qui n'a PAS le droit de la créer.
 *
 * ── LE DÉFAUT QUE CES TESTS FERMENT ──────────────────────────────────────────
 * Mesuré le 2026-08-09 : `storeEpochPrivateKey` n'avait AUCUN appelant de production. Un
 * projet fraîchement appairé restait donc à `current_epoch: 0`, `known_epochs: []`, et toute
 * émission échouait sur « clé d'epoch introuvable » — la fédération était active et
 * incapable de sceller, sans qu'aucun message ne l'explique.
 *
 * ── LE DÉFAUT SYMÉTRIQUE, PLUS GRAVE ─────────────────────────────────────────
 * Laisser un appareil qui REJOINT un projet fabriquer sa propre clé produirait un second
 * epoch portant le MÊME numéro avec une clé DIFFÉRENTE. Ses enveloppes seraient illisibles
 * pour tous les autres — et rien n'échouerait à l'émission. Une panne silencieuse, découverte
 * seulement à la première lecture par un tiers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { ensureFirstEpochKey, epochPublicKey, storeEpochPrivateKey } from '../../src/core/federation-keyring.js';

function tempHome(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-epoch-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('genèse de la première clé d\'epoch', () => {
  it('crée une clé X25519 relisible quand aucune n\'existe', () => {
    const home = tempHome();
    try {
      const out = ensureFirstEpochKey('prj_genesis', 1, home.dir);
      assert.equal(out.created, true);
      assert.match(out.public_key_pem, /BEGIN PUBLIC KEY/);
      assert.ok(out.fingerprint.length > 0);

      // Relire APRÈS écriture, pas supposer : une clé qu'on croit détenir mais qui n'est
      // pas relisible produirait des enveloppes illisibles, découvertes bien plus tard.
      const reread = epochPublicKey('prj_genesis', 1, home.dir);
      assert.equal(reread?.fingerprint, out.fingerprint);
    } finally { home.cleanup(); }
  });

  it('est IDEMPOTENTE — ne réécrit jamais une clé existante', () => {
    // Réécrire rendrait illisible tout ce qui a déjà été scellé sous la clé courante.
    const home = tempHome();
    try {
      const first = ensureFirstEpochKey('prj_genesis', 1, home.dir);
      const second = ensureFirstEpochKey('prj_genesis', 1, home.dir);
      assert.equal(second.created, false, 'la seconde invocation a recréé une clé');
      assert.equal(second.fingerprint, first.fingerprint, 'l\'empreinte a changé — la clé a été remplacée');
    } finally { home.cleanup(); }
  });

  it('renvoie la clé DÉJÀ DÉTENUE sans la toucher', () => {
    const home = tempHome();
    try {
      // Simule une clé reçue par remise attestée (dec#159) : l'appareil la détient déjà.
      const { privateKey } = generateKeyPairSync('x25519');
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      storeEpochPrivateKey('prj_join', 3, pem, home.dir);
      const before = epochPublicKey('prj_join', 3, home.dir);

      const out = ensureFirstEpochKey('prj_join', 3, home.dir);
      assert.equal(out.created, false, 'une clé reçue a été écrasée par une clé forgée localement');
      assert.equal(out.fingerprint, before?.fingerprint);
    } finally { home.cleanup(); }
  });

  it('distingue les epochs — créer l\'epoch 2 ne touche pas l\'epoch 1', () => {
    const home = tempHome();
    try {
      const e1 = ensureFirstEpochKey('prj_multi', 1, home.dir);
      const e2 = ensureFirstEpochKey('prj_multi', 2, home.dir);
      assert.equal(e2.created, true);
      assert.notEqual(e1.fingerprint, e2.fingerprint, 'deux epochs partagent la même clé');
      assert.equal(epochPublicKey('prj_multi', 1, home.dir)?.fingerprint, e1.fingerprint);
    } finally { home.cleanup(); }
  });

  it('sépare les projets — deux projets ne partagent pas une clé d\'epoch', () => {
    const home = tempHome();
    try {
      const a = ensureFirstEpochKey('prj_a', 1, home.dir);
      const b = ensureFirstEpochKey('prj_b', 1, home.dir);
      assert.notEqual(a.fingerprint, b.fingerprint, 'deux projets partagent la clé de l\'epoch 1');
    } finally { home.cleanup(); }
  });
});
