/**
 * Rotation d'epoch — retirer la LECTURE FUTURE à un appareil (pln#658, dec#163).
 *
 * ── CE QUE LA ROTATION FAIT, ET CE QU'ELLE NE PEUT PAS FAIRE ──────────────────
 * Elle crée un epoch N+1 dont le révoqué n'a pas la clé, et fait basculer les écritures
 * dessus. À partir du cutover, il ne lit plus RIEN de nouveau.
 *
 * Elle ne lui retire PAS ce qu'il détient déjà. C'est cryptographiquement impossible : une
 * clé copiée sur une machine y reste. Le prétendre serait mentir, et dec#163 §3 l'interdit
 * explicitement. La révocation est FORWARD-ONLY, et c'est dit à l'opérateur en toutes
 * lettres au moment où il tourne la clé — pas dans une note de bas de page.
 *
 * ── LE QUORUM EST APPLIQUÉ ICI, ET SEULEMENT ICI (dec#163 §4) ─────────────────
 * « Émettre au-delà du premier epoch » = créer un epoch N+1. C'est le moment exact où la
 * perte d'une machine cesse d'être théorique : après rotation, l'ancien epoch ne sert plus
 * qu'à relire le passé, et si personne d'autre ne détient le nouveau, une panne de disque
 * emporte tout le futur. `recoveryReadiness` était RAPPORTÉ et jamais bloquant (mesuré) —
 * il devient une condition.
 *
 * En solo, l'opérateur peut passer outre, mais son consentement est PERSISTÉ : on ne
 * demande pas deux fois, et surtout on garde la trace qu'il a été demandé.
 */

import crypto from 'node:crypto';
import {
  loadConnectionState,
  saveConnectionState,
  recoveryReadiness,
  type FederationConnectionState,
} from './federation-state.js';
import { storeEpochPrivateKey, epochPublicKey, heldEpochs } from './federation-keyring.js';

export interface RotationRefusal {
  ok: false;
  reason: 'no_pairing' | 'not_holder' | 'recovery_quorum';
  detail: string;
  /** Ce que l'opérateur peut faire pour lever le refus — jamais un cul-de-sac. */
  remedy: string;
}

export interface RotationSuccess {
  ok: true;
  previous_epoch: number;
  new_epoch: number;
  new_epoch_fingerprint: string;
  /** Les epochs encore lisibles APRÈS rotation : le passé n'est pas perdu pour nous. */
  readable_epochs: number[];
  /** Rappel affiché à l'opérateur — la rotation ne réécrit pas le passé. */
  forward_only_notice: string;
}

export type RotationResult = RotationSuccess | RotationRefusal;

export const FORWARD_ONLY_NOTICE =
  "La rotation ne retire à personne ce qu'il détient DÉJÀ : un appareil révoqué peut " +
  "toujours relire ce qui a été scellé avant le cutover. Elle ferme la lecture du FUTUR, " +
  'pas celle du passé — aucune cryptographie ne peut faire autrement.';

/** Consentement solo persisté (dec#163 §4) : demandé une fois, jamais redemandé, jamais oublié. */
export interface SoloRecoveryConsent {
  accepted_at: string;
  /** Texte exact accepté — pour qu'un audit ultérieur sache ce qui a été compris. */
  statement: string;
}

const SOLO_CONSENT_STATEMENT =
  "Je comprends que la perte de cette machine signifie la perte définitive de l'historique " +
  'scellé : aucune restauration côté cloud ne le ramènera.';

export function soloConsentStatement(): string {
  return SOLO_CONSENT_STATEMENT;
}

function readConsent(state: FederationConnectionState): SoloRecoveryConsent | undefined {
  return (state as unknown as { solo_recovery_consent?: SoloRecoveryConsent }).solo_recovery_consent;
}

/**
 * Enregistre le consentement solo. Idempotent : réaccepter ne réécrit pas la date d'origine,
 * parce que la question « quand cette personne a-t-elle compris le risque ? » a UNE réponse.
 */
