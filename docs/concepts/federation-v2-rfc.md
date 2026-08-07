# RFC joint — Fédération v2 : projection chiffrée, appariement attesté et board aveugle

> **Statut :** décision d'architecture à implémenter  
> **Propriétaire :** core + Cloud, document canonique unique  
> **Remplace :** l'étape 1 de pln#650 et celle de pln#102, et les propositions de transition du format antérieur  
> **Dépendances :** dec#154, dec#155, dec#156, dec#8/cst#1–4 côté Cloud, décision promue depuis can_b16f6957, trp#1520

Ce fichier est le RFC commun : le dépôt Cloud le référence, il ne maintient pas un second protocole. Les deux implémentations prennent les types, vecteurs et règles de refus de ce document comme contrat unique.

## 1. Décision et invariant

La fédération v2 remplace entièrement le fil antérieur. Ce format est **abandonné**, pas déprécié : aucune lecture, négociation, conversion, réémission ni migration depuis cloud_sync ou BRAINCLAW_CLOUD_* n'est autorisée. Les enveloppes anciennes en attente sont jetables. L'activation ne peut résulter que d'un appariement explicite enregistré dans l'état local de connexion ; la présence d'une variable d'environnement ne vaut jamais consentement.

> Rien ne quitte l'hôte en clair en dehors du squelette non verbal explicitement classé, et rien n'entre dans la mémoire locale sans signature d'origine vérifiée. Les deux directions échouent fermées.

sealed est le seul transport de contenu. Une erreur de classification, validation, chiffrement, signature, révocation ou fraîcheur annule l'opération ; elle ne produit ni export tronqué ni matérialisation locale. Le profil public est opaque par défaut.

### Hors périmètre v1

- Le Cloud n'est pas la mémoire canonique : il conserve une projection, des opérations de contrôle et un état de transport.
- Le board ne reçoit aucune clé et ne déchiffre rien dans le navigateur v1.
- **La recherche reste locale.**
- La révocation ne prétend pas effacer une clé ou un texte déjà détenu ; elle protège seulement les données futures.
- Réécrire le passé signifie reprojeter depuis le local, jamais réécrire des ciphertexts dans le Cloud.

## 2. Acteurs, identifiants et conflit

| Élément | Règle v2 |
| --- | --- |
| Hôte local | Source de vérité des contenus, journal et mapping local → Cloud. Il ne délègue jamais une écriture de contenu au Cloud. |
| Cloud | Transport, autorisations, projection chiffrée, opérations de board et états pending/synced/conflict. Il ne déchiffre pas. |
| cloud_project_id | UUID opaque de l'espace Cloud. Le nom et le chemin locaux ne sont ni URL ni AAD publics. |
| id_opaque | UUID v4 client pour un objet local. Le mapping vers id reste local et ne traverse jamais le fil. |
| base_rev | Révision monotone par objet opaque. Prérequis de toute écriture/commande et borne anti-rollback du lecteur. |
| operation_id | UUID aléatoire par intention de transport, conservé au retry. Il porte l'idempotence, pas un hash de texte. |
| États visibles | Une opération est pending, synced ou conflict. Un conflit conserve base_rev, opération et proposition de résolution ; aucun last-write-wins silencieux. |

Une commande de board est la troisième classe d'appelants de dec#155 : elle ne reçoit qu'un identifiant opaque et un base_rev, jamais cwd, session ou contexte ambiant. Elle est matérialisée dans le journal local après vérification. Une divergence de révision est refusée et visible.

## 3. Enveloppe de fil v1

Chaque objet, révision, opération de board ou paquet de clés v2 utilise une enveloppe stricte. Il n'existe pas de payload inconnu au point d'egress.

