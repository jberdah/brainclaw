/**
 * Schémas zod des entrées de la famille SESSION — `bclaw_session_start` et
 * `bclaw_session_end` (pln#599 batch 2, troisième famille composite).
 *
 * ── LA PARTICULARITÉ DE CETTE FAMILLE : AUCUN CHAMP REQUIS ────────────────────
 * Les deux outils ont un `properties` fourni mais PAS de clé `required`. C'est délibéré et
 * doit être préservé au bit près : `bclaw_session_start` sans argument est l'appel normal,
 * et l'identité comme le contexte se résolvent depuis l'ambiance.
 *
 * zod n'émet `required` que s'il existe au moins un champ non-optionnel — donc marquer
 * TOUS les champs `.optional()` reproduit exactement l'absence de la clé. C'est le
 * pendant du piège inverse rencontré sur la famille séquence : là-bas un requis était
 * devenu optionnel (assouplissement) ; ici, oublier un `.optional()` créerait un requis
 * là où il n'y en avait aucun — un DURCISSEMENT qui casserait l'appel sans argument.
 *
 * ── CE QUI N'EST PAS RESSERRÉ, DÉLIBÉRÉMENT ───────────────────────────────────
 * `contextProfile` et `contextFormat` énumèrent leurs valeurs dans leur description mais
 * restent des chaînes libres : les profils sont extensibles côté produit, et un enum
 * publié figerait cette extensibilité. `maintenanceMode` garde en revanche son enum,
 * parce qu'il en avait déjà un.
 *
 * ── GARDE-FOU DE GÉNÉRATION ───────────────────────────────────────────────────
 * zod émet `additionalProperties: false` d'office ; le générateur le retire À LA RACINE
 * uniquement (cf. OPEN_SCHEMAS dans scripts/build-mcp-schemas.mjs). Le laisser durcirait
 * la surface ; le retirer plus profond l'assouplirait.
 */

import { z } from 'zod';

/** Identité de l'appelant — commune à toutes les familles migrées. */
const CallerIdentity = {
  agent: z.string().describe('Agent name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

export const SessionStartRequestSchema = z.object({
  ...CallerIdentity,
  context: z.string().describe('Context target path.').optional(),
  // Enum CONSERVÉ : il existait déjà dans le schéma manuel.
  maintenanceMode: z
    .enum(['fast', 'full'])
    .describe(
      'Maintenance mode. Default is full for explicit session-start calls; use fast to skip non-critical maintenance work.',
    )
    .optional(),
  includeContext: z
    .boolean()
    .describe('Include project memory context in the response (equivalent to bclaw_get_context).')
    .optional(),
  includeBoard: z
    .boolean()
    .describe(
      'Include agent board (plans, claims, handoffs) in the response (equivalent to bclaw_get_agent_board).',
    )
    .optional(),
  // Chaîne libre : les profils sont extensibles, un enum publié figerait cette
  // extensibilité et rejetterait un profil ajouté côté produit.
  contextProfile: z
    .string()
    .describe(
      'Context profile when includeContext is true: dev (default), dense, compact, copilot, quick, briefing, openclaw, ops, research. If unset, uses the agent default profile.',
    )
    .optional(),
  contextFormat: z
    .string()
    .describe('Context format when includeContext is true: markdown, json, or template.')
    .optional(),
});

export const SessionEndRequestSchema = z.object({
  session: z.string().describe('Session ID.').optional(),
  ...CallerIdentity,
  summary: z.string().describe('Session summary text.').optional(),
  narrative: z
    .string()
    .describe(
      'Free-text narrative of what happened in the session and why. Goes beyond the auto-generated commit list: "Tried X, failed because Y, pivoted to Z. Watch out for A."',
    )
    .optional(),
  autoReflect: z.boolean().describe('Auto-reflect session notes as candidates.').optional(),
  autoRelease: z
    .boolean()
    .describe('Auto-release any active claims at session end.')
    .optional(),
  reflectHandoff: z
    .boolean()
    .describe('Materialize an open handoff from git commits since session start.')
    .optional(),
  dispatchReview: z
    .boolean()
    .describe(
      'When used with reflectHandoff, auto-dispatch a code review if the reflected handoff is reviewable.',
    )
    .optional(),
  reviewer: z
    .string()
    .describe('Explicit reviewer for the reflected handoff review dispatch.')
    .optional(),
  reflect: z
    .boolean()
    .describe(
      'Emit the dogfooding reflection prompt (project + your surfaces/skills/tools). Default true — pass false to suppress on a trivial session. Capture actionable findings via bclaw_quick_capture.',
    )
    .optional(),
});

export type SessionStartRequest = z.infer<typeof SessionStartRequestSchema>;
export type SessionEndRequest = z.infer<typeof SessionEndRequestSchema>;
