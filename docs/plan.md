# Plan: brainclaw — Roadmap vers l'application idéale pour agents

## Contexte
- Horizon : 6-12 mois, vision produit complète
- Cibles : agent solo, multi-agents collaboratifs, agents orchestrés (type OpenClaw)
- Autonomie : pleine autonomie agentique, humain uniquement pour les conflits
- Infrastructure : local-first + repo Git distant partagé pour la mémoire distribuée
- Principe directeur : **agent-first** — chaque feature doit être utilisable par un LLM stateless sans intervention humaine

## Piliers stratégiques
1. Correctness — fondations fiables et engineering hygiene
2. Adoption — UX agent et export multi-format comme accélérateurs d'adoption
3. Autonomy — agents comme participants de première classe
4. Connectivity — Git distribué + MCP universel
5. Intelligence — recherche, détection de contradictions, auto-réflexion

---

## Mise à jour d'avancement — 2026-03-15

### Travail réalisé récemment
- Rebranding produit stabilisé : `brainclaw` / `bclaw`, `.brainclaw/` comme seul répertoire supporté, suppression de la surface legacy `--storage-dir`.
- Hardening du write-path : verrou strict, nettoyage des `.tmp` / `.lock` orphelins au démarrage, correction de `prune --expired`, réalignement de plusieurs flows CLI/MCP.
- Restructuration profonde de la suite de tests :
  - séparation nette `test:unit`, `test:smoke`, `test:e2e`, `test:all`
  - runner séquentiel dédié via `scripts/run-tests.mjs`
  - extraction de logique métier hors des gros tests spawn/MCP vers des tests unitaires rapides
  - couverture directe des zones critiques : `context`, `reputation`, `coordination`, `doctor`, `review`, `claim`, `runtime-status`, `sync`, helpers MCP, `session-start` / `session-end`
  - ajout de la couverture `c8` avec seuils minimaux sur le fast path
- Fast path actuel vérifié :
  - `npm test` passe
  - `npm run test:unit` passe
  - `npm run test:coverage:check` passe
  - couverture fast path : `statements 62.49%`, `branches 65.89%`, `functions 68.58%`, `lines 62.49%`

### Légende de statut
- `done` : livré et intégré
- `partial` : présent mais incomplet, limité ou non aligné à 100% avec la cible roadmap
- `in progress` : chantier engagé mais encore en cours
- `todo` : non démarré ou seulement esquissé

### Statut par feature

**Phase 0 — Fondations de fiabilité**
- `0.0` Renommage de marque : `done`
- `0.1` IDs concurrence-safe : `done`
- `0.2` File locking sans race condition : `done`
- `0.3` Fenêtre de corruption dans `saveState` : `partial`
- `0.4` Nettoyage technique : `done`
- `0.5.1` Logging et observabilité technique : `done`
- `0.5.2` Migration de schéma : `todo`
- `0.5.3` Abstraction storage (`JsonStore<T>`) : `todo`
- `0.5.4` Validation des entrées CLI : `partial`
- `0.5.5` Tests unitaires du core : `partial`
- `0.5.6` CI pipeline : `partial`

**Phase 1 — Autonomie agentique**
- `1.1` Système de niveaux de confiance : `partial`
- `1.2` Write-through direct pour agents de confiance : `partial`
- `1.3` Auto-promote pipeline : `partial`
- `1.4` Session lifecycle : `partial`
- `1.5` TTL natif sur les items éphémères : `partial`
- `1.6` Export vers formats agents natifs : `partial`

**Phase 2 — Agent-First UX**
- `2.1` Auto-reflect notes pour agents trusted : `todo`
- `2.2` Context digest : `todo`
- `2.3` Session implicite / auto-session : `todo`
- `2.4` Alias courts sur les IDs : `todo`
- `2.5` Résumé d'activité récente par scope : `todo`

**Phase 3 — MCP Universel**
- `3.1` Conformité protocole MCP : `partial`
- `3.2` Outils MCP de mutation : `done`
- `3.3` Contrôle d'accès par niveau de confiance via MCP : `partial`
- `3.4` Schéma MCP stable et versionné : `done`

**Phase 4 — Intelligence Contextuelle**
- `4.1` Recherche full-text : `done`
- `4.2` Détection de contradictions : `partial`
- `4.3` Auto-reflect amélioré : `partial`
- `4.4` Context diff de session : `partial`
- `4.5` Knowledge relationships : `partial`