~~~ts
type FederationEnvelopeV1 = {
  schema: 'brainclaw.federation-envelope/v1';
  meta: PublicMetaV1;
  sealed: {
    alg: 'HPKE-v1/X25519-HKDF-SHA256-CHACHA20POLY1305';
    enc: string;        // clé HPKE encapsulée, base64url canonique
    nonce: string;      // nonce AEAD, base64url canonique, unique par enc
    ciphertext: string; // blob AEAD, base64url canonique
  };
  key_epoch: number;
  origin_sig: {
    alg: 'Ed25519';
    key_id: string;     // référence opaque d'une identité enregistrée
    value: string;      // signature base64url canonique
  };
};

type PublicMetaV1 = {
  id_opaque: string;
  kind: FederatedKind;
  status: PublicStatus;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  rank?: number;
  deps: Array<{ from: string; to: string }>;
  timestamp_bucket_jour: string; // YYYY-MM-DD UTC
  base_rev: number;
  aad: CanonicalAadV1;
  wrap_hint: string; // référence opaque de paquet/roster, jamais un destinataire
  transport: {
    operation_id: string;
    content_hash: string;
    idempotency_key: string;
  };
};
~~~

key_epoch et origin_sig sont au niveau de l'enveloppe afin qu'ils restent visibles sans clé ; ils sont aussi liés aux octets signés. Aucun champ local ne peut être ajouté à meta. L'absence d'un champ optionnel est significative : priorité et rang ne sont pas inventés pour les objets qui n'en ont pas.

### 3.1 Octets canoniques, AAD et signature

Les sérialisations hachées, chiffrées ou signées sont JSON UTF-8 canonique : clés triées par code point, aucune espace, chaînes NFC, entiers finis sans notation exponentielle et base64url sans padding. Core et Cloud partagent les vecteurs de test ; ils ne réimplémentent pas chacun une quasi-canonicalisation.

L'AAD est une structure canonique, pas une chaîne concaténée ambiguë.

~~~ts
type CanonicalAadV1 = {
  protocol: 'brainclaw/federation/v1';
  cloud_project_id: string;
  object_id: string;       // id_opaque
  base_rev: number;
  object_type: FederatedKind;
  schema: 'brainclaw.federation-envelope/v1';
};
~~~

La suite crypto v1 est DHKEM(X25519, HKDF-SHA-256), HKDF-SHA-256 et ChaCha20-Poly1305. enc, nonce, alg, key_epoch et l'AAD sont obligatoires. Toute répétition du couple de contexte de nonce est une erreur d'émission. Le déchiffrement utilise exactement cet AAD et échoue fermé au moindre octet différent.

L'entrée Ed25519 est :

~~~text
"brainclaw/federation-envelope/v1\0"
|| canonical(meta)
|| canonical(sealed)       // alg, enc, nonce et ciphertext inclus
|| canonical(key_epoch)
~~~

Le raccourci « signature sur meta || ciphertext » couvre ainsi également les paramètres permettant d'interpréter le ciphertext. Une signature valide est vérifiée contre l'identité Ed25519 du roster de projet, pas contre un from autorapporté ni un en-tête HTTP.

### 3.2 Hash, idempotence et erreurs 409

content_hash est SHA-256(canonical(sealed)), rendu base64url. Il ne porte jamais un hash de texte clair. L'AEAD aléatoire empêche un essai de contenu à faible entropie d'être confirmé par hash côté Cloud.

idempotency_key est SHA-256(canonical(sealed) || operation_id || origin_sig.key_id). Le client crée operation_id aléatoirement avant le premier envoi et le réutilise pour tous ses retries. Le Cloud compare ces valeurs opaques ; il ne les recalcule pas à partir de contenu. Les réponses 409 STALE et 409 REV_CONFLICT emploient base_rev, operation_id et ces dérivés du ciphertext, jamais un content_hash historique sur texte clair.

## 4. Classification exhaustive d'egress

La classification comporte exactement trois classes : **clair**, **scellé** et **interdit de sortir**. « Non classé » n'est pas une quatrième classe : c'est un refus. Cette table est le contrat de l'étape 5, non une liste indicative.

