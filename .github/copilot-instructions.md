# Copilot Instructions — brainclaw

Ce projet **utilise brainclaw comme mémoire partagée**. Avant toute tâche, tu dois lire le contexte brainclaw.

## Démarrage obligatoire

Avant de commencer à travailler, exécute ces deux commandes et lis leur sortie :

```bash
node dist/cli.js context --json
node dist/cli.js agent-board
```

Cela te donnera :
- Les contraintes actives, décisions récentes, traps connus
- Les plans en cours et leur assignation
- Le handoff de session précédent (point d'entrée pour la prochaine tâche)
- Les instructions de workflow (git branching, etc.)

## Workflow Git obligatoire

Toute phase de développement suit ce processus :
1. Créer une branche dédiée : `git checkout -b feat/<feature-name>` ou `chore/<scope>`
2. Implémenter les changements
3. Valider les tests : `node "C:\Program Files\nodejs\node.exe" node_modules\typescript\bin\tsc -p tsconfig.test.json && node --test dist-test/tests/unit/...`
4. Commit + push de la branche
5. Merge dans master : `git merge --no-ff`
6. Supprimer la branche locale et distante

**Important** : sur ce poste, `git push` SSH ne fonctionne pas depuis PowerShell. Utiliser WSL :
```bash
wsl -- bash -c "cd /mnt/c/Users/jberdah/Documents/Projets/shared_agent_memory_mvp && git push origin <branche>"
```

## Après chaque phase

Mettre à jour brainclaw :
- `node dist/cli.js update-plan <id> --status done` pour les plans livrés
- `node dist/cli.js handoff "..." --from jberdah --to jberdah` pour la passation de session
- Mettre à jour `docs/plan.md` pour refléter l'avancement

## Structure du projet

- `src/` — sources TypeScript
- `src/core/` — modules métier (ids, schema, candidates, circuit-breaker, etc.)
- `src/commands/` — commandes CLI et MCP
- `dist/` — build de production (via `tsc -p tsconfig.json`)
- `dist-test/` — build de test (via `tsc -p tsconfig.test.json`)
- `tests/unit/` — tests unitaires (runner : `node --test dist-test/tests/unit/`)
- `.brainclaw/` — mémoire partagée brainclaw (ne pas éditer manuellement)
- `docs/plan.md` — roadmap et statut des features
