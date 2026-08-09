# Idéation — repenser l'appairage de la fédération v2 (dec#158)

**Direction opérateur (2026-08-09) :** un compte cloud doit gérer le solo-dev **et** l'équipe
sans deux modèles distincts. L'admin du compte invite des utilisateurs **humains** par leur
email ; chaque humain appaire ensuite **ses propres** agents.

## État mesuré aujourd'hui — vérifié sur le code, ne pas re-supposer

- `handleAddProjectMember` (`src/handlers/projects.ts`) cherche l'utilisateur **par email**
  mais exige qu'il **existe déjà** : sinon `404 No user found with email`. Aucun flux
  d'invitation — la personne doit s'inscrire d'abord, puis être ajoutée.
- **Aucun envoi d'email** dans tout le backend.
- `enrollments` porte `invited_by_user_id` (qui a invité) mais **aucun lien** vers l'humain
  **propriétaire** de l'appareil.
- L'invitation d'agent est créée par quiconque détient `enrollments.invite` sur le projet.
- Cycle actuel d'un appareil : invite → claim → PoP → attestation X25519 → approbation
  humaine → active.
- Le scellement se fait sous une **clé d'epoch de projet**
  (`buildEnvelope(keyEpoch)`, `epochPublicKey(cloudProjectId, epoch)`), **pas par appareil**.
  Chaque appareil détient un **jeu** d'epochs (`heldEpochs`, `storeEpochPrivateKey`).
- **Rien ne projette encore** : `buildEnvelope` a zéro appelant hors sa définition, l'outbox
  v2 n'est jamais alimentée, 0 enveloppe reçue côté cloud.

## Les trois conséquences à traiter, pas à redécouvrir

1. **Qui approuve un agent doit changer.** L'approbation repose sur la comparaison hors
   bande de deux empreintes entre l'écran web et le terminal de l'appareil. Un admin ne peut
   pas vérifier le terminal d'un tiers : lui faire approuver l'agent d'autrui transforme la
   vérification en clic de confiance et rouvre l'attaque de l'homme du milieu que la
   cérémonie ferme (dec#8).
2. **Un nouveau membre ne lit que les epochs qu'on lui remet.** Il ne peut rien lire du passé
   tant qu'un membre existant ne lui transmet pas les epochs antérieurs, ou ne rescelle pas.
3. **Chargement de l'historique et invitation d'équipe sont le même problème** : qui remet
   quelles clés d'epoch à qui, et quand. Les traiter séparément produirait deux mécanismes de
   transfert de clés — donc deux endroits où une clé peut aller où elle ne devrait pas.

## Ce qui est attendu

Proposez une conception, en la défendant sur les points **durs** plutôt que sur la partie
facile — le formulaire d'invitation par email est trivial et n'intéresse pas.

**(a) Modèle d'entités.** Où vivent les humains, où vivent les appareils, quel lien entre les
deux. Un `owner_user_id` sur `enrollments` suffit-il ?

**(b) Qui approuve quoi**, et comment le solo-dev ne subit **pas** la cérémonie d'équipe. Le
solo doit rester un cas dégénéré du même modèle, pas une branche parallèle.

**(c) La remise des clés d'epoch — le cœur du sujet.** Qui la fait, quand, sous quelle
autorité, avec quelle preuve ? Un membre existant doit-il être **en ligne** pour qu'un
nouveau membre rejoigne ? Que se passe-t-il si le seul détenteur d'un epoch quitte l'équipe
ou perd sa machine ? Une clé d'epoch remise **ne se reprend pas** — comme la révocation ne
retire pas ce qui a déjà été déchiffré.

**(d) L'horizon d'un nouveau membre** : tout l'historique, rien, ou borné ? Argumentez le
défaut, et dites ce qui devient **impossible à corriger après coup**.

**(e) La rotation d'epoch sur changement d'appartenance.** Au départ d'un membre, faut-il
tourner ? Quel est le coût réel, et que protège-t-on exactement sachant que le partant garde
ce qu'il détient déjà ?

**(f) Ce qui casse si le cloud est hostile.** Il orchestre l'appairage, donc il choisit qui
voit quelle empreinte et quand. Où sa malveillance reste-t-elle **indétectable** ?

## Contraintes dures

- **dec#154** — le cloud est projection + relais, le local est source de vérité ; chemins
  locaux, hôtes, sessions, clés et secrets **ne sortent jamais**.
- **dec#155** — le relais cloud n'a ni session, ni cwd, ni contexte ambiant : seulement un id
  d'entité et un `base_rev`.
- **dec#8** — aucune clé collée à la main, aucune variable d'environnement ; l'humain compare
  des empreintes.
- Zéro dépendance runtime au-delà de `commander`/`yaml`/`zod` côté core.

## Méthode attendue

Ne convergez pas trop vite. **Nommez les alternatives que vous écartez** et pourquoi. Si une
partie du sujet demande un arbitrage **produit** plutôt qu'une réponse technique, dites-le
explicitement au lieu de trancher à la place de l'opérateur. **Signalez toute prémisse de ce
brief que le code contredit** — plusieurs affirmations ci-dessus ont été mesurées, mais la
mesure peut avoir manqué un chemin.