export function acceptSoloRecoveryRisk(cwd?: string): SoloRecoveryConsent {
  const state = loadConnectionState(cwd ?? process.cwd());
  if (!state) throw new Error('Aucun appairage local : rien à consentir.');
  const existing = readConsent(state);
  if (existing) return existing;
  const consent: SoloRecoveryConsent = {
    accepted_at: new Date().toISOString(),
    statement: SOLO_CONSENT_STATEMENT,
  };
  saveConnectionState(
    { ...state, ...({ solo_recovery_consent: consent } as Partial<FederationConnectionState>) },
    cwd ?? process.cwd(),
  );
  return consent;
}

/**
 * Fait tourner l'epoch : crée N+1 localement et bascule les écritures dessus.
 *
 * NE REMET RIEN AUX AUTRES — c'est délibérément une seconde étape (`cloud grant`). Coupler
 * les deux ferait qu'un échec de remise laisserait un cutover à moitié fait : les écritures
 * seraient déjà passées sous N+1 pendant que les lecteurs légitimes n'auraient pas la clé.
 * Le résultat NOMME donc les destinataires à re-servir.
 */
export function rotateEpoch(options: { cwd?: string; force?: boolean; home?: string } = {}): RotationResult {
  const cwd = options.cwd ?? process.cwd();
  const state = loadConnectionState(cwd);
  if (!state) {
    return {
      ok: false, reason: 'no_pairing',
      detail: 'Aucun appairage local.',
      remedy: 'Appairer cet appareil avant toute rotation (`brainclaw cloud connect`).',
    };
  }

  const held = heldEpochs(state.cloud_project_id, options.home);
  const current = state.keys?.current_epoch ?? 0;
  if (current <= 0 || !held.includes(current)) {
    return {
      ok: false, reason: 'not_holder',
      detail: `Cet appareil ne détient pas l'epoch courant (${current}) — il ne peut pas en produire le suivant.`,
      remedy: "Se faire remettre l'epoch courant par un détenteur (`brainclaw cloud grant`) avant de tourner.",
    };
  }

  // ── LE QUORUM, APPLIQUÉ (dec#163 §4) ────────────────────────────────────────
  const readiness = recoveryReadiness(state);
  const consent = readConsent(state);
  if (!readiness.ready && !consent && !options.force) {
    return {
      ok: false, reason: 'recovery_quorum',
      detail:
        `${readiness.reason ?? 'Quorum de récupération non atteint.'} ` +
        "Tourner l'epoch maintenant ferait dépendre TOUT le futur du projet de cette seule machine.",
      remedy:
        "Appairer un second appareil de récupération, OU accepter explicitement le risque " +
        '(`brainclaw cloud accept-solo-risk`), ce qui sera consigné avec sa date.',
    };
  }

  const next = current + 1;
  // Ne jamais écraser : si N+1 existe déjà, c'est qu'une rotation a déjà eu lieu (reprise
  // après interruption). On la constate au lieu d'en fabriquer une seconde.
  const already = epochPublicKey(state.cloud_project_id, next, options.home);
  if (!already) {
    const generated = crypto.generateKeyPairSync('x25519');
    storeEpochPrivateKey(
      state.cloud_project_id, next,
      generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      options.home,
    );
  }
  const materialized = epochPublicKey(state.cloud_project_id, next, options.home);
  if (!materialized) {
    // Vérifier APRÈS écriture : basculer les écritures sur une clé qu'on ne relit pas
    // produirait des enveloppes que PERSONNE ne peut ouvrir, y compris nous.
    throw new Error(
      `Epoch ${next} écrit mais non relisible — le cutover est ANNULÉ pour ne pas sceller ` +
      'sous une clé fantôme.',
    );
  }

  // CUTOVER : les écritures suivantes scellent sous N+1 (emitProjections lit current_epoch).
  const readable = heldEpochs(state.cloud_project_id, options.home);
  saveConnectionState({
    ...state,
    keys: { ...(state.keys ?? { current_epoch: 0, known_epochs: [] }), current_epoch: next, known_epochs: readable },
  }, cwd);

  return {
    ok: true,
    previous_epoch: current,
    new_epoch: next,
    new_epoch_fingerprint: materialized.fingerprint,
    readable_epochs: readable,
    forward_only_notice: FORWARD_ONLY_NOTICE,
  };
}
