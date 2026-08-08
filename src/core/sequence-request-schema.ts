/**
 * Schémas zod des entrées de la famille SÉQUENCE — `bclaw_create_sequence` et
 * `bclaw_update_sequence` (pln#599 batch 2, première famille composite).
 *
 * ── CE QUI CHANGE PAR RAPPORT À LA FAMILLE CAPTURE ────────────────────────────
 * C'est la première famille COMPOSITE : les deux outils partagent un objet imbriqué,
 * l'item de séquence, dont le schéma était jusqu'ici une constante JSON manuelle
 * (`SEQUENCE_ITEM_INPUT_SCHEMA`) réutilisée à deux endroits.
 *
 * La duplication d'un sous-schéma est exactement ce qui a produit trp#180 — les tableaux
 * de `bclaw_loop` sans `items` — parce qu'un des deux exemplaires avait été corrigé et pas
 * l'autre. Le dériver d'une source zod unique supprime la classe entière.
 *
 * ── CONTRAINTE INCHANGÉE : FINGERPRINT IDENTIQUE ──────────────────────────────
 * Le JSON Schema produit doit être byte-identique à celui écrit à la main. Les
 * `minLength: 1` et `minimum: 1` du schéma d'item sont donc reproduits tels quels, y
 * compris là où ils paraissent redondants : ce sont des contraintes qu'un client peut déjà
 * avoir apprises, et les retirer serait un changement de contrat déguisé en migration.
 *
 * `status` reste une chaîne libre et non un enum, pour la même raison. Le resserrer est un
 * changement de surface qui mérite sa propre décision, pas un effet de bord.
 */

import { z } from 'zod';

/**
 * Item de lane. Source UNIQUE — les deux outils de la famille la partagent, là où le
 * schéma manuel existait en un exemplaire réutilisé par référence mais impossible à
 * valider contre le code qui le consomme.
 */
export const SequenceItemInputSchema = z
  .object({
    planId: z.string().min(1).describe('Plan item ID referenced by this sequence item.'),
    stepId: z
      .string()
      .min(1)
      .describe('Optional plan step ID inside planId for step-level dispatch/readiness.')
      .optional(),
    // REQUIS, comme dans le schema d'origine. Le rendre optionnel etait un
    // ASSOUPLISSEMENT du contrat — un appel sans rank aurait ete accepte par le schema
    // publie puis rejete plus loin. La garde de gouvernance l'a detecte via le
    // fingerprint.
    rank: z
      .number()
      .min(1)
      .describe('Positive integer ordering key. Ranks must be unique within a sequence.'),
    hard_after: z
      .array(z.string())
      .describe('Sequence item planId values that must complete before this item becomes ready.')
      .optional(),
    soft_after: z
      .array(z.string())
      .describe('Advisory predecessor planId values; they inform ordering but do not block readiness.')
      .optional(),
    lane: z
      .string()
      .describe('Optional lane label used for parallel dispatch grouping and filtering.')
      .optional(),
    scope_hint: z
      .string()
      .describe('Optional file/path scope hint for claim and brief generation.')
      .optional(),
    rationale: z
      .string()
      .describe('Optional explanation for this item or dependency placement.')
      .optional(),
  })
  .describe('Sequence lane item. planId is required; stepId optionally narrows dispatch/readiness to a specific plan step.');

/** Identité de l'appelant — commune aux deux outils, comme dans la famille capture. */
const CallerIdentity = {
  agent: z.string().describe('Agent name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

export const CreateSequenceRequestSchema = z.object({
  name: z.string().describe('Sequence name.'),
  description: z.string().describe('Optional sequence description.').optional(),
  // Chaîne libre, PAS un enum : c'est l'état publié. Le resserrer mérite sa propre
  // décision, pas un effet de bord de migration.
  status: z.string().describe('Status: draft, active, archived.').optional(),
  owner: z.string().describe('Optional sequence owner.').optional(),
  items: z.array(SequenceItemInputSchema).describe('Sequence items in rank order.').optional(),
  tags: z.array(z.string()).describe('Optional tags.').optional(),
  ...CallerIdentity,
});

export const UpdateSequenceRequestSchema = z.object({
  id: z.string().describe('Sequence ID or short label.'),
  name: z.string().describe('Optional new sequence name.').optional(),
  description: z.string().describe('Optional new description.').optional(),
  status: z.string().describe('Status: draft, active, archived.').optional(),
  owner: z.string().describe('Optional sequence owner.').optional(),
  items: z.array(SequenceItemInputSchema).describe('Optional replacement items array.').optional(),
  tags: z.array(z.string()).describe('Optional replacement tags.').optional(),
  ...CallerIdentity,
});

export type CreateSequenceRequest = z.infer<typeof CreateSequenceRequestSchema>;
export type UpdateSequenceRequest = z.infer<typeof UpdateSequenceRequestSchema>;