**Phase 5 — Git Distribué**
- `5.1` Remote memory repo : `partial`
- `5.2` Commandes de sync distribué : `partial`
- `5.3` Conflict resolution protocol : `partial`
- `5.4` Branch-based isolation (mode PR) : `todo`
- `5.5` GitHub Action (sync distribuable) : `partial`

**Phase 6 — Expérience Agent**
- `6.1` Identité agent robuste : `partial`
- `6.2` Profil d'agent déclaratif : `partial`
- `6.3` Notification de changements : `partial`
- `6.4` Context format versionné : `todo`

**Phase 7 — Observabilité et Audit**
- `7.1` Event log immuable : `partial`
- `7.2` History par item : `partial`
- `7.3` Métriques de santé : `partial`
- `7.4` Rollback : `partial`

**Post-v1**
- `VS Code Extension` : `todo`
- `Adapters pour agents majeurs` : `partial`
- `Multi-repo federation` : `todo`
- `Encryption at rest` : `todo`

---

## Phase 0 — Fondations de fiabilité (Semaines 1-5)

### 0.0 Renommage de marque : team-memory → brainclaw
- `package.json` : `name` → `"brainclaw"`, binaires `"brainclaw": "./dist/cli.js"` et alias court `"bclaw": "./dist/cli.js"` (remplace `tmem`)
- `src/cli.ts` : `.name('brainclaw')`, tous les messages d'aide internes
- Tous les `console.error/log` qui mentionnent `team-memory init` → `brainclaw init`
- `src/core/io.ts` : supprimer `LEGACY_MEMORY_DIR`, `DEFAULT_MEMORY_DIR`, `KNOWN_MEMORY_DIRS` — `.brainclaw` est le seul répertoire reconnu
- `src/core/state.ts` : supprimer le chemin de migration legacy (`if (fs.existsSync(legacyFilepath))`)
- Préfixe des outils MCP : `tmem_` → `bclaw_` (`bclaw_get_context`, `bclaw_write_note`, etc.)
- Variables d'environnement : `TEAM_MEMORY_*` → `BRAINCLAW_*` — rupture propre, pas de fallback
- README.md : rebrandé complet
- Tests : nettoyer les préfixes `tm-test-` / `tm-mcp-` dans les dossiers temporaires

### 0.1 IDs concurrence-safe
- Remplacer generateId() dans ids.ts par UUIDs ou timestamp+random pour éviter le TOCTOU
- Remplacer generateClaimId() dans claims.ts par le même pattern
- Garder le préfixe lisible : `cst_<uuid8>`, `dec_<uuid8>`, etc.

