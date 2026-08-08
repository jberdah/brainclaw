/**
 * `brainclaw confirm` — attester ou infirmer l'applicabilité d'un item de mémoire
 * (pln#620 étapes 2 et 3).
 *
 * ── POURQUOI CETTE COMMANDE EXISTE ────────────────────────────────────────────
 * `recordMemoryEvent` était déjà écrit, testé, et branché sur un schéma
 * (`MemoryConfirmationEvent`) porté par les traps, décisions et contraintes. Il n'était
 * appelé DEPUIS NULLE PART. Mesuré au moment du correctif : 0 item sur 471 portait la
 * moindre confirmation.
 *
 * C'est exactement la classe de défaut que trp#1292 décrit — un cœur vert et une
 * fonctionnalité inerte, parce que rien ne la tire depuis une surface qu'un agent ou un
 * opérateur appelle réellement.
 *
 * ── CE QUE ÇA CHANGE POUR LA PRIORISATION ─────────────────────────────────────
 * Une mémoire non vérifiée ne peut pas justifier une priorité P0. Un trap écrit en mars,
 * jamais reconfirmé, décrit peut-être un code qui n'existe plus — la démolition de la
 * fédération v1 en a périmé plusieurs d'un coup. Sans trace d'applicabilité, on ne peut
 * pas distinguer « toujours vrai » de « personne n'a revérifié depuis six mois ».
 *
 * L'ÉVIDENCE EST OBLIGATOIRE POUR CONFIRMER, et c'est le cœur du dispositif. Une
 * confirmation sans preuve — un fichier:ligne, un sha, une sortie de commande — ne serait
 * qu'une opinion horodatée, et deux opinions ne valent pas mieux qu'une. Infirmer, en
 * revanche, ne l'exige pas : constater qu'un symbole a disparu est en soi la preuve.
 */

import { recordMemoryEvent, type MemoryLifecycleEntity } from '../core/memory-lifecycle.js';
import type { MemoryConfirmationKind } from '../core/schema.js';
import { resolveEffectiveCwd } from '../core/store-resolution.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';

const ENTITIES: MemoryLifecycleEntity[] = ['trap', 'decision', 'constraint'];
const KINDS: MemoryConfirmationKind[] = ['confirm', 'infirm', 'saved_me', 'misled_me'];

export interface MemoryConfirmOptions {
  entity: string;
  id: string;
  kind: string;
  evidence?: string;
  note?: string;
  json?: boolean;
  cwd?: string;
}

export function runMemoryConfirm(options: MemoryConfirmOptions): void {
  const entity = options.entity as MemoryLifecycleEntity;
  if (!ENTITIES.includes(entity)) {
    console.error(`Entité inconnue '${options.entity}'. Attendu : ${ENTITIES.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const kind = options.kind as MemoryConfirmationKind;
  if (!KINDS.includes(kind)) {
    console.error(`Type inconnu '${options.kind}'. Attendu : ${KINDS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  // CONFIRMER SANS PREUVE EST REFUSÉ. Le but de ce dispositif est qu'une priorité puisse
  // s'appuyer sur une vérification ; une attestation sans pointeur vers ce qui a été
  // vérifié ne porte aucune information de plus que la date.
  if (kind === 'confirm' && !options.evidence) {
    console.error(
      "Une confirmation exige --evidence : un fichier:ligne, un sha de commit, ou une sortie de commande.\n"
      + "Sans preuve, l'attestation n'est qu'une opinion horodatée et ne peut pas justifier une priorité.",
    );
    process.exitCode = 1;
    return;
  }

  const cwd = options.cwd ?? resolveEffectiveCwd();
  const by = resolveCurrentAgentName(cwd);

  let result;
  try {
    result = recordMemoryEvent({
      entity, id: options.id, kind, by,
      evidence: options.evidence,
      note: options.note,
      cwd,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`✔ ${result.entity} ${result.id} — ${result.kind} par ${by}`);
  if (options.evidence) console.log(`  preuve : ${options.evidence}`);
  console.log(
    `  confirmations : ${result.confirmation_count} · infirmations : ${result.infirmation_count}`
    + ` · a servi : ${result.saved_me_count} · a induit en erreur : ${result.misled_me_count}`,
  );
  if (result.last_confirmed_at) console.log(`  dernière confirmation : ${result.last_confirmed_at}`);
  if (result.last_infirmed_at) console.log(`  dernière infirmation  : ${result.last_infirmed_at}`);
}