### 4.1 Champs publics autorisés

Seuls les champs ci-dessous peuvent quitter l'hôte hors de sealed. Tous sont structurels, normalisés et explicitement construits ; id, noms et références locaux ne sont jamais recopiés.

| Champ clair | Origine / normalisation | Limite de confidentialité |
| --- | --- | --- |
| id_opaque | UUID v4 client, mapping local conservé localement | Stable dans un projet Cloud, pas cross-projet |
| kind | Type de l'entité : plan, claim, handoff, etc. | Révèle le mix de types |
| status | État métier normalisé et, le cas échéant, état de sync public | Révèle avancement et conflits |
| priority | Enum de priorité quand l'entité en porte une | Révèle l'urgence relative |
| rank | Entier de séquence quand l'entité en porte un | Révèle l'ordre relatif |
| deps | Arêtes d'UUID opaques from → to, sans libellé ni chemin | Révèle le graphe |
| timestamp_bucket_jour | Jour UTC de l'événement/révision, jamais l'heure | Révèle une cadence quotidienne |
| base_rev | Compteur monotone par id_opaque | Révèle la fréquence des changements |
| key_epoch | Epoch crypto actif | Révèle les rotations, pas les clés |
| aad | Les six champs canoniques de §3.1 | Lie projet, objet, rév., type et schéma |
| wrap_hint | Référence opaque au paquet de clés de l'epoch | Ne contient ni nom ni empreinte de destinataire |
| origin_sig | key_id, algorithme et signature | Pseudonyme stable, nécessaire à la vérification |
| transport | operation_id, content_hash, idempotency_key dérivés du ciphertext | Retry sans oracle de texte clair |

Le champ status contient au plus un couple normalisé object/sync. sync vaut pending, synced ou conflict lorsqu'un état est connu du transport. Le Cloud n'infère jamais un état local absent : sans marqueur reçu, le board affiche « état local inconnu / hors ligne ». Un client local peut, lui, afficher pending avant émission.

### 4.2 Règles de classement des feuilles Zod

| Classe | Feuilles source | Traitement |
| --- | --- | --- |
| Clair | seulement les états, priorité, rang et liens dont la projection les mappe explicitement vers §4.1 | Construire une valeur normalisée ; ne jamais recopier la feuille source |
| Scellé | titres, noms, text, descriptions, tags, lanes, scope_hint, rationale, verify_cmd, auteurs, modèles, provenance, commentaires, résultats, compteurs, heures précises et objets/maps libres | Placés dans le document AEAD. Un map unknown reste un unique leaf scellé : le projecteur public ne peut ni l'inspecter ni le fusionner |
| Interdit | chemins locaux, host_id, session_id, worktree_path, project_path, storage_dir, commandes, shell, PID, clés, secrets, variables d'environnement et configuration locale | Absent de meta **et** de sealed. Sa présence fait échouer la projection |

id et toutes les références locales *_id sont scellés ou omis, sauf lorsqu'une relation est expressément projetée comme arête dans deps après traduction des deux extrémités en UUID opaques. project_id local ne sort pas : cloud_project_id opaque ne vit que dans l'AAD. visibility est une règle locale de décision d'export, jamais une donnée fédérée.

### 4.3 Inventaire Zod fédérable, claims et handoffs inclus

Cette table définit l'ensemble exhaustif de schémas de contenu admis par v2. Une famille absente est **non projetable** : son schéma entier est interdit de sortie. Les règles communes de §4.2 s'appliquent à chaque ligne. La flèche signifie transformation, pas copie de champ local.

