/**
 * Schémas zod des entrées de la famille CLAIM — `bclaw_claim` et `bclaw_release_claim`
 * (pln#599 batch 2, deuxième famille composite).
 *
 * ── CONTRAINTE, INCHANGÉE DEPUIS LA FAMILLE CAPTURE ───────────────────────────
 * Le JSON Schema produit doit être byte-identique à celui écrit à la main : le fingerprint
 * de gouvernance (tests/unit/mcp-governance.test.ts) ne doit pas bouger. Une migration qui
 * déplace le fingerprint n'est plus une migration, c'est un changement de surface publique.
 *
 * ── LES DEUX PIÈGES PAYÉS COMPTANT SUR #220/#221, REPRODUITS ICI EN GARDE ──────
 * 1. zod émet `additionalProperties: false` d'office. Le laisser DURCIT le contrat : un
 *    client passant une clé inconnue était ACCEPTÉ (clé ignorée) et se ferait désormais
 *    rejeter. Le générateur le retire — À LA RACINE UNIQUEMENT, cf. OPEN_SCHEMAS.
 * 2. Un champ REQUIS dans la version manuelle doit le rester. `rank` était passé optionnel
 *    par inadvertance sur la famille séquence : assouplissement du contrat, attrapé par le
 *    seul fingerprint. Ici les requis sont `scope`+`description` (claim) et `id` (release).
 *
 * Ni l'un ni l'autre n'avait été vu par mes propres vérifications, ni par le snapshot du
 * registre CLI — qui mesure quelque chose de plus faible et donne une fausse assurance.
 *
 * ── CE QUI N'EST PAS RESSERRÉ, DÉLIBÉRÉMENT ───────────────────────────────────
 * `store` et `planStatus` restent des chaînes libres et non des enums, bien que leurs
 * valeurs utiles soient énumérées dans leur description. Les resserrer mérite sa propre
 * décision : ce serait un rejet nouveau sur des appels aujourd'hui acceptés.
 * `handoffMode` garde en revanche son enum, parce qu'il en avait DÉJÀ un.
 */

import { z } from 'zod';

/** Identité de l'appelant — commune à la famille, comme pour capture et séquence. */
const CallerIdentity = {
  agent: z.string().describe('Agent or person name.').optional(),
  agentId: z.string().describe('Registered agent id.').optional(),
};

export const ClaimRequestSchema = z.object({
  scope: z.string().describe('Scope being claimed.'),
  description: z.string().describe('Description of the work.'),
  ...CallerIdentity,
  planId: z.string().describe('Optional linked plan item ID.').optional(),
  project: z
    .string()
    .describe(
      'Project name or path. Use this when working on a project different from the MCP server workspace (e.g. CLI agents in a different directory).',
    )
    .optional(),
  // Chaîne libre, PAS un enum : les trois niveaux sont documentés mais la valeur reste
  // ouverte côté schéma publié.
  store: z.string().describe('Target store level: local (default), repo, workspace.').optional(),
  worktreeBranch: z
    .string()
    .describe('Branch name for the worktree. Defaults to feat/<scope-slug>.')
    .optional(),
  worktree: z
    .boolean()
    .describe(
      'Whether to create an isolated git worktree (default true). Pass false for an advisory-only lock with no worktree (trp#431) — for in-place work in the main tree.',
    )
    .optional(),
  advisory: z
    .boolean()
    .describe('Alias for worktree:false — advisory-only lock with no worktree (trp#431).')
    .optional(),
  // Enum CONSERVÉ : il existait déjà dans le schéma manuel. Le retirer serait
  // l'assouplissement symétrique du durcissement qu'on évite ailleurs.
  handoffMode: z
    .enum(['self-commit', 'integrator'])
    .describe(
      'Handoff mode: "self-commit" (worker commits+merges) or "integrator" (another agent reviews+merges). Default: self-commit.',
    )
    .optional(),
});

export const ReleaseClaimRequestSchema = z.object({
  id: z.string().describe('Claim ID to release.'),
  planStatus: z.string().describe('Optional: update linked plan status.').optional(),
  coordinator_override: z
    .boolean()
    .describe(
      'Opt-in override for a trusted+ caller releasing a claim they do NOT own (cross-agent teardown, ghost-claim cleanup). Rejected for contributor-level callers; audited when used. trp#928.',
    )
    .optional(),
  /** AttemptAuthority v2 fence; mandatory for a worker-owned claim linked to a v2 Assignment. */
  turn_id: z.string().optional(),
  run_id: z.string().optional(),
  nonce: z.string().optional(),
  attempt_epoch: z.number().int().nonnegative().optional(),
  execution_contract_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  workspace_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export type ReleaseClaimRequest = z.infer<typeof ReleaseClaimRequestSchema>;
