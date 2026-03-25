<!-- brainclaw:start -->
> Managed by brainclaw v0.28.0 — do not edit manually.
> Regenerate: brainclaw export --format claude-md --write

## brainclaw — why this matters

This project uses brainclaw for shared memory and multi-agent coordination.
Other agents and developers work in this repo. Without brainclaw context:
- You may edit files another agent is actively working on
- You will miss known traps and architectural decisions
- You will duplicate or contradict planned work

## brainclaw — session protocol

Brainclaw context is injected automatically via hooks at each prompt.

1. Read the injected board state before acting
2. Call `bclaw_get_context(target)` for deeper memory on a specific scope
3. Call `bclaw_claim(scope)` before editing if other agents are active
4. Call `bclaw_session_end(auto_release: true)` when done

## brainclaw — plans and estimation

When creating a plan or step, always estimate duration in minutes.
When completing, report actual effort. This calibrates future estimates.

## brainclaw — version check

Call `bclaw_get_execution_context` at session start to check for brainclaw updates.
If a newer version is available, inform the developer and suggest updating.
Brainclaw updates may include new features, bug fixes, and improved coordination.

## brainclaw — active constraints

- Windows : node absent du PATH dans VS Code. Utiliser le chemin complet: C:\Program Files\nodejs\node.exe
- TypeScript module: Node16 + ESM — les imports locaux doivent avoir l'extension .js (pas .ts). Le build output va dans dist/ (prod) et dist-test/ (tests). tsconfig.test.json est distinct de tsconfig.json.
- Coverage gates c8: lines 55%, functions 60%, branches 65%, statements 55%. Ne pas baisser ces seuils. Objectif long terme: hausser chaque milestone vers 80/85/80/80.
- Dependances prod: commander, yaml, zod SEULEMENT. Ne pas ajouter de dependances runtime sans discussion explicite — le projet est volontairement minimaliste pour permettre des agents legers.
- Toujours bumper la version dans package.json apres un merge dans master : modifier la version selon semver (patch/minor/major), rebuilder le dist avec tsc, et publier via brainclaw version --publish-local avec une release note.
- Toutes les interactions avec brainclaw depuis un agent doivent passer par les outils MCP (bclaw_*), jamais par le CLI dist/cli.js. Le CLI est reserve aux operations de build/release/install et aux actions humaines en terminal.
- Workflow git obligatoire apres bclaw_claim : la premiere action apres un claim est git checkout -b feat/<nom>. Ne jamais commencer a editer des fichiers sur master ou main. Seules exceptions: bump de version et regeneration de fichiers agents immediatement apres un merge de feature.
- Jusqu'à l'implémentation de worktrees git dédiés par agent, éviter de faire travailler plusieurs agents en parallèle dans le même checkout. La collaboration séquentielle avec handoff, plans et claims est supportée; l'édition concurrente dans un même workspace ne l'est pas encore de manière fiable.
- On large or complex workspaces, onboarding and bootstrap must support lightweight, non-intrusive modes before full file generation. Brainclaw should be able to operate in memory-only or workspace-light modes and avoid writing managed agent files by default until the workspace perimeter is clarified.
- New features and plans must improve at least one core product path: useful context, brownfield bootstrap, low-friction capture, coordination, or correctness/connectivity for agent workflows. Work that does not strengthen one of these paths is secondary.
- Do not prioritize advanced ecosystem, parallel-agent, distributed-sync, or governance features ahead of the nominal and brownfield journeys unless the change materially improves time-to-useful-context, onboarding safety, or correctness on the core agent workflow.
- Until the persistence hardening plan is delivered, do not run multiple mutating Brainclaw commands in parallel on the same project store. Serialize memory, plan, claim, and handoff writes against a given .brainclaw to avoid partial persistence or denormalized view races, even on non-Windows systems.
- Agent field report — Claude Code on complex multi-project workspace (2026-03-24):

1. plan list returns empty for done plans — files exist in coordination/plans/ but are filtered out. Need --all or --include-done option.
2. Context drops done plans — new agent joining session has no visibility on completed work. Done plans should remain visible (possibly in a "completed" section).
3. cd into project dir required for correct store resolution — agents launched from workspace root must cd into subproject. Need --project flag or brainclaw switch <project> command.
4. No link between memory create and plans — decisions/traps created during plan work are orphans, no planId association.
5. Claim granularity mismatch — claiming whole app is too broad, claiming individual files is too heavy. Need a middle ground (directory-level claims, or auto-expand).
6. No session summary — session-end releases claims but creates no recap. Next agent has no quick overview of what happened.
7. memory create decision vs decision command — confusing duality, unclear if same thing.
8. User proposal: brainclaw switch <project> to set active project context for subsequent commands without cd.
- Git commits must not include Co-Authored-By trailer lines. The user does not want agent attribution in the git history.

## brainclaw — active instructions

- Store local npm release tarballs only under .releases/ and never leave brainclaw-*.tgz artifacts in the repository root.
<!-- brainclaw:end -->