| Schéma source / chemins couverts | Clair explicitement projetable | Scellé | Interdit de sortir |
| --- | --- | --- | --- |
| ConstraintSchema + confirmations[] | id → id_opaque, kind=constraint, status, jour, base_rev | short_label, text, catégorie, scope, tags, plan_id, expiration, cycle de confirmation et chaque MemoryConfirmationEvent | related_paths, project_id, host_id, session_id |
| DecisionSchema + confirmations[] | id, kind=decision, résultat normalisé dans status, jour, révision | short_label, text, outcome, tags, plan_id, verified_at, verify_cmd, auteurs, provenance et confirmations | related_paths, project_id, host_id, session_id |
| TrapSchema + confirmations[] | id, kind=trap, status, jour, révision | libellé, texte, sévérité, catégorie de plateforme, tags, dates, verify_cmd, provenance et confirmations | related_paths, project_id, host_id, session_id |
| HandoffSchema, contract, review, snapshot | id, kind=handoff, status, liens transformés en deps, jour, révision | from, to, texte, récit, tags, contrat, revue, snapshot.diff, snapshot.diff_digest, auteurs, modèle, provenance, correction | related_paths, project_id, host_id, session_id, toute clé/chemin caché dans contrat ou snapshot, visibility |
| PlanItemSchema + PlanStepSchema | plans et étapes ont chacun un id opaque, kind, status, priority, depends_on → deps, rang si séquencé, jour, révision | texte des plans/étapes, type, assignee, projet, tags, effort, heures précises | related_paths, identifiants locaux d'assignee/projet hors deps |
| SequenceSchema + SequenceItemSchema | id, kind=sequence, status, rank, hard_after/soft_after → deps, jour, révision | name, description, lane, scope_hint, rationale, owner, tags et distinction sémantique des arêtes | project_id, host_id, session_id, ids de plan/étape non traduits |
| ClaimSchema | id, kind=claim, status, lien plan seulement s'il devient deps, jour, révision | agent, user, scope, description, mode de handoff, dates, modèle, références d'assignation et base_sha | project_id, host_id, session_id, worktree_path, paths, toute information de checkout |
| CandidateSchema, CandidateUseSchema, CandidateContradictionSchema | id, kind=candidate, status, lien plan traduit, jour, révision | texte, type, auteurs, origin, tags, from/to, usages, contradictions, narration, motif de promotion/résolution, provenance, sévérité | project_id, host_id, session_id, related_paths, visibility |
| RuntimeNoteSchema | id, kind=runtime_note, statut normalisé, jour, révision | agent, texte, note type, tags, expiration, modèle, provenance | project_id, host_id, session_id, visibility |
| InboxMessageSchema | id, kind=inbox_message, statut, liens explicitement transformés, jour, révision | from, to, type, texte, ref, payload, scope, thread, acquittements, auteurs, tags et longueurs | project_id, host_id, session_id, claim_id/assignment_id non traduits ; aucun payload n'est promu au clair |
| AssignmentSchema + AssignmentArtifactSchema | id, kind=assignment, statut normalisé, liens explicitement traduits, jour, révision | description, scope, lane, raisons, artefacts, erreurs, retries, TTL, tags et tous les temps exacts | agent_id, session_id, worktree_path, project_id local, identifiants de message/claim non traduits |
| AgentRunSchema | id, kind=agent_run, statut, liens explicitement traduits, jour, révision | description, scope, raison, artefacts, erreurs, tags et temps exacts | agent_id, session_id, project_id, worktree_path, command, shell, pid, provider_run_id |
| ActionRequiredSchema + response | id, kind=action_required, statut, liens explicitement traduits, jour, révision | titre, prompt, options, response_schema, réponse, agent, tags et raison | agent_id, session_id, tout payload contenant une valeur interdite, références locales non traduites |
| AiSurfaceTaskRequestSchema | id, kind=ai_task, statut, jour, révision | titre, instructions, surface cible, outputs, note de résultat, tags, auteur et modèle | project_id, session_id, related_paths |
| RuntimeEventSchema + LaneResultSchema | id, kind=runtime_event ou lane_result, statut normalisé, jour, révision | texte, metadata, raisons, artefacts, corps, verdict, tags, corrélations et modèle | agent_id, project_id, host_id, session_id, scope, related_paths, transport/commande locale et tout chemin de worktree |
| ProvenanceSchema / ProvenancePassthroughSchema | aucun | objet entier : auteurs, sessions, source et diagnostics restent dans le blob | tout chemin, host, session, projet local ou secret qu'il contient demeure interdit par validation récursive |
| MemoryConfirmationEventSchema | aucun autonome | objet entier | session_id |

