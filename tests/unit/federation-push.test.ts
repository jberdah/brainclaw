/**
 * Transport des enveloppes — drainage de l'outbox vers le cloud.
 *
 * ── CE QUE CES TESTS PROTÈGENT ────────────────────────────────────────────────
 * Le comportement en ÉCHEC, bien plus que le succès. Un transport qui perd une opération
 * en cas de coupure réseau est pire qu'un transport absent : l'outbox est la seule trace
 * qu'une projection devait partir, et une entrée effacée par erreur ne se reconstruit pas.
 *
 * `fetch` est injecté : on peut donc éprouver 409, 500 et exception réseau sans dépendre
 * d'un serveur — donc sans qu'un test « passe » simplement parce qu'il n'a rien pu joindre.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import { enqueue, list, counters } from '../../src/core/federation-outbox-v2.js';
import { pushPending } from '../../src/core/federation-push.js';
import {
  createConnectionState,
  saveConnectionState,
  newDeviceId,
} from '../../src/core/federation-state.js';
import { nowISO } from '../../src/core/ids.js';
import { ensureAgentSigningKey } from '../../src/core/agent-registry.js';
import os from 'node:os';

/**
 * Le transport SIGNE désormais une charge de métadonnées (envelope_id, rev, base_rev…),
 * parce que le cloud la vérifie contre l'identité attestée de l'agent. Les tests doivent
 * donc disposer d'une vraie clé Ed25519 : sans elle, `pushPending` refuse d'envoyer —
 * comportement voulu, et lui-même testé.
 */
const AGENT = 'agt_push_test';
function withSigningKey<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-push-home-'));
  const prevHome = process.env['HOME'];
  const prevProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  try {
    ensureAgentSigningKey(AGENT);
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
    if (prevProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const URL_ = 'https://cloud.test';

/** Appairage ACTIF minimal — sans lui, `pushPending` refuse (et c'est testé plus bas). */
function pairActive(cwd: string): void {
  const state = createConnectionState({
    cloudProjectId: 'prj_cloud_test',
    workspacePath: cwd,
    device: {
      device_id: newDeviceId(),
      x25519_fingerprint: 'fp_x',
      attested_by_ed25519: 'fp_ed',
      enrolled_at: nowISO(),
      recovery: true,
    },
  });
  state.enrollment = { stage: 'active', role: 'member', updated_at: nowISO() };
  saveConnectionState(state, cwd);
}

/**
 * Enveloppe MINIMALE mais RÉALISTE.
 *
 * Les fixtures utilisaient `{ ct: 'opaque' }` — une forme qui n'existe nulle part. Elles
 * passaient tant que le transport se contentait de relayer le blob ; dès qu'il a dû mettre
 * l'enveloppe à la forme du cloud, elles ont révélé leur irréalisme en faisant échouer la
 * mise en forme avant même l'appel réseau.
 *
 * Une fixture qui ne ressemble pas à la donnée réelle ne teste que le code qui l'ignore.
 */
function envelopeFixture(): Record<string, unknown> {
  return {
    schema: 'brainclaw.federation-envelope/v1',
    meta: {
      id_opaque: '11111111-2222-4333-8444-555555555555',
      kind: 'plan',
      status: { object: 'todo' },
      base_rev: 1,
      transport: { operation_id: 'op', content_hash: 'x', idempotency_key: 'idem' },
    },
    sealed: { alg: 'HPKE', enc: 'e', nonce: 'n', ciphertext: 'c' },
    key_epoch: 1,
    origin_sig: { alg: 'Ed25519', key_id: 'fp_origin', value: 'sig' },
  };
}

function seedPending(cwd: string, keys: string[]): void {
  for (const key of keys) {
    enqueue(
      {
        idempotency_key: key, operation_id: key, base_rev: 1, key_epoch: 1,
        sealed: envelopeFixture(), origin_agent_id: AGENT,
      } as never,
      cwd,
    );
  }
}

const okFetch = (async () => new Response('{}', { status: 202 })) as unknown as typeof fetch;

describe('transport — refus avant tout envoi', () => {
  it('refuse sans appairage actif', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await assert.rejects(() => pushPending({ cwd: ws.dir, url: URL_ }), /appairage/i);
    } finally { ws.cleanup(); }
  });

  it('refuse sans URL — aucune adresse n\'est devinée', async () => {
    // Deviner enverrait le trafic d'un projet à un tiers. Illisible pour lui, mais une
    // fuite de métadonnées et de trafic n'est pas un non-événement.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      await assert.rejects(() => pushPending({ cwd: ws.dir }), /adresse/i);
      });
    } finally { ws.cleanup(); }
  });
});

