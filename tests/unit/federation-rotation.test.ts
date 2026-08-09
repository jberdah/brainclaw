/**
 * Rotation d'epoch et quorum de récupération (pln#658, dec#163 §3-§4).
 *
 * CE QUE CES TESTS GÈLENT, ce sont des PROMESSES faites à l'opérateur :
 *  • le quorum BLOQUE réellement (il était rapporté et jamais bloquant — mesuré) ;
 *  • le consentement solo le lève, et il est PERSISTÉ ;
 *  • la rotation ne retire à personne le passé qu'il détient déjà (dec#163 §3) ;
 *  • le cutover fait basculer les ÉCRITURES, pas les lectures.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import {
  createConnectionState, newDeviceId, saveConnectionState, loadConnectionState,
} from '../../src/core/federation-state.js';
import { storeEpochPrivateKey, heldEpochs } from '../../src/core/federation-keyring.js';
import { rotateEpoch, acceptSoloRecoveryRisk } from '../../src/core/federation-rotation.js';
import { nowISO } from '../../src/core/ids.js';

const PROJECT = 'prj_rotate_test';

function seedSolo(cwd: string, home: string, epoch = 1): void {
  const state = createConnectionState({
    cloudProjectId: PROJECT,
    workspacePath: cwd,
    device: {
      device_id: newDeviceId(), x25519_fingerprint: 'fp_x', attested_by_ed25519: 'fp_ed',
      enrolled_at: nowISO(), recovery: true,
    },
  });
  state.enrollment = { stage: 'active', updated_at: nowISO() };
  state.keys = { current_epoch: epoch, known_epochs: [epoch] };
  saveConnectionState(state, cwd);
  const key = crypto.generateKeyPairSync('x25519');
  storeEpochPrivateKey(PROJECT, epoch, key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), home);
}

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-rot-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

describe('rotation d\'epoch — le quorum est APPLIQUÉ', () => {
  it('REFUSE de tourner en solo sans consentement, et NOMME le remède', () => {
    // Le point de dec#163 §4 : `recoveryReadiness` était rapporté et jamais bloquant.
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        const out = rotateEpoch({ cwd: ws.dir, home });
        assert.equal(out.ok, false);
        assert.equal(out.ok === false && out.reason, 'recovery_quorum');
        // Un refus sans issue ferait chercher --force en premier : le remède doit être écrit.
        assert.match(out.ok === false ? out.remedy : '', /accept-solo-risk|second appareil/i);
      });
    } finally { ws.cleanup(); }
  });

  it('le consentement solo est PERSISTÉ et lève le refus', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        const consent = acceptSoloRecoveryRisk(ws.dir);
        assert.ok(consent.accepted_at);
        assert.match(consent.statement, /perte définitive/i);

        const out = rotateEpoch({ cwd: ws.dir, home });
        assert.equal(out.ok, true, 'le consentement doit lever le refus de quorum');
        assert.equal(out.ok === true && out.new_epoch, 2);
      });
    } finally { ws.cleanup(); }
  });

  it('réaccepter ne réécrit pas la date d\'origine — « quand a-t-il compris ? » a UNE réponse', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        const first = acceptSoloRecoveryRisk(ws.dir);
        const again = acceptSoloRecoveryRisk(ws.dir);
        assert.equal(again.accepted_at, first.accepted_at);
      });
    } finally { ws.cleanup(); }
  });
});

describe('rotation d\'epoch — ce qu\'elle fait et ne fait pas', () => {
  it('le PASSÉ reste lisible après rotation (dec#163 §3 : forward-only)', () => {
    // La promesse la plus facile à trahir par accident : faire tourner la clé ET perdre
    // l'ancienne rendrait tout l'historique illisible pour nous aussi.
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        acceptSoloRecoveryRisk(ws.dir);
        const out = rotateEpoch({ cwd: ws.dir, home });
        assert.equal(out.ok, true);
        const readable = out.ok === true ? out.readable_epochs : [];
        assert.ok(readable.includes(1), "l'epoch 1 doit rester lisible");
        assert.ok(readable.includes(2), 'le nouvel epoch doit être détenu');
        assert.deepEqual(heldEpochs(PROJECT, home).sort(), [1, 2]);
      });
    } finally { ws.cleanup(); }
  });

  it('le CUTOVER fait basculer les écritures sur le nouvel epoch', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        acceptSoloRecoveryRisk(ws.dir);
        rotateEpoch({ cwd: ws.dir, home });
        // `emitProjections` scelle sous `current_epoch` : c'est CE champ qui fait le cutover.
        assert.equal(loadConnectionState(ws.dir)?.keys.current_epoch, 2);
      });
    } finally { ws.cleanup(); }
  });

  it('annonce explicitement que la rotation ne retire pas le passé au révoqué', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        acceptSoloRecoveryRisk(ws.dir);
        const out = rotateEpoch({ cwd: ws.dir, home });
        // Promettre plus que ce que la crypto tient est le pire défaut possible ici.
        assert.match(out.ok === true ? out.forward_only_notice : '', /détient DÉJÀ|relire/i);
      });
    } finally { ws.cleanup(); }
  });

  it('une rotation déjà faite est CONSTATÉE, pas refaite (reprise après interruption)', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        acceptSoloRecoveryRisk(ws.dir);
        const first = rotateEpoch({ cwd: ws.dir, home });
        const fp = first.ok === true ? first.new_epoch_fingerprint : '';
        // Simule une interruption : l'epoch 2 existe, mais l'état est resté à 1.
        const state = loadConnectionState(ws.dir)!;
        saveConnectionState({ ...state, keys: { ...state.keys, current_epoch: 1 } }, ws.dir);

        const second = rotateEpoch({ cwd: ws.dir, home });
        assert.equal(second.ok, true);
        assert.equal(second.ok === true && second.new_epoch_fingerprint, fp,
          'la clé d\'epoch 2 ne doit pas être régénérée — cela rendrait illisible ce qui a déjà été scellé');
      });
    } finally { ws.cleanup(); }
  });

  it('REFUSE si cet appareil ne détient pas l\'epoch courant', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-rot-' });
    try {
      withHome((home) => {
        seedSolo(ws.dir, home);
        const state = loadConnectionState(ws.dir)!;
        // L'état prétend être à l'epoch 5, mais le disque n'en détient pas la clé.
        saveConnectionState({ ...state, keys: { current_epoch: 5, known_epochs: [5] } }, ws.dir);
        const out = rotateEpoch({ cwd: ws.dir, home });
        assert.equal(out.ok, false);
        assert.equal(out.ok === false && out.reason, 'not_holder');
      });
    } finally { ws.cleanup(); }
  });
});
