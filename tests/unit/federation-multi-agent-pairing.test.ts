/**
 * Coexistence de PLUSIEURS agents appairés sur une même machine, un même projet.
 *
 * ── LE DÉFAUT QUE CE TEST EXHIBE (trp#1625) ──────────────────────────────────
 * `connection.json` est un singleton par workspace : il porte UN device et UN enrollment,
 * et ne mémorise même pas l'agent. Un second `beginPairing` ÉCRASE le premier — le cloud
 * garde N appareils actifs, la machine n'en connaît qu'un. Mesuré le 2026-08-09.
 *
 * ── POURQUOI DEUX ÉCRIVAINS, PAS UN ──────────────────────────────────────────
 * La leçon de PR #210 : un test qui n'exerce qu'un seul appairage ne peut pas voir cette
 * classe de défaut. Il faut faire COEXISTER deux appairages dans le même état et vérifier
 * que le second n'a pas détruit le premier — ce que seul un test à deux écrivains montre.
 *
 * Ce fichier doit être ROUGE sur le code actuel (singleton) et VERT une fois la forme v3
 * (liste de pairings) en place. La contre-épreuve de pln#653 étape 4 le repassera au rouge
 * en neutralisant la garde, pour prouver qu'il détecte bien la régression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTestWorkspace } from '../helpers/workspace.js';
import { beginPairing, type PairingTransport } from '../../src/core/federation-pairing.js';
import { loadConnectionState } from '../../src/core/federation-state.js';

/**
 * Faux cloud minimal — un enrollment_id DISTINCT par agent, même projet.
 *
 * C'est le point qui compte pour ce test : deux agents du même projet obtiennent deux
 * enrôlements différents. Un fake qui renverrait le même enrollment_id masquerait
 * précisément la collision qu'on cherche à mettre en évidence.
 */
function twoAgentCloud() {
  const enrollmentByAgent = new Map<string, string>();
  let lastIdentityPem = '';
  let lastChallenge = '';
  let lastAgent = '';

  const verify = (pem: string, msg: Uint8Array, sigB64: string): boolean => {
    try {
      return crypto.verify(null, Buffer.from(msg), crypto.createPublicKey(pem), Buffer.from(sigB64, 'base64'));
    } catch { return false; }
  };

  const transport: PairingTransport = {
    async post(path, body) {
      const b = body as Record<string, string>;
      if (path.endsWith('/enrollments/claim')) {
        lastAgent = b['agent_id'];
        lastIdentityPem = b['identity_public_key_pem'];
        lastChallenge = crypto.randomBytes(32).toString('base64url');
        const enrollmentId = enrollmentByAgent.get(lastAgent)
          ?? `enr_${crypto.randomBytes(4).toString('hex')}`;
        enrollmentByAgent.set(lastAgent, enrollmentId);
        return {
          status: 200,
          body: {
            enrollment_id: enrollmentId,
            project_id: 'cp_shared',
            state: 'pairing',
            pop_challenge: lastChallenge,
            identity_key_fingerprint: crypto.createHash('sha256')
              .update(lastIdentityPem.replace(/\r/g, '').trim()).digest('hex'),
          },
        };
      }
      if (path.includes('/prove')) {
        if (!verify(lastIdentityPem, new TextEncoder().encode(lastChallenge), b['challenge_signature'])) {
          return { status: 403, body: { error: 'Invalid PoP signature' } };
        }
        const fp = crypto.createHash('sha256')
          .update(b['encryption_public_key_pem'].replace(/\r/g, '').trim()).digest('hex');
        return { status: 200, body: { state: 'pairing', encryption_key_fingerprint: fp, awaiting: 'human_approval' } };
      }
      return { status: 404, body: { error: 'route inconnue' } };
    },
    async get() { return { status: 200, body: { enrollment: { state: 'pairing', invited_role: 'member' } } }; },
  };
  return { transport };
}

describe('appairage multi-agents — un appareil, plusieurs agents', () => {
  it('un second agent NE DÉTRUIT PAS l\'appairage du premier', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-multi-pair-' });
    const cloud = twoAgentCloud();
    try {
      const first = await beginPairing({ inviteCode: 'INV-A', agentId: 'agent-alpha', transport: cloud.transport, cwd: ws.dir });
      await beginPairing({ inviteCode: 'INV-B', agentId: 'agent-beta', transport: cloud.transport, cwd: ws.dir });

      const state = loadConnectionState(ws.dir);
      assert.ok(state, 'aucun état de connexion après deux appairages');

      // La forme v3 doit exposer les DEUX enrôlements. On lit de façon tolérante aux deux
      // formes pour que l'assertion porte sur le FAIT (les deux survivent), pas sur le
      // détail de représentation.
      const s = state as unknown as Record<string, unknown>;
      const pairings = (s['pairings'] as Array<Record<string, unknown>> | undefined) ?? [];
      const enrollmentIds = new Set(pairings.map((p) => String(p['enrollment_id'])));

      assert.equal(pairings.length, 2, `attendu 2 pairings, obtenu ${pairings.length} — le second a écrasé le premier`);
      assert.ok(enrollmentIds.has(first.enrollment_id), 'l\'enrôlement du premier agent a disparu');
    } finally {
      ws.cleanup();
    }
  });

  it('un même appareil (une seule clé X25519) sert les deux agents', async () => {
    // Cible dec#161 : les agents d'une machine PARTAGENT la clé de chiffrement de
    // l'appareil et signent chacun avec leur Ed25519. Deux devices distincts pour deux
    // agents de la même machine multiplieraient les clés de déchiffrement sans raison.
    const ws = createTestWorkspace({ prefix: 'bclaw-multi-pair-' });
    const cloud = twoAgentCloud();
    try {
      await beginPairing({ inviteCode: 'INV-A', agentId: 'agent-alpha', transport: cloud.transport, cwd: ws.dir });
      await beginPairing({ inviteCode: 'INV-B', agentId: 'agent-beta', transport: cloud.transport, cwd: ws.dir });

      const s = loadConnectionState(ws.dir) as unknown as Record<string, unknown>;
      const device = s['device'] as Record<string, unknown> | undefined;
      assert.ok(device?.['device_id'], 'l\'appareil doit rester unique et présent');
    } finally {
      ws.cleanup();
    }
  });
});