L'autre moitié de l'inventaire est entièrement **interdite de sortie**, sans projecteur v2 : StateSchema, ConfigSchema et ses sous-schémas (notamment CloudSyncConfigSchema, RemoteSyncSchema, sécurité et détection de secrets), ProjectIdentityDocumentSchema, AgentIdentityDocumentSchema, AgentIdentityKeySchema, AgentProfileSchema, AgentInvokeSchema, profils/bootstrap, snapshots de session, intégrations, liens de projets, outils/capabilities, configurations de réputation et tout schéma de clés ou de stockage sûr. Les clés publiques d'identité de vérification vivent seulement dans le roster d'appariement, protocole de contrôle distinct des documents locaux.

### 4.4 Mécanisme d'application décidé pour l'étape 5

L'implémentation v2 a une seule source de vérité de classification : un FederationClassificationManifestV1 versionné, qui associe chaque chemin de feuille de chaque schéma fédérable du tableau à exactement une des trois classes. Un chemin dynamique record, unknown ou union permissive est un leaf unique classé ; il ne peut produire aucune sous-clé publique.

Trois filets complémentaires l'appliquent :

1. Un builder nominal et brandé toPublicProjection(entity, sealed) choisit les champs de meta un à un. Aucun spread n'est admis, et le type brandé ne peut être construit hors du module de projection.
2. Tous les émetteurs passent par un point de sortie unique qui parse FederationEnvelopeV1 avec Zod .strict(). En mode confidentiel, une clé inconnue ou un plaintext non classé refuse l'export ; elle n'est jamais silencieusement supprimée.
3. La CI produit une fixture golden byte-exact par créateur et une vérification de complétude. Elle importe les schémas Zod source, énumère leurs feuilles après déroulage des wrappers et exige une entrée unique du manifest pour chacune. Ajouter une feuille fait échouer la CI jusqu'à sa classification. Des sentinelles dans chaque feuille scellée et interdite ne doivent apparaître dans aucun JSON de fil.

Les trois filets sont nécessaires : Zod dépouille les clés inconnues par défaut, un test de sortie ne prouve pas les N constructeurs, et un spread d'entité reste typable en TypeScript tout en sérialisant les clés présentes à l'exécution.

## 5. Clés de projet, appariement et récupération

### 5.1 Chiffrement de projet et epochs

Chaque projet possède une paire X25519 de chiffrement par epoch. La clé publique est distribuée aux émetteurs ; ils peuvent sceller mais ne peuvent pas lire. La partie privée de l'epoch est remise, sous enveloppes HPKE, aux seuls appareils lecteurs autorisés. Chaque appareil possède sa propre paire X25519 dans le stockage sûr. Sa clé privée est distincte de la clé d'identité Ed25519 de ~/.brainclaw/keys/ : aucune clé ne se dérive de l'autre.

Le paquet de clés référencé par wrap_hint est une liste auditable d'enveloppements epoch-private-key → device-x25519-public-key, avec identité Ed25519 attestante et approbation autorisante. Il ne donne au board ni nom humain ni clé privée. Un écrivain n'obtient que la clé publique de projet et son accès de signature : « écrire sans lire » est une propriété d'architecture.

