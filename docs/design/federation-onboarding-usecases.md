# Fédération cloud — cartographie des cas d'usage et des parcours

> Objectif fixé par l'opérateur (2026-08-09) : identifier **tous** les cas pour qu'un ou
> plusieurs humains, sur un ou plusieurs projets, avec un ou plusieurs agents, utilisent la
> fédération **simplement**. Point de départ : l'onboarding côté cloud, avec l'idée d'un
> appairage par agent via une URL d'activation.
>
> Chaque affirmation « état actuel » de ce document a été **mesurée sur le code ou en
> production cette session** — les références (dec#, trp#) pointent la mesure.

---

## 1. Le vocabulaire d'abord — quatre identités, pas deux

Tout le reste du document repose sur cette distinction. La confusion entre ces quatre
notions est la cause directe des deux pièges déjà rencontrés (trp#1610, trp#1625).

| Identité | Ce qu'elle est | Sa preuve | Où elle vit |
|---|---|---|---|
| **Compte humain** | La personne — s'inscrit, approuve, administre | session web (email + mot de passe) | cloud (`users`) |
| **Appareil** | La machine — détient les clés de **déchiffrement** | clé X25519, empreinte comparée à l'appairage | local (`~/.brainclaw/keys/`) + cloud (`enrollments`) |
| **Agent** | Le logiciel (claude-code, codex…) — **signe** ce qu'il émet | clé Ed25519, attestée à l'appairage | local (registre d'agents) + cloud (`agents`) |
| **Projet** | Le magasin `.brainclaw/` et sa projection aveugle | — | local (source de vérité) + cloud (projection, dec#154) |

Relations cibles (dec#158/159) : un humain **possède** des appareils ; un appareil
**héberge** des agents ; un enrôlement lie *(agent, appareil, humain propriétaire, projet)*.

**Écart mesuré aujourd'hui** : l'enrôlement lie agent + appareil mais **pas l'humain**
(aucun `owner_user_id`), et l'état local ne connaît qu'**un** appairage par workspace, sans
mémoriser quel agent (trp#1625).

---

## 2. La matrice des situations

Quatre axes : humains (1/N) × machines (1/N) × agents (1/N) × projets (1/N).
Les combinaisons se ramènent à six situations réellement distinctes :

| # | Situation | État aujourd'hui | Ce qui bloque |
|---|---|---|---|
| S1 | 1 humain, 1 machine, 1 agent, 1 projet | ✅ **fonctionne, vérifié en prod** | — |
| S2 | + agents supplémentaires sur la même machine | ❌ | `connection.json` singleton : le 2ᵉ `connect` **écrase** le 1ᵉʳ (trp#1625) |
| S3 | + machines supplémentaires (même humain) | ❌ | pas de **remise de clé d'epoch** : la 2ᵉ machine ne peut ni lire ni sceller (dec#159) |
| S4 | + humains supplémentaires (équipe) | ❌ | pas d'invitation par email (`404` si compte inexistant, zéro envoi d'email), pas de propriétaire d'appareil |
| S5 | plusieurs projets | 🟡 | 1 workspace = 1 projet : correct par construction ; clés API scopées par projet (vérifié : `403` croisé) ; mais l'URL du cloud n'est pas persistée, à repasser à chaque commande |
| S6 | agents sans humain au terminal (CI, headless) | ❌ non conçu | la cérémonie exige un humain qui compare des empreintes — cas à traiter explicitement, pas par contournement |

La règle de conception qui découle de dec#158 : **le solo est le cas dégénéré du modèle
d'équipe**, jamais une branche parallèle. S1 doit rester exactement « S4 où le même humain
joue tous les rôles et où les approbations s'effondrent en un geste ».

---

## 3. Les parcours, un par un

Convention : 🖥 = côté cloud (navigateur), ⌨ = côté machine (terminal), 👤 = geste humain
explicite. ✅/🟡/❌ = état mesuré de chaque étape.

### W1 — Solo : premier appairage (S1) — *fonctionne aujourd'hui*

Le cas « j'utilisais déjà brainclaw en local » : le magasin existe, le cloud est vide.

| # | Étape | Où | État |
|---|---|---|---|
| 1 | Créer un compte, créer/choisir le projet cloud | 🖥 | ✅ |
| 2 | « Connect an agent » → créer une invitation (rôle + libellé) → **code affiché une fois** (TTL 15 min, usage unique, seul le SHA-256 est stocké) | 🖥👤 | ✅ |
| 3 | `brainclaw cloud connect <code> --url <url> --agent <id>` **depuis le bon workspace** — le workspace appairé est affiché avec les empreintes | ⌨ | ✅ (garde trp#1610 livrée) |
| 4 | Comparer les **deux empreintes** terminal ↔ écran, approuver | 🖥👤 | ✅ |
| 5 | `brainclaw cloud await --url <url>` → appairage local actif, **genèse de la clé d'epoch 1** (premier appareil seulement) | ⌨ | ✅ (livré ce jour) |
| 6 | `brainclaw cloud push --url <url>` → plans + mémoire projet scellés, envoyés, stockés | ⌨ | ✅ (vérifié en prod : enveloppe en base, zéro fuite) |

**Frictions restantes de W1** (aucune bloquante) : l'URL doit être répétée à chaque commande
(l'état ne la persiste pas — mesuré) ; `connect` puis `await` sont deux commandes là où une
seule suffirait (`connect` pourrait attendre l'approbation en sondant) ; l'agent doit être
un identifiant opaque `[a-zA-Z0-9_-]{4,64}` et l'erreur ne le dit qu'après coup.

### W2 — Deuxième agent, même machine (S2) — *à construire*

Cible : les agents d'une même machine **partagent la clé X25519 de l'appareil** et signent
chacun avec leur Ed25519. C'est cohérent avec l'attestation existante (elle lie déjà un
Ed25519 à un X25519) : chaque agent atteste **la même** clé d'appareil.

| # | Étape | Où | État |
|---|---|---|---|
| 1 | Créer une invitation **par agent** (ou une invitation multi-usages ? → non : usage unique conservé, un code par agent) | 🖥👤 | ✅ (mécanique identique à W1) |
| 2 | `cloud connect <code> --agent <id2>` → détecte l'appairage existant, **réutilise la clé d'appareil**, ajoute un enrôlement à la liste | ⌨ | ❌ `connection.json` doit devenir une **liste d'appairages** `{agent, enrollment_id, role}` autour d'un `device` unique |
| 3 | Approbation par empreintes — l'empreinte de chiffrement **répète** celle de l'appareil, l'empreinte d'identité change par agent | 🖥👤 | 🟡 l'écran d'approbation existe ; afficher « appareil déjà connu » serait le bon signal |
| 4 | Chaque agent pousse sous sa propre signature ; l'origine (`origin_agent_id`) les distingue | ⌨ | ✅ le transport le fait déjà |

**Prérequis structurel** : migration de `connection.json` (forme v2 → v3) avec lecture
tolérante des deux formats — même discipline que la purge cloud (rien d'irréversible sans
chemin de retour).

### W3 — Deuxième machine, même humain (S3) — *bloqué sur la remise d'epoch*

| # | Étape | Où | État |
|---|---|---|---|
| 1 | Invitation + cérémonie sur la machine B (identique à W1 étapes 2–4) | 🖥⌨👤 | ✅ |
| 2 | La machine B est `active` **mais ne détient aucune clé d'epoch** : elle ne peut ni lire ni sceller | — | ⚠️ c'est l'état actuel : actif et inopérant, sans message |
| 3 | Une machine détentrice (A) **remet** les epochs autorisés : paquet HPKE scellé vers la X25519 attestée de B, manifeste signé (`epoch_grant`, dec#159) | ⌨ A | ❌ à construire — **le cœur du chantier** |
| 4 | B vérifie le manifeste, range les clés (`storeEpochPrivateKey` refuse déjà d'écraser une clé différente), relit le passé autorisé | ⌨ B | 🟡 primitives présentes, protocole absent |

**Point de vigilance déjà mesuré** : le premier appairage marque `recovery: true` et le
quorum de récupération (2 appareils) est **rapporté mais jamais appliqué** — le solo n'est
pas bloqué, mais la perte de l'unique machine = perte du passé, et rien ne l'affiche.

### W4 — Embarquer un deuxième développeur (S4) — *le parcours demandé, à construire*

Le principe directeur (convergence des deux critiques de l'idéation) : **deux approbations
de nature différente**. L'admin admet **l'humain** ; l'humain approuve **ses appareils**.
Un admin ne peut pas comparer les empreintes du terminal d'un tiers — le faire approuver à
sa place réduirait la cérémonie à un clic de confiance (dec#8).

| # | Étape | Où | État |
|---|---|---|---|
| 1 | Admin : « Inviter un membre » → email + rôle | 🖥👤 | ❌ aujourd'hui `404` si le compte n'existe pas |
| 2 | Le cloud envoie un email avec lien d'acceptation ; si le compte n'existe pas, le lien passe par l'inscription | 🖥 | ❌ **zéro envoi d'email dans le backend** (une skill `cloudflare-email-service` est disponible pour le construire) |
| 3 | Le membre accepte → `project_members` actif avec son rôle | 🖥👤 | 🟡 la table et les rôles existent, le flux non |
| 4 | Le membre crée **ses** invitations d'agent (portée : ses propres appareils) et fait W1/W2 sur ses machines | 🖥⌨👤 | ❌ nécessite `owner_user_id` sur `enrollments` + revendication de propriétaire **dans le payload d'attestation signé** (sinon la liaison humain↔appareil ne vaut que la parole du cloud) |
| 5 | L'**admin voit** les appareils du membre (métadonnées, pas les clés) ; le **membre** les approuve | 🖥 | ❌ l'écran d'approbation ne filtre pas par propriétaire |
| 6 | Un custodian remet les epochs selon l'**horizon** choisi (tout / à partir de maintenant / borné) | ⌨ | ❌ même chantier que W3-3 + **arbitrage produit** (voir §7) |

### W5 — Révoquer (agent, appareil, ou humain)

| # | Étape | Où | État |
|---|---|---|---|
| 1 | Révoquer l'enrôlement (bouton « Revoke ») | 🖥👤 | ✅ existe |
| 2 | Supprimer / renommer l'agent dans le registre cloud | 🖥 | ❌ **aucun `DELETE /agents/:id`**, le `PATCH` ne change que le statut — c'est le manque constaté par l'opérateur |
| 3 | Rotation d'epoch N+1, remise aux lecteurs restants | ⌨ | ❌ dépend de W3-3 |
| 4 | Affichage honnête : « ne lit plus le **futur** ; conserve ce qu'il avait déjà déchiffré » | 🖥 | ✅ le texte existe sur la page connect |

### W6 — Perte de machine / récupération

RFC §5.3 : un porteur restant approuve la nouvelle clé, enveloppe les epochs historiques
autorisés, révoque l'ancienne. Même mécanique que W3-3 avec un autorisateur différent —
**toute solution qui inventerait un second canal de transfert de clés créerait un second
endroit où une clé peut fuir** (conséquence 3 de dec#158).
État : ❌ (bloqué sur la remise d'epoch) + ⚠️ quorum non appliqué (mesuré).

### W7 — Quotidien : synchroniser

| # | Étape | État |
|---|---|---|
| 1 | `cloud push` — scelle, met en file, envoie ; refus des trois filets listés un par un | ✅ vérifié en prod |
| 2 | **Pull** — tirer les enveloppes des autres, vérifier (`verifyInbound` : roster, signature, AAD, anti-rejeu), matérialiser localement | ❌ **`verifyInbound` n'a aucun appelant de production** — symétrique exact de l'émission avant ce matin ; le « Materialized N signals » des sessions vient du chemin **v1** |
| 3 | Relais dashboard : changer statut/priorité depuis le web, appliqué localement (`applyCloudCommand`) | 🟡 primitives présentes des deux côtés, câblage du poll absent |
| 4 | Automatisation : push en fin de session, pull en début (hooks existants) | ❌ manuel aujourd'hui |
| 5 | Conflits : `409` → recalage signé une fois, sinon visible en `conflict` | ✅ |

### W8 — Multi-projets (S5)

Fonctionne par construction (1 workspace = 1 projet, table d'ids opaques cloisonnée par
projet cloud — testé). Reste : persister l'URL du cloud par appairage, et le sélecteur de
projet web existe déjà.

### W9 — Agent headless / CI (S6) — *à concevoir, pas à contourner*

La cérémonie exige un humain au terminal. Pour un runner CI éphémère, trois options à
trancher **plus tard** (aucune n'est urgente) : appairage du runner par son propriétaire au
provisioning ; « appareil de service » à rôle réduit (écriture seule, jamais custodian) ;
ou exclusion assumée (le CI passe par un membre humain). À documenter comme limite tant que
non conçu.

---

## 4. L'URL d'activation — ce qu'elle change, ce qu'elle ne doit jamais porter

L'idée de l'opérateur est bonne et **peu coûteuse** : l'URL est un véhicule pour le code
d'invitation existant, pas un nouveau mécanisme.

```
https://app.brainclaw.dev/a/<code>          ← partageable à l'humain OU collée à l'agent
brainclaw cloud connect <url|code> --agent x  ← la CLI accepte les deux formes
```

Ce que ça améliore : une seule chose à copier (aujourd'hui : code + URL + savoir où les
mettre) ; un agent à qui on colle l'URL peut en extraire le code ET l'adresse du
déploiement — ce qui règle au passage la non-persistance de l'URL.

**Les invariants qui rendent l'URL sûre** (tous déjà en place pour le code) :
usage unique, TTL 15 min, seul le SHA-256 stocké, et surtout — **l'URL ne donne aucun droit
de lecture**. Elle n'ouvre que le droit de *candidater* ; la sécurité reste dans la
comparaison d'empreintes à l'approbation, et les clés d'epoch ne voyagent **jamais** dans
une URL.

**Le piège à refuser explicitement** : mettre dans l'URL de quoi éviter l'approbation
(« lien magique » qui active). Ce serait le modèle moltbook, voir ci-dessous.

## 5. Pourquoi pas l'auto-enregistrement (le modèle moltbook), et ce qu'on en garde

Le modèle « l'agent s'enregistre tout seul dans l'application » échoue sur trois points,
tous structurels :

1. **Aucune liaison de propriété** — n'importe quel processus connaissant l'URL devient un
   agent du projet ; l'identité se squatte.
2. **Le cloud peut fabriquer des agents** — sans approbation humaine par empreintes, un
   cloud hostile insère son propre « membre fantôme » dans le projet, et le chiffrement de
   bout en bout devient décoratif (c'est exactement l'attaque que l'attestation
   X25519-par-Ed25519 ferme, migrations 0022/0025).
3. **Rien ne lie l'agent à une clé** — un agent enregistré sans attestation ne peut pas
   recevoir d'epoch de façon vérifiable.

**Ce qu'on en garde** : la simplicité du geste — *un seul artefact à transmettre*. C'est
précisément l'URL d'activation (§4) : la simplicité de moltbook, la cérémonie en dessous.

---

## 6. Besoins transverses (indépendants des parcours)

| Besoin | Pourquoi | État |
|---|---|---|
| Envoi d'email (invitations, notifications d'approbation) | W4 | ❌ — skill `cloudflare-email-service` disponible |
| CRUD agents cloud (`DELETE`, renommage, purge des agents v1 périmés) | W5, demande opérateur | ❌ |
| État local multi-appairage (`connection.json` v3 : un `device`, une liste d'agents) | W2, trp#1625 | ❌ |
| Persistance de l'URL du cloud dans l'état d'appairage | toutes les commandes | ❌ (mesuré) |
| `connect` qui enchaîne l'attente d'approbation (supprime `await` du chemin nominal) | W1 friction | ❌ |
| Pull v2 (`verifyInbound` câblé + matérialisation + curseur de feed) | W7 — sans lui, la fédération est **unidirectionnelle** | ❌ |
| Application du quorum de récupération (aujourd'hui rapporté, jamais bloquant) | W6 | ❌ |
| Écran « appareils par humain » (l'admin voit, le propriétaire approuve) | W4 | ❌ |

## 7. Les arbitrages qui vous appartiennent (aucun n'est technique)

Repris de dec#159 — à trancher **avant** W3/W4, parce qu'irréversibles par nature :

1. **Horizon par défaut d'un nouveau membre** : rien / depuis l'adhésion / tout.
   Recommandation technique : minimal (élargir reste toujours possible, reprendre jamais).
2. **Qui est custodian** des remises de clés : le premier appareil ? tout membre `admin` ?
   un quorum ? — et l'exigence d'indépendance des appareils de récupération.
3. **Disponibilité** : accepter qu'un nouveau membre attende qu'un custodian soit en ligne,
   ou financer une récupération explicitement détentrice de clés (coffre).
4. **Équivocation du cloud** : aucun témoin / gossip d'équipe / journal de transparence.
   Le cloud hostile qui montre des rosters différents à deux humains reste indétectable
   sans canal hors bande — c'est une limite à afficher, pas à taire.

## 8. Ordre de construction proposé

Chaque tranche est livrable et vérifiable seule ; les deux premières ne demandent aucun
arbitrage :

1. **Fondations sans arbitrage** — état multi-appairage (W2), URL persistée + URL
   d'activation (§4), `connect` qui attend, CRUD agents (W5-2). *Débloque S2 et la demande
   opérateur immédiate.*
2. **Pull v2** (W7-2) — la fédération devient bidirectionnelle ; sans lui, un deuxième
   appareil n'aurait de toute façon rien à lire.
3. **Invitation d'humains** (W4-1..3, email inclus) — après l'arbitrage §7-1 au minimum.
4. **Remise d'epoch** (W3/W4-6/W6) — le gros œuvre, après les arbitrages §7-1/2/3.

---

*Références : dec#154 (cloud = projection), dec#155 (relais sans contexte), dec#156 (v2
cassante), dec#158 (appairage deux niveaux), dec#159 (synthèse idéation, epoch grants),
dec#160 (six divergences de contrat, résolues), trp#1610 (connect appaire le cwd),
trp#1625 (connection.json singleton), critiques `CRITIQUE-codex.md` /
`CRITIQUE-claude-code.md` (worktrees de l'idéation du 2026-08-09).*
