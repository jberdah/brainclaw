# AGENTS — brainclaw

Ce dépôt est le projet brainclaw lui-même. Il utilise brainclaw comme mémoire partagée (projet "inception").

## Première action obligatoire

**Avant toute tâche**, exécuter et lire :

```bash
node dist/cli.js context --json
node dist/cli.js agent-board
```

Ces commandes donnent : contraintes actives, décisions, traps connus, plans en cours, handoff de session précédent, instructions de workflow.

Si `dist/cli.js` n'existe pas : `node node_modules/typescript/bin/tsc -p tsconfig.json` d'abord.

## Règles de workflow

### Git
- Toute phase = une branche dédiée (`feat/<feature>` ou `chore/<scope>`)
- Merge dans master seulement après tests verts
- `git push` SSH ne fonctionne pas depuis PowerShell sur ce poste — utiliser :
  `wsl -- bash -c "cd /mnt/c/Users/jberdah/Documents/Projets/shared_agent_memory_mvp && git push origin <branche>"`
- Après merge : supprimer la branche locale (`git branch -d`) et distante (`git push origin --delete`)

### Tests
```bash
node "C:\Program Files\nodejs\node.exe" node_modules\typescript\bin\tsc -p tsconfig.test.json
node --test dist-test/tests/unit/<fichier>.test.js
```
Suite complète : `node scripts/run-tests.mjs unit`

### Mise à jour de la mémoire après chaque phase
```bash
node dist/cli.js update-plan <id> --status done
node dist/cli.js handoff "<résumé session>" --from jberdah --to jberdah --tag roadmap --tag session
```
Mettre aussi à jour `docs/plan.md`.

## Architecture clé

| Fichier | Rôle |
|---|---|
| `src/core/ids.ts` | Génération IDs + short_label (compteur `.brainclaw/.id-counter.json`) |
| `src/core/schema.ts` | Schémas Zod pour tous les types |
| `src/core/candidates.ts` | Gestion candidates + résolution alias `cnd#N` |
| `src/core/circuit-breaker.ts` | Circuit-breaker auto-promote par agent |
| `src/core/config.ts` | Config projet (defaults inclus `circuit_breaker_*`) |
| `src/commands/doctor.ts` | Vérification santé mémoire — `generateMarkdown(state, options.cwd)` obligatoire |
| `src/commands/mcp.ts` | Serveur MCP stdio |

## Pièges connus

- `generateMarkdown(state)` sans `cwd` → lit `process.cwd()` au lieu du workspace cible (bug silencieux)
- `plan list` crée un plan avec le texte "list" (bug 0.6.1)
- `brainclaw context` retourne `plan_items` vides via state YAML, pas les fichiers JSON (bug 0.6.2)
- Rebuild requis avant les tests : `tsc -p tsconfig.test.json`
- PowerShell `&` avec des arguments complexes nécessite `& { ... }` ou guillemets explicites