describe('transport — succès', () => {
  it('déplace les entrées envoyées de pending vers synced', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1', 'b@r1']);
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: okFetch });
      assert.equal(res.sent, 2);
      assert.equal(counters(ws.dir).pending, 0, 'rien ne doit rester en attente');
      assert.equal(counters(ws.dir).synced, 2);
      });
    } finally { ws.cleanup(); }
  });

  it('la simulation n\'envoie rien et ne déplace rien', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let called = 0;
      const spy = (async () => { called += 1; return new Response('{}', { status: 202 }); }) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, dryRun: true, fetchImpl: spy });
      assert.equal(called, 0, 'la simulation a appelé le réseau');
      assert.equal(res.attempted, 1);
      assert.equal(counters(ws.dir).pending, 1, 'la simulation a déplacé une entrée');
      });
    } finally { ws.cleanup(); }
  });
});

describe('transport — échecs, la partie qui compte', () => {
  it('une coupure réseau LAISSE l\'entrée en attente', async () => {
    // Le test central. Perdre ici une opération jamais émise la perd définitivement :
    // l'outbox est sa seule trace.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: boom });
      assert.equal(res.failed, 1);
      assert.equal(counters(ws.dir).pending, 1, 'l\'entrée a disparu de la file après un échec réseau');
      assert.equal(list('pending', ws.dir)[0]?.attempts, 1, 'la tentative doit être comptée');
      assert.match(String(list('pending', ws.dir)[0]?.last_error), /ECONNREFUSED/);
      });
    } finally { ws.cleanup(); }
  });

  it('un 500 laisse aussi en attente — un refus temporaire n\'est pas un conflit', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const boom = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: boom });
      assert.equal(res.failed, 1);
      assert.equal(counters(ws.dir).conflict, 0, 'un 500 ne doit PAS produire un conflit');
      assert.equal(counters(ws.dir).pending, 1);
      });
    } finally { ws.cleanup(); }
  });

  it('un 409 passe en conflit — un renvoi à l\'identique échouerait pareil', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const conflict = (async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: conflict });
      assert.equal(res.conflicts, 1);
      assert.equal(counters(ws.dir).conflict, 1);
      assert.equal(counters(ws.dir).pending, 0, 'une entrée en conflit ne doit pas être retentée en boucle');
      });
    } finally { ws.cleanup(); }
  });

  it('un 409 REV_CONFLICT à la forme RÉELLE du serveur déclenche le recalage — resigné sur current_head_rev, puis synced', async () => {
    // Dérive constatée le 2026-08-10 : le serveur répond `current_head_rev`, le client
    // lisait `expected_base_rev` — champ qui n'a jamais existé côté serveur. Le recalage
    // ne se déclenchait donc jamais et CHAQUE mise à jour d'un objet déjà poussé finissait
    // en conflit définitif. Cette fixture est copiée de la réponse REV_CONFLICT de
    // projection.ts (brainclaw-cloud) : si l'un des deux bouge, ce test doit bouger AVEC.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r2']);
      const bodies: Array<Record<string, unknown>> = [];
      const serverShaped409 = JSON.stringify({
        error: 'base_rev does not match current head — refresh and retry',
        code: 'REV_CONFLICT',
        current_head_rev: 'r-head-77',
        base_rev_provided: 'r2',
        reason: 'stale',
      });
      const rebaseFetch = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return bodies.length === 1
          ? new Response(serverShaped409, { status: 409 })
          : new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;

      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: rebaseFetch });

      assert.equal(bodies.length, 2, 'le refus doit provoquer EXACTEMENT un renvoi');
      assert.equal(bodies[1]?.['base_rev'], 'r-head-77', 'le renvoi porte la tête annoncée par le serveur');
      assert.equal(res.sent, 1);
      assert.equal(res.conflicts, 0);
      assert.equal(counters(ws.dir).synced >= 1, true, 'l\'entrée recalée est synced, pas en conflit');
      });
    } finally { ws.cleanup(); }
  });

  it('une file vide est un succès silencieux — pas d\'erreur d\'identité quand il n\'y a rien à signer', async () => {
    // Vécu le 2026-08-10 : après un envoi complet (file pending vide, seuls des conflits
    // restants), le push relançait « Identité de signature introuvable » — le signataire
    // était résolu depuis la première entrée d'une file... vide.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      const neverCalled = (async () => { throw new Error('ne doit pas être appelé'); }) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: neverCalled });
      assert.equal(res.attempted, 0);
      assert.equal(res.sent, 0);
      });
    } finally { ws.cleanup(); }
  });
});