Le stockage local conserve le lien workspace ↔ cloud_project_id, l'identité d'appareil, le trousseau Map<epoch, key>, la position de sync, l'outbox v2 et les états visibles. Aucun secret ne va dans la configuration en clair. Le plafond est explicite : ~/.brainclaw/keys/ est lisible par les processus du même UID ; la sécurité Cloud ne dépasse pas celle du disque local. TPM, enclave et HSM sont une v2 ultérieure.

### 5.2 Cérémonie d'appairage attestée

Le parcours nominal brainclaw cloud connect est :

1. L'utilisateur ouvre un code ou lien d'invitation et crée un enrollment pending pour un cloud_project_id opaque.
2. L'appareil génère sa paire X25519, puis signe une attestation avec sa clé d'identité Ed25519 déjà enregistrée. L'attestation lie projet, enrollment_id, challenge frais, clé publique X25519 et leurs empreintes.
3. Un membre habilité voit les empreintes Ed25519 **et** X25519, vérifie la preuve de possession du challenge, le rôle demandé et approuve/refuse. Le Cloud refuse une clé de chiffrement sans chaîne vers une identité enregistrée : aucun membre fantôme n'est ajouté au roster.
4. Après approbation, le client reçoit les credentials liés au workspace et les enveloppes de clés autorisées. Il effectue un premier pull en lecture seule, validé mais non matérialisé dans la mémoire.
5. status affiche rôle, epoch courant et état de sync. disconnect supprime l'autorisation locale et demande la révocation distante ; il ne prétend pas effacer les anciens blobs ou clés déjà lus.

Le parcours nominal ne demande jamais de copier API key, PEM, agent_id ou variable d'environnement. Une API key manuelle, si elle reste nécessaire pour compatibilité, est documentée hors de ce parcours et ne déclenche aucun sync par sa seule présence. Chaque phase conserve un état reprenable ; un enrollment interrompu est repris ou expiré proprement, jamais laissé orphelin.

Avant le premier sync, le client affiche le rôle, la table de classification et l'inventaire de reconstruction de §7. Ces textes sont dérivés de ce RFC, pas réécrits dans une seconde notice Cloud.

### 5.3 Perte d'appareil et révocation forward-only

Un projet ne peut émettre sa première enveloppe v2 qu'après l'enrôlement de deux appareils de récupération indépendamment attestés. Ils peuvent appartenir à une même personne, mais leurs clés privées ne partagent pas un même stockage. Cette règle fournit un chemin de remplacement : un porteur restant approuve la nouvelle clé, lui enveloppe les epochs historiques autorisés, puis révoque l'appareil perdu.

La révocation a deux couches :

- l'autorisation Cloud est coupée immédiatement ; le membre révoqué ne peut plus pousser, tirer ni faire approuver une clé ;
- le Cloud exige alors un key_epoch suivant. Dès qu'un porteur autorisé est en ligne, il crée l'epoch, publie un roster excluant le révoqué et les futures écritures utilisent ce nouvel epoch.

Si tous les porteurs autorisés sont hors ligne, la latence cryptographique est **non bornée** : le Cloud bloque les nouvelles écritures plutôt que d'accepter l'ancien epoch, jusqu'au retour d'un porteur. L'ancien membre lit encore ce qu'il avait déjà déchiffré ou reçu sous l'ancien epoch ; ce fait doit être testé et affiché. Si tous les appareils de récupération sont perdus, les données scellées passées sont irrécupérables par conception : on peut initier un nouvel epoch et projet logique, jamais prétendre qu'un reset Cloud les restaure.

« Rechiffrer le passé » signifie produire de nouvelles enveloppes depuis une copie locale autorisée, avec nouveaux IDs/révisions si nécessaire. Ce n'est ni une réécriture de ciphertext stocké par le Cloud ni une rotation rétroactive.

## 6. Réception : signature, anti-rejeu et matérialisation

Avant toute écriture via saveCandidate, saveRuntimeNote ou un autre chemin de mémoire, le lecteur :

