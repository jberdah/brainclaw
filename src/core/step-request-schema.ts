/**
 * Schémas zod des entrées de la famille STEP — `bclaw_add_step`, `bclaw_update_step`,
 * `bclaw_complete_step`, `bclaw_delete_step` (pln#599 batch 2, quatrième famille).
 *
 * ── CE QUE CETTE FAMILLE APPREND, ET QUI CORRIGE UNE RÈGLE TROP VITE GÉNÉRALISÉE ─
 * Sur la famille séquence j'avais formulé la consigne « retirer `additionalProperties`
 * À LA RACINE UNIQUEMENT », au motif que le sous-schéma d'item de lane le portait déjà
 * dans sa version manuelle. C'était vrai LÀ, et faux comme règle générale.
 *
 * Ici, le sous-objet `data` de `bclaw_add_step` n'a PAS d'`additionalProperties` dans la
 * version écrite à la main. Appliquer « racine uniquement » y laisserait donc le
 * `additionalProperties: false` émis par zod — exactement le DURCISSEMENT que la règle
 * était censée empêcher, réintroduit par la règle elle-même.
 *
 * La consigne réelle n'a jamais été « racine » : c'est « reproduire le schéma manuel au
 * bit près ». Le générateur porte désormais une profondeur de retrait PAR SCHÉMA
 * (cf. OPEN_SCHEMAS dans scripts/build-mcp-schemas.mjs) au lieu d'une règle globale.
 *
 * ── DEUX FORMES D'APPEL COEXISTENT, DÉLIBÉRÉMENT ──────────────────────────────
 * `bclaw_add_step` accepte la forme canonique `{ planId, data: {...} }` ET la forme
 * historique `{ planId, text, assignee }`. Les deux sont publiées ; supprimer la seconde
 * du schéma casserait les appelants existants. `title` reste un alias de `text`.
 *
 * ── CE QUI N'EST PAS RESSERRÉ ─────────────────────────────────────────────────
 * `status` reste une chaîne libre bien que ses cinq valeurs soient énumérées dans sa
 * description : en faire un enum serait un rejet nouveau sur des appels aujourd'hui
 * acceptés, donc une décision à part entière.
 */

import { z } from 'zod';

/** Identité de l'appelant — commune à toutes les familles migrées. */
const CallerIdentity = {
  agent: z.string().describe('Agent name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

/**
 * Charge utile canonique d'un step. Ses champs sont TOUS optionnels et l'objet ne porte
 * PAS d'`additionalProperties` — voir l'en-tête : c'est ce sous-objet qui a révélé que la
 * profondeur de retrait devait être décidée par schéma.
 */
const AddStepDataSchema = z
  .object({
    text: z.string().describe('Step description.').optional(),
    title: z.string().describe('Alias for text.').optional(),
    assignee: z.string().describe('Optional assignee.').optional(),
    estimated_effort: z
      .number()
      .describe(
        'Step-level estimate in minutes (pln#495). A duration string like "2h"/"30m" is also accepted and coerced.',
      )
      .optional(),
    actual_effort: z
      .string()
      .describe(
        'Step-level actual effort, free-form ("45m", "2h"), parsed when the estimation report runs.',
      )
      .optional(),
  })
  .describe(
    'Canonical step payload: { text, title?, assignee? }. title is accepted as an alias for text.',
  );

export const AddStepRequestSchema = z.object({
  planId: z.string().describe('Plan item ID.'),
  data: AddStepDataSchema.optional(),
  // Forme HISTORIQUE, conservée : elle est publiée et des appelants s'en servent.
  text: z.string().describe('Legacy top-level step description; prefer data.text.').optional(),
  ...CallerIdentity,
  assignee: z
    .string()
    .describe('Legacy top-level optional assignee; prefer data.assignee.')
    .optional(),
  project: z
    .string()
    .describe(
      'Optional: name (or path/basename) of a linked project to add the step in. Defaults to the current project. Same resolution as canonical-grammar tools — accepts cross_project_links and workspace store-chain children.',
    )
    .optional(),
});

export const UpdateStepRequestSchema = z.object({
  planId: z.string().describe('Plan item ID.'),
  stepId: z.string().describe('Step ID to update.'),
  // Chaîne libre, PAS un enum : les cinq valeurs sont documentées, pas imposées.
  status: z
    .string()
    .describe('New status: todo, in_progress, testing, done, blocked.')
    .optional(),
  text: z.string().describe('New step text.').optional(),
  assignee: z.string().describe('New assignee (empty string to unassign).').optional(),
  estimated_effort: z
    .number()
    .describe('Step-level estimate in minutes (pln#495); a duration string is also coerced.')
    .optional(),
  actual_effort: z
    .string()
    .describe('Step-level actual effort, free-form ("45m", "2h").')
    .optional(),
  ...CallerIdentity,
  project: z
    .string()
    .describe(
      'Optional: name of a linked project to update the step in. Defaults to the current project.',
    )
    .optional(),
});

export const CompleteStepRequestSchema = z.object({
  planId: z.string().describe('Plan item ID.'),
  stepId: z.string().describe('Step ID to complete.'),
  ...CallerIdentity,
  project: z
    .string()
    .describe(
      'Optional: name of a linked project to complete the step in. Defaults to the current project.',
    )
    .optional(),
});

export const DeleteStepRequestSchema = z.object({
  planId: z.string().describe('Plan item ID.'),
  stepId: z.string().describe('Step ID to delete.'),
  ...CallerIdentity,
  project: z
    .string()
    .describe(
      'Optional: name of a linked project to delete the step from. Defaults to the current project.',
    )
    .optional(),
});

export type AddStepRequest = z.infer<typeof AddStepRequestSchema>;
export type UpdateStepRequest = z.infer<typeof UpdateStepRequestSchema>;
export type CompleteStepRequest = z.infer<typeof CompleteStepRequestSchema>;
export type DeleteStepRequest = z.infer<typeof DeleteStepRequestSchema>;
