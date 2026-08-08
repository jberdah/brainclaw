/**
 * Contrat d'attestation de clé, côté CLIENT (pln#651 étape 4, RFC §5.2).
 *
 * ── CE FICHIER A UN JUMEAU, ET C'EST DÉLIBÉRÉ ─────────────────────────────────
 * Le même contrat existe côté Cloud dans `brainclaw-cloud/src/lib/attestation.ts`.
 * Les deux DOIVENT produire octet pour octet la même chaîne : le CLI signe, le Worker
 * vérifie. Ils ne peuvent pas partager un module — deux dépôts, deux runtimes (Node ici,
 * Workers là-bas) — donc la duplication est assumée et le gel de la forme est verrouillé
 * DES DEUX CÔTÉS par un test sur le littéral exact.
 *
 * Ce n'est pas une précaution théorique. La première livraison côté Cloud reconstruisait
 * `created_at` avec l'horloge du serveur au moment de l'approbation : la signature portait
 * sur d'autres octets que ceux vérifiés, et AUCUN appairage ne pouvait aboutir. Le défaut
 * a survécu à un typecheck vert parce que rien n'exerçait les deux côtés ensemble.
 *
 * RÈGLE QUI EN DÉCOULE, valable au-delà de ce fichier : tout champ couvert par une
 * signature doit venir du signataire, ou d'une valeur qu'il connaît déjà. Un champ que le
 * vérificateur fabrique lui-même ne peut pas être signé.
 */

import crypto from 'node:crypto';

export interface AttestationPayloadInput {
  enrollment_id: string;
  project_id: string;
  agent_id: string;
  key_type: string;
  key_purpose: string;
  key_fingerprint: string;
  key_epoch: number;
  /** Horodatage CHOISI PAR CET APPAREIL. Le serveur le stocke et le rejoue tel quel. */
  created_at: string;
}

/**
 * Payload canonique de l'attestation.
 *
 * LA FORME EST GELÉE. Changer l'ordre des clés ou ajouter un champ invalide toutes les
 * attestations déjà émises — ce qui est voulu, mais doit être un acte délibéré, jamais
 * l'effet de bord d'une refactorisation. Le test de gel existe pour cela.
 */
export function attestationPayload(input: AttestationPayloadInput): string {
  return JSON.stringify({
    v: 1,
    kind: 'brainclaw.federation.v2.key_attestation',
    enrollment_id: input.enrollment_id,
    project_id: input.project_id,
    agent_id: input.agent_id,
    key_type: input.key_type,
    key_purpose: input.key_purpose,
    key_fingerprint: input.key_fingerprint,
    key_epoch: input.key_epoch,
    created_at: input.created_at,
  });
}

/**
 * Empreinte canonique d'un PEM — MÊME RÈGLE que `fingerprintPublicKeyPem` d'agent-registry
 * et que `fingerprintPem` côté Cloud.
 *
 * Le retrait des CR et le trim ne sont pas cosmétiques : le même PEM traversant un champ
 * JSON ou un éditeur Windows ressort avec un CRLF ou un saut de ligne final. Sans
 * canonicalisation, deux représentations de LA MÊME clé donnent deux empreintes
 * différentes — et la comparaison locale↔distante, qui EST la preuve d'identité de la
 * clé, échouerait sur une différence invisible à l'œil.
 */
export function fingerprintPem(pem: string): string {
  return crypto.createHash('sha256').update(pem.replace(/\r/g, '').trim()).digest('hex');
}

/**
 * Signe des octets avec une clé privée Ed25519 au format PEM, en base64.
 *
 * Ed25519 ne prend pas d'algorithme de hachage séparé — d'où le `null` en premier
 * argument, qui n'est pas un oubli : passer un digest ici lèverait.
 */
export function signEd25519(privateKeyPem: string, message: Uint8Array): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(message), key).toString('base64');
}

/**
 * Construit et signe l'attestation liant la clé de chiffrement X25519 de l'appareil à son
 * identité Ed25519.
 *
 * C'EST LA PIÈCE QUI EMPÊCHE LE MEMBRE FANTÔME. Sans elle, le Cloud — qui orchestre
 * l'appairage — pourrait insérer sa propre clé dans la liste d'enveloppement : un
 * chiffrement de bout en bout dont l'échange de clés serait arbitré par la partie même
 * qu'il prétend neutraliser.
 *
 * Retourne aussi l'horodatage, que l'appelant DOIT transmettre au serveur : sans lui, le
 * vérificateur ne peut pas reconstruire les octets signés.
 */
export function buildKeyAttestation(params: {
  enrollmentId: string;
  projectId: string;
  agentId: string;
  encryptionPublicKeyPem: string;
  identityPrivateKeyPem: string;
  keyEpoch?: number;
  createdAt: string;
}): { payload: string; signature: string; created_at: string; key_fingerprint: string } {
  const keyFingerprint = fingerprintPem(params.encryptionPublicKeyPem);
  const payload = attestationPayload({
    enrollment_id: params.enrollmentId,
    project_id: params.projectId,
    agent_id: params.agentId,
    key_type: 'encryption',
    key_purpose: 'envelope',
    key_fingerprint: keyFingerprint,
    key_epoch: params.keyEpoch ?? 1,
    created_at: params.createdAt,
  });
  return {
    payload,
    signature: signEd25519(params.identityPrivateKeyPem, new TextEncoder().encode(payload)),
    created_at: params.createdAt,
    key_fingerprint: keyFingerprint,
  };
}