1. parse strictement l'enveloppe et contrôle schéma, AAD et epoch ;
2. résout origin_sig.key_id dans le roster attesté, puis vérifie Ed25519 sur les octets canoniques complets ;
3. contrôle rôle, révocation et wrap_hint, puis déchiffre AEAD ;
4. vérifie que le plaintext correspond au type et au mapping local attendu ;
5. applique l'anti-rejeu : base_rev doit être strictement supérieur au high-water mark persistant de l'objet, ou être le même envelope déjà connu par idempotency_key ; une révision inférieure est refusée ;
6. dédoublonne par idempotency_key, append le résultat vérifié au journal local, puis seulement matérialise.

Signature absente, invalide ou d'une autre identité, modification de status/priority/deps, epoch révoqué et rollback sont tous des refus sans enregistrement local. Le Cloud peut encore retarder ou omettre une enveloppe, mais ne peut pas injecter ni faire accepter une ancienne révision comme actuelle. Le curseur de feed est conservé pour l'efficacité ; le high-water mark signé par objet est la barrière de sûreté.

## 7. Contrat du board aveugle et inventaire de reconstruction

Sans clé, le board rend seulement une carte générique : icône kind, placeholder fixe « contenu scellé », badge status, priorité/rang éventuels, arêtes vers UUID opaques, jour, base_rev, epoch et état de transport. Il ne rend aucun titre, nom, description, tag, lane, auteur, scope ou aperçu de ciphertext. L'absence de marqueur de sync est visible comme « état local inconnu / hors ligne », jamais masquée en « synchronisé ».

Le déchiffrement navigateur est entièrement différé après v1. Même un membre autorisé voit le même placeholder sur le board v1 ; il utilise son client local pour lire et rechercher le contenu.

Cette opacité n'est pas une promesse d'anonymat ou d'inférence nulle. Avec le seul squelette public, un adversaire peut reconstituer :

| Déduction possible | Signaux publics |
| --- | --- |
| Taille d'équipe | nombre de signataires/périphériques attestés, recipients de roster, rythme des opérations |
| Mix de fournisseurs | empreintes corrélables à des identités externes, classes/rythmes de clients et rôles connus du Cloud |
| Vélocité | jours, volumes, base_rev, retries et transitions |
| Forme de roadmap | kind, rank, deps, priorités et statuts |
| Chemin critique | graphe, ordres et états bloqués |
| Volume | nombre, taille et cadence des enveloppes |
| Arborescence/hiérarchie | dépendances, rôles d'approbation, groupes de cartes et positions relatives |

Les utilisateurs approuvent cet inventaire lors du pairing. Padding, obfuscation de graphe, anonymat des signataires et recherche protégée sont des chantiers ultérieurs explicites, pas des propriétés implicites de l'AEAD.

## 8. Critères de conformité inter-dépôts

Avant activation v2, core et Cloud partagent et passent les mêmes vecteurs d'encodage canonique, AAD, HPKE, signature, content_hash, idempotence et refus. Le pack de surface couvre au minimum :

- sentinelles dans chaque champ scellé/interdit de chaque créateur, absentes de tout JSON sortant ;
- Cloud hostile : signature ou metadata forgée, donc zéro écriture mémoire locale ;
- ciphertext ancien valide et réordonnancement de metadata : refus anti-rollback et intégrité ;
- invitation, approbation, preuve de possession, interruption/reprise et refus d'une clé de chiffrement non attestée ;
- deux machines, outbox hors ligne et reprise sans doublon ;
- révocation forward-only, en affirmant que l'ancien porteur lit le passé détenu mais jamais le futur epoch ;
- board sans clé : graphe et états rendus, aucun libellé en clair ni faux état synced.

La topologie de test contient deux hôtes simulés et un workspace multi-projets, et utilise isolateAgentEnv() plutôt qu'un nettoyage ad hoc de l'environnement. Les assertions portent sur le disque et les octets effectivement envoyés ou reçus, pas seulement sur des helpers internes.