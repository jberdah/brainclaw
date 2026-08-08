/**
 * Schémas zod des entrées de la famille ASSIGNMENT — `bclaw_assignment_update`,
 * `bclaw_assignment_action`, `bclaw_assignment_events` (pln#599 batch 2, cinquième famille).
 *
 * ── LA FAMILLE LA PLUS PROFONDE MIGRÉE JUSQU'ICI ──────────────────────────────
 * `assignment_update` porte deux objets imbriqués qui ont LEURS PROPRES `required` :
 * l'item d'`artifacts` (`type`+`ref`) et `action_required` (`kind`+`title`+`prompt`).
 * Ces requis internes font partie du contrat publié et doivent survivre à la migration —
 * c'est le pendant profond du piège de la famille séquence, où un requis de premier niveau
 * était passé optionnel sans que rien d'autre que le fingerprint ne le voie.
 *
 * ── DEUX OBJETS DÉLIBÉRÉMENT LIBRES ───────────────────────────────────────────
 * `payload` et `response_schema` sont publiés comme `{ type: 'object' }` NU : aucune
 * propriété, aucune contrainte. Ce sont des sacs de données dont la forme appartient à
 * l'appelant.
 *
 * Les quatre constructions candidates ont été MESURÉES, pas supposées :
 *   z.object({})                        -> properties:{} + additionalProperties:false
 *                                          (un objet qui n'accepte plus RIEN — le
 *                                          durcissement le plus radical possible, sur les
 *                                          deux champs les plus ouverts de la famille)
 *   z.looseObject({})                   -> properties:{} + additionalProperties:{}
 *   z.record(z.string(), z.unknown())   -> + propertyNames + additionalProperties
 *   z.unknown().meta({ type:'object' }) -> { type: 'object' }  <- seul exact
 * La comparaison à la version manuelle a rejeté les trois premiers.
 *
 * ── CE QUI GARDE SON ENUM, ET POURQUOI ────────────────────────────────────────
 * `status`, `outcome` et `action_required.kind` en avaient déjà un dans la version
 * manuelle : le leur retirer serait l'assouplissement symétrique du durcissement qu'on
 * évite ailleurs. En revanche `artifacts[].type` et `eventType` restent des chaînes
 * libres bien que leurs valeurs soient énumérées en description — les resserrer serait un
 * rejet nouveau.
 */

import { z } from 'zod';

/** Identité de l'appelant — commune à toutes les familles migrées. */
const CallerIdentity = {
  agent: z.string().describe('Agent name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

/** Item d'artefact. `type` et `ref` sont REQUIS — requis IMBRIQUÉ, à préserver. */
const ArtifactSchema = z.object({
  type: z.string().describe('Artifact type: commit, branch, file, pr, test_result.'),
  ref: z.string().describe('Reference: SHA, branch name, file path, PR URL.'),
  description: z.string().describe('Optional description.').optional(),
});

/** ActionRequired. `kind`+`title`+`prompt` REQUIS — second requis imbriqué. */
const ActionRequiredSchema = z
  .object({
    kind: z
      .enum(['approval', 'user_input', 'clarification', 'plan_approval'])
      .describe('Kind of action needed.'),
    title: z.string().describe('Short title shown to supervisors/UI.'),
    prompt: z.string().describe('Question or approval prompt to answer.'),
    options: z.array(z.string()).describe('Optional answer choices.').optional(),
    // Objet NU. Mesure des candidats plutôt que supposition :
    //   z.object({})    -> properties:{} + additionalProperties:false  (n'accepte RIEN)
    //   z.looseObject({}) -> properties:{} + additionalProperties:{}   (accepte, mais ajoute
    //                        deux clés que la version publiée n'avait pas)
    //   z.record(...)   -> ajoute propertyNames + additionalProperties
    //   z.unknown().meta({ type: 'object' }) -> { type: 'object' } exactement.
    // Seul le dernier reproduit la surface manuelle.
    response_schema: z
      .unknown()
      .meta({ type: 'object' })
      .describe('Optional structured response schema hint.')
      .optional(),
    tags: z.array(z.string()).describe('Optional tags.').optional(),
  })
  .describe(
    'Optional ActionRequired payload when status=blocked. Lets the worker request approval, user input, or clarification before resuming.',
  );

export const AssignmentUpdateRequestSchema = z.object({
  assignment_id: z.string().describe('Assignment ID from the dispatch brief (asgn_xxx).'),
  status: z
    .enum(['accepted', 'started', 'progress', 'completed', 'failed', 'blocked'])
    .describe('Lifecycle status to report.'),
  message: z.string().describe('Human-readable status message or progress note.').optional(),
  artifacts: z
    .array(ArtifactSchema)
    .describe('Artifacts produced. Most useful for completed status.')
    .optional(),
  error_message: z.string().describe('Error details (for failed status).').optional(),
  blocker: z.string().describe('Blocker description (for blocked status).').optional(),
  action_required: ActionRequiredSchema.optional(),
  ...CallerIdentity,
});

export const AssignmentActionRequestSchema = z.object({
  action_id: z.string().describe('ActionRequired ID (act_xxx).'),
  outcome: z
    .enum(['resolved', 'rejected', 'cancelled'])
    .describe('How the supervisor resolves the pending action.'),
  text: z.string().describe('Human-readable response or rationale.').optional(),
  // Objet NU, même raison et même construction que response_schema.
  payload: z
    .unknown()
    .meta({ type: 'object' })
    .describe('Optional structured response payload.')
    .optional(),
  agent: z.string().describe('Supervisor/agent responding to the action.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
});

export const AssignmentEventsRequestSchema = z.object({
  assignmentId: z.string().describe('Filter by linked assignment ID.').optional(),
  runId: z.string().describe('Filter by linked run ID.').optional(),
  claimId: z.string().describe('Filter by linked claim ID.').optional(),
  sessionId: z.string().describe('Filter by runtime session ID.').optional(),
  agent: z.string().describe('Filter by agent name.').optional(),
  eventType: z.string().describe('Filter by runtime event type.').optional(),
  id: z.string().describe('Get a single runtime event by ID.').optional(),
  limit: z.number().describe('Maximum number of events to return (default: 20).').optional(),
  offset: z.number().describe('Number of events to skip (for pagination).').optional(),
  compact: z.boolean().describe('Return only key fields to reduce output size.').optional(),
});

export type AssignmentUpdateRequest = z.infer<typeof AssignmentUpdateRequestSchema>;
export type AssignmentActionRequest = z.infer<typeof AssignmentActionRequestSchema>;
export type AssignmentEventsRequest = z.infer<typeof AssignmentEventsRequestSchema>;
