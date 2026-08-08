/**
 * Schémas zod des entrées de la famille CAPTURE — `bclaw_write_note` et
 * `bclaw_quick_capture` (pln#599 batch 1, première famille).
 *
 * ── POURQUOI UNE FAMILLE ENTIÈRE, ET PAS TROIS OUTILS AU HASARD ───────────────
 * Une source unique de vérité n'en est une que si elle couvre un ensemble COHÉRENT. Un
 * catalogue à moitié dérivé double la maintenance — deux mécanismes à comprendre, deux
 * endroits où corriger — sans donner le bénéfice, qui est de ne plus pouvoir faire
 * diverger le schéma publié de la validation réelle. Le découpage par famille garantit
 * qu'aucune surface ne reste à cheval sur les deux.
 *
 * ── LA CONTRAINTE QUI GOUVERNE CE FICHIER : FINGERPRINT INCHANGÉ ──────────────
 * Le JSON Schema dérivé de ces objets doit être IDENTIQUE à celui écrit à la main qu'il
 * remplace. Un champ optionnel devenu requis, un `enum` perdu, une `description`
 * reformulée : chacun est une modification de la surface publique que des agents ont déjà
 * apprise. La migration doit être invisible côté fil ; c'est ce que le test de parité
 * vérifie.
 *
 * D'où des choix qui paraîtraient étranges hors de ce contexte — `visibility` reste une
 * chaîne libre et non un enum, `crossProject` et `cross_project` coexistent. Ce ne sont
 * pas des approximations : ce sont les schémas ACTUELS, et les resserrer ici mélangerait
 * une migration mécanique avec un changement de contrat.
 */

import { z } from 'zod';

/** Identité de l'appelant — présente à l'identique sur les deux outils de la famille. */
const CallerIdentity = {
  agent: z.string().describe('Agent name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

export const WriteNoteRequestSchema = z.object({
  text: z.string().describe('Note content.'),
  ...CallerIdentity,
  tags: z.array(z.string()).describe('Optional tags.').optional(),
  // Chaîne libre et NON un enum : c'est l'état actuel du schéma publié. Le resserrer
  // serait un changement de contrat déguisé en migration.
  visibility: z.string().describe('Visibility: shared, machine, private.').optional(),
  ttl: z.string().describe('Optional TTL: 30m, 2h, 7d.').optional(),
  autoReflect: z
    .boolean()
    .describe('Attempt to reflect the runtime note into durable memory immediately.')
    .optional(),
  crossProject: z
    .string()
    .describe('Push note to a linked project (name or path). Requires role: publisher in cross_project_links config.')
    .optional(),
  // L'alias snake_case coexiste avec le camelCase. Le retirer casserait les appelants qui
  // l'utilisent ; la migration ne doit rien retirer.
  cross_project: z.string().describe('Snake_case alias of crossProject.').optional(),
});

export const QuickCaptureRequestSchema = z.object({
  text: z.string().describe('Free-form capture text.'),
  type: z
    .enum(['decision', 'trap', 'constraint', 'note'])
    .describe('Caller-asserted classification. Strongly recommended — the calling agent knows the nature of the capture better than keyword heuristics (cnd_abe61d68: 18 false contradiction positives on a review summary).')
    .optional(),
  context: z
    .string()
    .describe('Optional file/path/scope context to associate with the capture.')
    .optional(),
  ...CallerIdentity,
});

export type WriteNoteRequest = z.infer<typeof WriteNoteRequestSchema>;
export type QuickCaptureRequest = z.infer<typeof QuickCaptureRequestSchema>;