### 0.2 File locking sans race condition
- Corriger le TOCTOU dans `acquireLock` : remplacer `existsSync` + `writeFileSync` par `writeFileSync` avec `flag: 'wx'` (exclusive create, atomique au niveau OS)
- Éliminer le busy-wait CPU (`while (Date.now() < until) {}`) : utiliser `Atomics.wait` sur un SharedArrayBuffer ou une boucle `setTimeout` dans une version async
- Timeout configurable (défaut : 2s), fallback gracieux si lock expiré
- Nettoyage des `.lock` orphelins au démarrage CLI (ex: locks dont le PID n'existe plus)

### 0.3 Fenêtre de corruption dans saveState
- Écrire dans un répertoire temporaire staging avant de faire l'atomic rename
- Ne jamais unlinkSync(legacyFilepath) avant que les nouveaux fichiers soient écrits
- Nettoyage des `.tmp` orphelins au démarrage (résidu de crash entre `writeFileSync` et `renameSync`)

### 0.4 Nettoyage technique
- Typer loadDirectoryItems<T> correctement (remplacer schema: any par schema: ZodType<T>)
- Retirer le paramètre mort opts dans saveState
- Retirer console.log("TEST SPAWN") dans cli.test.ts

### 0.5 Engineering hygiene (NOUVEAU)

Cette section couvre les lacunes d'infrastructure identifiées par audit du code existant.

#### 0.5.1 Logging et observabilité technique
- Ajouter un flag global `--verbose` / `--debug` sur le programme Commander
- Introduire un module `src/core/logger.ts` minimal (niveaux : silent, error, warn, info, debug)
- Remplacer les `catch {}` silencieux (>20 occurrences) par `catch (e) { logger.debug('...', e) }` — les erreurs restent silencieuses par défaut mais sont visibles en mode debug
- Le logger respecte `BRAINCLAW_LOG_LEVEL` env var pour les agents

#### 0.5.2 Migration de schéma
- Introduire un champ `schema_version: number` dans les entités persistées (state, config, candidates, claims, etc.)
- Créer `src/core/migration.ts` : registre de fonctions de migration `v1→v2`, `v2→v3`, etc.
- Au chargement (`loadState`, `loadConfig`, etc.) : si `schema_version < CURRENT`, exécuter les migrations en chaîne puis persister la version mise à jour
- Commande : `brainclaw doctor --migration-check` affiche les items nécessitant une migration
- Première migration concrète : servira de template pour les suivantes

#### 0.5.3 Abstraction storage (`JsonStore<T>`)
- Extraire un module `src/core/json-store.ts` : une classe générique `JsonStore<T>` qui encapsule le pattern dupliqué : `dirPath` → `readdirSync(.json)` → `readFileSync` → `JSON.parse` → `schema.parse`
- Remplace le code dupliqué dans : `state.ts`, `candidates.ts`, `claims.ts`, `runtime.ts`, `agent-registry.ts`, `instructions.ts`
- Interface : `list()`, `load(id)`, `save(item)`, `delete(id)`, `exists(id)`
- Intègre le locking et l'écriture atomique nativement
- Impact estimé : -30% de code dans les modules storage, comportement uniforme sur les erreurs

#### 0.5.4 Validation des entrées CLI
- Ajouter une validation Zod sur les arguments de chaque commande de mutation (decision, constraint, trap, handoff, etc.)
- Rejet des textes vides, tags vides, durées invalides
- Bornes de longueur raisonnables (text ≤ 2000 chars, tags ≤ 50 chars chacun, max 20 tags)
- Appliquer la même validation dans les handlers MCP

#### 0.5.5 Tests unitaires du core
- Ajouter des tests unitaires (sans spawn CLI) pour les modules core :
  - `search.ts` : tests BM25 avec corpus connu, edge cases (query vide, terme absent, document vide)
  - `contradictions.ts` : vrais positifs, faux positifs connus, edge cases
  - `reputation.ts` : scoring, decay, edge cases (agent sans activité, signaux extrêmes)
  - `context.ts` : ranking, maxItems, maxChars budget
  - `schema.ts` : validation des types, refus des données malformées
  - `json-store.ts` : CRUD, fichiers corrompus, permissions
- Les tests E2E existants restent — les tests unitaires complètent, ils ne remplacent pas

#### 0.5.6 CI pipeline
- Créer `.github/workflows/ci.yml` : build + test sur push et PR
- Steps : `npm ci` → `tsc --noEmit` (type check) → `tsc -p tsconfig.test.json` → `node --test`
- Matrix : Node 20 + Node 22, ubuntu-latest
- Fail-fast sur erreur de compilation ou test

---

## Phase 1 — Autonomie agentique (Mois 2-3)

### 1.1 Système de niveaux de confiance (Trust Tiers)
Config : chaque agent enregistré reçoit un niveau : observer | contributor | trusted | curator
- observer : lecture seule
- contributor : peut créer des runtime-notes et reflect, va en review
- trusted : peut écrire directement en mémoire canonique (bypass review)
- curator : trusted + peut accept/reject les autres

Nouveau champ trust_level dans AgentIdentityDocument
Nouvelle commande : `brainclaw set-trust <agent> --level trusted`

### 1.2 Write-through direct pour agents de confiance
- Si l'agent appelant est trusted ou curator, reflect écrit directement dans state/ (bypass inbox)
- Option --force-review pour forcer le cycle même pour un agent trusted
- Audit trail obligatoire : toute écriture directe horodatée avec agent_id + host_id + session_id

### 1.3 Auto-promote pipeline
- Seuils configurables dans reflective_memory : promotion_stars_threshold, promotion_uses_threshold
- Nouveau : auto_promote_trusted boolean — si true, les items d'agents trusted sont promus automatiquement sans humain
- Nouveau : auto_promote_score_threshold : score minimum (stars + uses) pour promotion automatique tous agents
- `brainclaw review --auto` : traite en batch tous les items dépassant les seuils
- **Circuit-breaker** : si un agent accumule plus de N items rejetés (configurable, défaut : 5) sur une fenêtre glissante de 7 jours, l'auto-promote est suspendu pour cet agent. `doctor` signale les agents en circuit-breaker. `brainclaw set-trust --reset-breaker <agent>` pour restaurer manuellement.

### 1.4 Session lifecycle
- Nouvelle commande : `brainclaw session-start [--agent <name>] [--context <target>]`
  - Écrit un runtime-note de type session_start
  - Exporte le contexte initial et le stocke dans .brainclaw/sessions/<session_id>/context.json
  - Retourne un session_id utilisable par les commandes suivantes
- Nouvelle commande : `brainclaw session-end [--session <id>] [--summary <text>]`
  - Compare le contexte initial avec l'état courant (diff mémoire)
  - Génère automatiquement des candidates via auto-reflect si des runtime-notes ont été créées
  - Écrit un runtime-note de type session_end avec résumé et liste d'IDs modifiés

### 1.5 TTL natif sur les items éphémères
- Nouveau champ expires_at optionnel sur RuntimeNote et Trap (déjà présent sur Constraint)
- Nouveau : `brainclaw runtime-note ... --ttl <minutes|hours|days>`
- `brainclaw prune --expired` : supprime automatiquement les items expirés
- doctor --json expose un bucket "expired_items" avec count
- Hook optionnel : prune automatique au session-start

### 1.6 Export vers formats agents natifs (REMONTÉ — ex Phase 5.3)
- `brainclaw export --format copilot-instructions` → génère un .github/copilot-instructions.md à partir des instructions global/project
- `brainclaw export --format cursor-rules` → .cursorrules
- `brainclaw export --format agents-md` → AGENTS.md enrichi
- `brainclaw export --format claude-system` → blurb system prompt pour Claude
- Synchronisation automatique optionnelle : auto_export_on_accept: true dans config

**Rationale** : l'export multi-format est le hook d'adoption le plus puissant de brainclaw. Un utilisateur qui génère son `copilot-instructions.md` depuis brainclaw a une raison immédiate de l'installer. Cette feature doit exister tôt pour accélérer l'adoption.

---

## Phase 2 — Agent-First UX (Mois 3-4) (REMONTÉ — ex Phase 8)

Constat : les phases précédentes ont été conçues avec un modèle "humain supervise, agent exécute".
Les 5 points ci-dessous corrigent cet angle mort pour que le système soit réellement utilisable
par un agent IA autonome et stateless (LLM typique : chaque requête repart de zéro).

### 2.1 Auto-reflect notes pour agents trusted (`auto_reflect_notes`)
**Problème** : un `bclaw_write_note` crée un runtime-note éphémère. Pour qu'il devienne un trap ou
une décision dans le state canonique il faut manuellement `reflect-runtime-note` + `accept`.
Un agent trusted ne devrait pas avoir cette friction.

- Nouveau champ config : `auto_reflect_notes: true|false` (défaut false)
- Quand activé ET que l'auteur est `trusted`/`curator` :
  `write_note` → détecte automatiquement le type (via les heuristiques de `reflect-runtime-note --suggest`)
  → crée un candidate → le promote directement (write-through, comme Phase 1.2)
- En pratique : une note "le middleware auth ne gère pas les tokens expirés" devient un trap en state en une seule opération MCP
- Audit trail préservé : l'entrée `auto_reflect` est loguée avec la chaîne complète (note_id → cnd_id → item_id)

**Fichiers à modifier** : `src/commands/mcp.ts` (handler `bclaw_write_note`), `src/core/config.ts` (nouveau champ), `src/commands/runtime-note.ts` (option `--auto-reflect`)

### 2.2 Context digest — résumé exécutif priorisé
**Problème** : `context` renvoie une liste d'items scorés par BM25. Un agent a besoin d'un résumé
actionnable en 3-5 lignes : "voilà ce que tu dois savoir avant de toucher à ce fichier".

- Nouveau flag : `brainclaw context --digest` / MCP arg `digest: true`
- Comportement : sélectionne les items les plus critiques (traps severity=high, contraintes actives,
  décisions récentes liées au target) et produit un bloc compact :
  ```
  ⚠ 1 high-severity trap on auth/gateway.ts: flaky token refresh
  🔒 1 active constraint: payments module frozen
  ✅ Recent decision: OAuth via auth-gateway (3 days ago)
  📝 1 pending candidate awaiting review
  ```
- Format MCP : champ `digest: string` dans le `structuredContent` en plus des `selected`
- Le digest est purement déterministe (pas de LLM) — règles de priorité : high traps > active constraints > recent decisions > pending candidates > runtime notes

**Fichiers à modifier** : `src/core/context.ts` (nouvelle fonction `buildContextDigest`), `src/commands/context.ts` (flag `--digest`), `src/commands/mcp.ts` (arg digest dans `bclaw_get_context`)

### 2.3 Session implicite / auto-session
**Problème** : un agent LLM est stateless — chaque requête repart de zéro. Les `session-start` /
`session-end` explicites supposent un process persistant. En pratique personne ne les appelle.

- Si `BRAINCLAW_SESSION_ID` est absent dans l'environnement :
  - Au premier appel MCP ou CLI d'une conversation, générer un `sess_<random>` automatiquement
  - Le persister dans `.brainclaw/.current-session` (JSON : `{ session_id, started_at, agent }`)
  - Les appels suivants dans le même process/env réutilisent ce session_id
- `session-end` reste disponible mais optionnel — si jamais appelé, la session est considérée
  "implicitement close" au bout du TTL configuré (défaut 4h) ou au prochain `session-start`
- Via MCP : le serveur maintient le session_id dans son état interne pour la durée de la connexion stdio

**Fichiers à modifier** : `src/core/identity.ts` (auto-génération session_id), `src/commands/mcp.ts` (persist session dans le handler), config schema (champ `implicit_session_ttl`)

### 2.4 Alias courts sur les IDs
**Problème** : `cnd_a3f2b1c4` est inutilisable en conversation. Les anciens IDs séquentiels `cnd_001`
étaient meilleurs pour l'UX mais mauvais pour la concurrence.

- Ajouter un compteur auto-incrémenté par type dans `.brainclaw/.id-counter.json`
  (ex: `{ "cnd": 47, "dec": 12, ... }`)
- Chaque item reçoit un `short_label` en plus de son `id` : `cnd#47`, `dec#12`
- L'affichage CLI et les réponses MCP montrent le short_label : `[cnd#47]` au lieu de `[cnd_a3f2b1c4]`
- Les commandes acceptent les deux formats en entrée : `brainclaw accept cnd#47` ou `brainclaw accept cnd_a3f2b1c4`
- Le storage reste basé sur le hash (concurrence-safe), le compteur est best-effort (si le compteur
  diverge entre deux machines, les short_labels peuvent avoir des doublons — mais ce n'est pas grave car l'id canonique reste le hash)

**Fichiers à modifier** : `src/core/ids.ts` (compteur + short_label), `src/core/candidates.ts` / `io.ts` (résolution short_label → id), `src/commands/review.ts` / `accept.ts` / `reject.ts` (lookup par alias)

### 2.5 Résumé d'activité récente par scope (scoped resume)
**Problème** : le `resume_summary` actuel est global par agent. Un agent qui travaille sur `auth/`
ne sait pas "qu'est-ce qui s'est passé récemment sur auth/ spécifiquement".

- Enrichir `context --json` avec un champ `scoped_activity` quand un `--for` est fourni :
  ```json
  "scoped_activity": {
    "scope": "auth/gateway.ts",
    "last_decision": { "id": "dec_xxx", "text": "...", "age_hours": 48 },
    "last_trap": { "id": "trp_xxx", "text": "...", "age_hours": 12 },
    "recent_notes": 3,
    "pending_candidates": 1,
    "last_agent": "copilot",
    "last_session": "sess_xxx"
  }
  ```
- Dérivé du audit.log + state existant, pas de nouveau stockage
- Le digest (2.2) peut s'en servir pour inclure "Dernier agent sur ce scope : copilot, il y a 2h"

**Fichiers à modifier** : `src/core/context.ts` (nouveau `buildScopedActivity`), `src/core/audit.ts` (filtrage par related_paths/tags)

---

## Phase 3 — MCP Universel (Mois 4-5)

### 3.1 Conformité protocole MCP
- Implémenter le handshake initialize/initialized
- Répondre {"error": {"code": -32601, "message": "Method not found"}} aux méthodes inconnues
- Gérer les erreurs de parse JSON avec réponse d'erreur structurée (pas silent fail)
- Implémenter notifications/cancelled pour les requêtes longues

### 3.2 Outils MCP de mutation (write tools)
Outils MCP :
- `bclaw_write_note` : crée un runtime-note (agent, text, visibility, tags, ttl)
- `bclaw_create_candidate` : soumet un item en review (reflect via MCP)
- `bclaw_accept` : accepte un candidat (si agent trusted ou curator)
- `bclaw_reject` : rejette un candidat
- `bclaw_claim` : crée un claim de scope
- `bclaw_release_claim` : libère un claim
- `bclaw_session_start` / `bclaw_session_end` : lifecycle de session

### 3.3 Contrôle d'accès par niveau de confiance via MCP
- Header/params optionnel : agent_id + agent_name
- Les outils de mutation vérifient le trust_level avant d'exécuter
- `bclaw_accept` et `bclaw_reject` réservés aux trusted/curator uniquement

### 3.4 Schema MCP stable et versionné
- Version du format exposée dans chaque réponse : "schema_version": "0.3.0"
- Changelog public des modifications de format dans docs/mcp-schema-changelog.md

**Note sur le streaming (ex 2.4)** : le protocole MCP ne supporte pas nativement le streaming côté serveur dans la spec actuelle. Le `maxChars` budget dans `bclaw_get_context` est une meilleure réponse pragmatique. Si la spec MCP évolue, le streaming sera ajouté opportunistiquement — il n'est plus un item bloquant de la roadmap.

---

## Phase 4 — Intelligence Contextuelle (Mois 5-6)

### 4.1 Recherche full-text
- `brainclaw search <query>` : recherche sur text, tags, author, related_paths dans tous les items
- --type, --section, --since filtres
- Résultats scored par pertinence (BM25, sans dépendance externe)
- Via MCP : outil `bclaw_search`

### 4.2 Détection de contradictions
- À chaque accept/reflect, analyser les items existants pour contradictions logiques
- Phase initiale : paires de mots-clés (must/must-not, enable/disable) — advisory warning, non-bloquant
- Phase suivante : enrichir avec n-gram overlap + scoring de similarité (Jaccard sur les termes) pour réduire les faux positifs
- `doctor --contradictions` expose les conflits détectés
- Objectif : faux positifs < 30% sur un corpus de test réaliste

### 4.3 Auto-reflect amélioré
- Scoring de confiance sur la suggestion de type (déjà partiellement dans reflect-runtime-note.ts)
- Si confidence > seuil configurable ET agent trusted → auto-promote direct
- Batch auto-reflect sur les runtime notes d'une session entière : `brainclaw reflect --session <id> --auto`

### 4.4 Context diff de session
- `brainclaw context-diff --since <session-id>` : quels items ont changé depuis le début de la session
- Format compact pour injection en prompt : "New since your session started: [3 constraints added, 1 decision changed]"
- Via MCP : paramètre since_session dans `bclaw_get_context`

### 4.5 Knowledge relationships
- Détection automatique de liens entre items via overlap de tags et related_paths
- `brainclaw show <id> --related` : items reliés par tags/paths communs
- Exposé dans le contexte comme related: [...] sur les items individuels

---

## Phase 5 — Git Distribué (Mois 6-8)

### 5.1 Remote memory repo
- Config : nouveau champ remote_memory_repo (URL Git) et sync_strategy (pull-only | push-pull | pr-based)
- Seuls les items shared sont synchronisés vers le remote
- machine et private restent strictement locaux
- Structure distant : même layout que .brainclaw/ local, mais uniquement shared/

### 5.2 Commandes de sync distribué
- `brainclaw pull` : git pull du remote memory repo, merge les shared items
- `brainclaw push` : push les shared items vers le remote
- `brainclaw sync --remote` : pull + merge + push en une commande
- Stratégie de merge : last-write-wins par défaut sur les champs non-conflictuels
- Conflit : deux agents ont modifié le même item → créer un conflict candidate en inbox

### 5.3 Conflict resolution protocol
- Nouveau type de candidate : conflict (items contradictoires)
- `brainclaw diff --remote` : voir les divergences avant push
- Resolution strategies : last-write-wins | manual | author-wins | curator-decides
- Configurable par type d'item dans config.yaml

### 5.4 Branch-based isolation (mode PR)
- sync_strategy: pr-based : les agents poussent sur une branche <agent_id>/<date>
- Validation CI : GitHub Action vérifie la cohérence avant merge
- Merge = admission en mémoire canonique partagée
- **Note** : ce mode est conçu pour les environnements enterprise/compliance où la traçabilité des changements prime sur la latence. Pour le cas d'usage standard (agent solo ou petite équipe), le mode embedded + push-pull est recommandé.

### 5.5 GitHub Action (sync distribuable)
- Action : brainclaw/sync-action
- Trigger : push sur main / merge PR
- Comportement : pull, validate (doctor), push résumé comme PR comment
- Expose memory_version comme output variable pour les pipelines CI

---

## Phase 6 — Expérience Agent (Mois 7-8)

### 6.1 Identité agent robuste
- Résolution d'identité agentique explicite, prioriser BRAINCLAW_AGENT sur USERNAME/USER
- Support d'identité basée sur fingerprint : clé publique légère (ed25519) dans AgentIdentityDocument
- Signature optionnelle des entries pour non-répudiation
- `brainclaw whoami` : affiche l'identité courante résolue

### 6.2 Profil d'agent déclaratif
- Chaque agent peut déclarer ses capacités dans son AgentIdentityDocument : capabilities[]
- Exemple : ["code-generation", "review", "test-writing", "planning"]
- Le routing dans agent-board peut suggérer des assignations basées sur les capabilities

### 6.3 Notification de changements
- `brainclaw watch` : mode démon qui surveille les changements et imprime des events sur stdout (NDJSON)
- Events : item_added, item_changed, item_accepted, item_rejected, claim_created, session_started
- Pour les agents qui peuvent maintenir un process background : subscribe via MCP notifications

### 6.4 Context format versionné
- Chaque sortie de context inclut "context_schema": "1.0"
- Breaking changes incrémentent la version majeure
- Changelog dans docs/context-format-changelog.md

---

## Phase 7 — Observabilité et Audit (Mois 8-9)

### 7.1 Event log immuable
- Fichier .brainclaw/audit.log : append-only NDJSON
- Chaque mutation (create/update/accept/reject/claim) génère une entrée : timestamp, actor_id, action, item_id, before/after
- `brainclaw audit [--since <date>] [--actor <agent>]`

### 7.2 History par item
- `brainclaw history <id>` : toutes les mutations d'un item dans l'ordre chronologique
- Dérivé du audit.log

### 7.3 Métriques de santé
- doctor --json enrichi : pending_backlog, avg_review_time, conflict_rate, active_agents_last_7d
- `brainclaw metrics` : tableau de bord de santé de la mémoire

### 7.4 Rollback
- `brainclaw rollback <item-id> --to <timestamp>` : restaure un item à son état antérieur (depuis audit.log)
- Rollback global : `brainclaw rollback --to <timestamp>` (restaure tout l'état à une date passée)

---

## Post-v1 — Horizons écosystème (hors scope roadmap actuelle)

Les items ci-dessous sont des directions futures identifiées mais **volontairement exclues du périmètre v1**.
Ils seront réévalués une fois que le core est stable, les tests solides, et l'adoption initiale mesurée.

### VS Code Extension
- Sidebar : items actifs (contraintes, décisions, traps, handoffs, plans)
- Inline context : hover sur un fichier → traps et contraintes liés au path
- Quick accept/reject depuis la sidebar
- Status bar : memory_version, pending candidates count
- Commande palette : "brainclaw: Get Context for Current File"
- **Pré-requis** : API stable (schema versionné Phase 6.4), MCP universel (Phase 3)
- **Estimation** : projet séparé, 3-6 mois de développement dédié

### Adapters pour agents majeurs
- OpenClaw : bridge bidirectionnel amélioré (events → candidates ET memory → context feed)
- Claude : adapter pour injecter context via system prompt au démarrage
- Cursor : .cursorrules auto-generé + MCP intégré
- GitHub Copilot : .github/copilot-instructions.md auto-généré
- **Note** : l'export multi-format (Phase 1.6) couvre déjà une partie de ce besoin de façon statique. Les adapters dynamiques seront développés quand la demande le justifie.

### Multi-repo federation
- Config : federation block avec liste de repos mémoire enfants/parents
- `brainclaw context` peut merger le contexte de plusieurs repos fédérés
- Utile pour les monorepos ou les orgs avec projets interdépendants
- **Note** : complexité exponentielle (conflits d'IDs inter-repos, trust levels incompatibles, versions de schéma divergentes). À ne pas tenter avant d'avoir une base d'utilisateurs qui le demande.

### Encryption at rest (mode compliance)
- Champ topology: encrypted-local dans config
- Chiffrement des fichiers avec clé dérivée de la clé agent (ed25519)
- Déchiffrement transparent à la lecture
- **Pré-requis** : identité agent avec fingerprint (Phase 6.1)

---

## Fichiers clés à modifier/créer

**Phase 0:**
- `src/core/ids.ts` — remplacement generateId()
- `src/core/claims.ts` — remplacement generateClaimId()
- `src/core/lock.ts` — fix TOCTOU (`flag: 'wx'`), élimination busy-wait
- `src/core/io.ts` — writeFileAtomic wrappé avec lock, nettoyage .tmp orphelins
- `src/core/state.ts` — fix fenêtre corruption
- `src/core/logger.ts` — **nouveau** (module de logging)
- `src/core/migration.ts` — **nouveau** (migration de schéma)
- `src/core/json-store.ts` — **nouveau** (abstraction storage générique)
- `.github/workflows/ci.yml` — **nouveau** (pipeline CI)
- `tests/unit/` — **nouveau répertoire** (tests unitaires du core)

**Phase 1:**
- `src/core/schema.ts` — trust_level sur AgentIdentityDocument, expires_at sur RuntimeNote
- `src/core/agent-registry.ts` — set-trust, trust-level check, circuit-breaker
- `src/commands/session-start.ts`, `session-end.ts`
- `src/commands/reflect.ts` — write-through si trusted
- `src/commands/export.ts` — export multi-format

**Phase 2:**
- `src/core/config.ts` — `auto_reflect_notes`, `implicit_session_ttl`
- `src/core/ids.ts` — compteur short_label
- `src/core/identity.ts` — auto-session
- `src/core/context.ts` — `buildContextDigest`, `buildScopedActivity`
- `src/commands/mcp.ts` — digest arg, auto-session, auto-reflect dans write_note
- `src/commands/context.ts` — `--digest`
- `src/commands/runtime-note.ts` — `--auto-reflect`

**Phase 3:**
- `src/commands/mcp.ts` — conformité + outils mutation
- `docs/mcp-schema-changelog.md`

**Phase 4:**
- `src/core/search.ts` — BM25
- `src/core/contradictions.ts` — détection améliorée (n-gram + Jaccard)
- `src/commands/search.ts`

**Phase 5:**
- `src/core/sync-remote.ts`
- `src/commands/pull.ts`, `push.ts`
- `.github/workflows/brainclaw-sync.yml` — GitHub Action distribuable

**Phase 6:**
- `src/commands/whoami.ts`
- `src/commands/watch.ts`

**Phase 7:**
- `src/core/audit.ts` — append-only log
- `src/commands/audit.ts`, `history.ts`, `rollback.ts`, `metrics.ts`

---

## Vérification par phase

**Phase 0:** tsc sans erreurs + tests existants passent + nouveaux tests unitaires du core passent + CI green
**Phase 1:** nouveaux tests session-lifecycle, trust-tiers (circuit-breaker inclus), ttl-prune, export-formats
**Phase 2:** test auto-reflect flow, test digest output, test implicit session, test short_label resolution, test scoped_activity
**Phase 3:** test MCP protocol compliance + mutation tools
**Phase 4:** test search BM25, test détection contradictions (métriques faux positifs), test context-diff
**Phase 5:** test de merge Git distribué en isolation (tmp bare repo)
**Phase 6:** test watch events, test whoami, test capabilities routing
**Phase 7:** test audit trail, test rollback

---

## Décisions clés

- **Agent-first** : l'UX agent (Phase 2) est priorisée avant la distribution Git et l'écosystème
- **Adoption early** : l'export multi-format (Phase 1.6) est remonté pour créer un hook d'installation immédiat
- Full agent autonomy : trusted agents bypass la review queue — human curator reste disponible mais non-requis, avec circuit-breaker de sécurité
- Git remote = seule couche de distribution : pas de serveur, pas de base de données
- MCP = interface principale pour les agents (le CLI reste pour les humains et le CI)
- Pas de dépendances ML externes : tous les algorithmes (similarité, scoring, BM25) sont implémentés localement
- Engineering hygiene d'abord : tests unitaires, logging, migration de schéma, CI — avant les nouvelles features
- Écosystème externe (VS Code, federation, encryption) différé post-v1 : ne pas disperser l'effort sur des projets séparés avant que le core soit solide