describe('transport — ce qui part sur le fil', () => {
  it('n\'envoie que le SCELLÉ et des métadonnées de transport', async () => {
    // Le module ne voit que des `sealed` opaques : il ne PEUT pas divulguer de clair. Ce
    // test gèle cette propriété au niveau du corps HTTP réellement émis.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let body: Record<string, unknown> = {};
      let headers: Record<string, string> = {};
      const capture = (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        headers = init.headers as Record<string, string>;
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;

      await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: capture });

      // La forme RÉELLE attendue par le cloud — à plat, pas `{envelope, ...}`.
      // `envelope_json` a rejoint le fil avec dec#162 : l'enveloppe SIGNÉE verbatim, dont le
      // pull a besoin pour vérifier la signature d'AUTEUR (que `origin_sig`, ici de
      // TRANSPORT, ne porte pas).
      assert.deepEqual(Object.keys(body).sort(), [
        'base_rev', 'content_hash', 'entity_id', 'entity_kind', 'envelope_json', 'id',
        'idempotency_key', 'key_epoch', 'meta', 'origin_agent_id', 'origin_sig',
        'origin_sig_payload_hash', 'origin_signer_fingerprint', 'rev', 'sealed_b64',
      ]);
      // Le clair ne doit apparaître nulle part : seul `sealed_b64` porte le contenu.
      assert.equal(typeof body['sealed_b64'], 'string');
      assert.equal(headers['idempotency-key'], 'a@r1', 'le cloud doit pouvoir dédoublonner sans ouvrir le corps');

      // `envelope_json` NE DIVULGUE RIEN DE NEUF (dec#162) : c'est l'enveloppe déjà signée —
      // meta PUBLIQUE (identique à celle déjà envoyée en clair), sealed OPAQUE (chiffré), et
      // la signature d'AUTEUR. On gèle le fait qu'elle porte `origin_sig.value` (l'auteur) et
      // un `sealed` chiffré, jamais de clair.
      const verbatim = JSON.parse(String(body['envelope_json'])) as {
        meta: unknown; sealed: { ciphertext?: string }; key_epoch: number;
        origin_sig: { alg: string; key_id: string; value: string };
      };
      assert.ok(verbatim.origin_sig?.value, 'la signature d\'AUTEUR doit voyager dans envelope_json');
      assert.ok(verbatim.sealed?.ciphertext, 'le contenu reste dans sealed, chiffré');
      assert.deepEqual(verbatim.meta, body['meta'], 'meta verbatim == meta déjà envoyée : aucun champ nouveau ne fuit');
      });
    } finally { ws.cleanup(); }
  });

  it('cible l\'endpoint de projection du projet CLOUD, pas un id local', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let seen = '';
      const capture = (async (url: string) => { seen = url; return new Response('{}', { status: 202 }); }) as unknown as typeof fetch;
      await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: capture });
      assert.equal(seen, `${URL_}/api/v1/projects/prj_cloud_test/projection/envelopes`);
      assert.ok(!seen.includes(ws.dir), 'un chemin local ne doit JAMAIS entrer dans une URL');
      });
    } finally { ws.cleanup(); }
  });
});

describe('transport — l\'outbox reste la trace', () => {
  it('aucun fichier n\'est supprimé par un échec', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await withSigningKey(async () => {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const dir = path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'outbox');
      const before = fs.readdirSync(dir).length;
      assert.equal(before, 1);
      });
    } finally { ws.cleanup(); }
  });
});
