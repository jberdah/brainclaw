# Audience: End-Users & Solo Devs

Design constraints for agents developing brainclaw features that serve end-users, solo developers, and power-users.

## Profiles

### Non-Tech Creators
People who rely on AI agents to write code for them. They never open a terminal manually. They interact with brainclaw only through their agent.

### Solo Developers
Developers who code alongside their agent. They use one agent at a time, session after session, on the same project.

### Power-Users
Developers who orchestrate multiple agents on the same project. They use handoffs, plans, and claims to coordinate between agents.

## Design Constraints

These rules apply to any feature that touches this audience:

1. **Every feature MUST have an agent-only path.** If a feature requires the user to type a CLI command, it must also be achievable through MCP or natural language instruction to the agent. The CLI is a fallback, not the default.

2. **Zero-config is the baseline.** `brainclaw init` must produce a working setup without follow-up questions for simple projects. Sensible defaults over configuration dialogs.

3. **Memory must survive sessions.** Any decision, constraint, or trap recorded in one session must be available in the next session without the user re-stating it. This is the core value proposition for solo devs.

4. **Context must be prompt-sized.** End-users don't manage context windows. brainclaw must produce compact, relevant context that fits within agent limits without manual pruning. The 9 context profiles (dev, dense, compact, copilot, quick, briefing, openclaw, ops, research) exist for this — the right profile is selected automatically based on agent tier and session type.

5. **Onboarding must be expressible in one sentence.** The install path is: user tells agent "install brainclaw and use it". If onboarding requires more steps, the feature is too complex for this audience. The auto-bootstrap (`bclaw_bootstrap`) handles brownfield scanning (README, docs, git history, existing agent files) and derives memory seeds without user input.

6. **Handoffs must be seamless.** When a power-user switches from one agent to another, the next agent must pick up where the last one left off without the user re-explaining the current state. Context diff (`context-diff.ts`) shows exactly what changed since the last session so agents resume from delta, not from scratch.

## Anti-Patterns

- Adding CLI-only features with no MCP equivalent
- Requiring manual file editing to configure brainclaw behavior
- Producing context that exceeds prompt limits or requires the user to select what to include
- Assuming the user understands brainclaw internals (store structure, export formats, tier model)
- Breaking session continuity — any mutation that makes the next session start from scratch
- Forcing the user to manually maintain memory — `bclaw_compact` (semantic deduplication) and `bclaw_quick_capture` (auto-classification) exist to reduce this friction

## Key Features for This Audience

### Session & Context (core loop)
- `bclaw_session_start` / `bclaw_session_end` — session lifecycle with auto-reflect
- `bclaw_get_context` — prompt-ready context with profile selection (9 profiles)
- Context diff — incremental delta since last session (`since_session` parameter)
- `bclaw_work` — facade: session + context + claim in one call

### Memory (persistence across sessions)
- `bclaw_write_note` — persistent runtime observations
- `bclaw_quick_capture` — free-form text auto-classified into decision/trap/note
- `bclaw_search` — BM25 full-text search across all memory items
- `bclaw_compact` — semantic deduplication with archive (never deletes)
- Project memory types: constraints, decisions, traps, handoffs, layered instructions

### Onboarding & Discovery
- `brainclaw init` / `brainclaw setup` / `bclaw_setup` — onboarding path
- `bclaw_bootstrap` — brownfield auto-scan with interview and profile caching
- `bclaw_get_execution_context` — workspace detection, toolchains, git status
- `bclaw_release_notes` — agent-first version notes (breaking risk, highlights)
- Native agent file generation (CLAUDE.md, AGENTS.md, .cursor/rules/, .windsurfrules, GEMINI.md, etc.)

### Multi-Agent Handoffs (power-users)
- `bclaw_read_handoff` / `bclaw_update_handoff` — structured agent transitions with git diff
- `bclaw_create_plan` / `bclaw_update_plan` — shared work that survives agent switches
- `bclaw_claim` / `bclaw_release_claim` — scope reservation before editing

## Known Gaps

Features this audience would naturally expect but that are not yet implemented:

### Session continuity diff not auto-surfaced on start
`bclaw_session_start` returns a full context snapshot but does not auto-include "here's what changed since your last session". The diff logic exists (`context-diff.ts`, `since_session` parameter) but the agent must explicitly request it via `bclaw_get_context --sinceSession <id>`. For solo devs resuming next morning, the agent should get the delta automatically.
**Impact:** Solo devs re-read stale context instead of focusing on what changed.

### No fuzzy search or typo tolerance
`bclaw_search` uses BM25 with exact tokenization only (`search.ts`). No Levenshtein distance, no prefix matching, no "did you mean?" suggestions. Searching "postgre" when the memory says "PostgreSQL" returns nothing.
**Impact:** Non-tech creators who can't spell technical terms get zero results.

### Memory accumulates with no staleness management
Traps have `expires_at` and `status` fields (`traps.ts`), and `bclaw_doctor` lists expired items, but there is no auto-expiry workflow. No staleness warnings ("this constraint hasn't been reviewed in 90 days"), no "mark as resolved" flow that archives instead of deletes. Memory grows until manual cleanup via `bclaw_compact` or `bclaw_delete_memory`.
**Impact:** After months of use, context becomes noisy with obsolete items.

### No context weight personalization
Context profiles are hardcoded in `context.ts` with fixed section weights (plans +4, handoffs +3, decisions/traps +2 in dense mode). There is no per-user or per-agent configuration to say "show me more traps, fewer plans" or "pin this item to always appear".
**Impact:** One-size-fits-all context may miss what matters most to a specific user.

### No undo beyond single-item rollback
`rollback.ts` can revert a single item to its previous state via audit snapshots, but there is no batch undo ("undo all changes from session X"), no point-in-time restore, no "undo last 5 edits" convenience.
**Impact:** If an agent writes bad memory, cleanup is manual and item-by-item.

### No init repair path
If `brainclaw init` partially fails or produces a bad config, there is no `brainclaw repair` command. Re-init requires `--force` which risks destroying existing memory. `bclaw_doctor` checks for issues but auto-repairs very little.
**Impact:** Corrupted setups require manual intervention that non-tech creators cannot do.

### Cross-project learning is manual only
Projects are siloed. Federation exists (`federation-transport.ts`) but requires explicit config and manual push/pull. There is no auto-detection of common learnings across projects (e.g., "3 projects use React, here are shared patterns"). No cross-project search.
**Impact:** Solo devs working on multiple repos re-discover the same constraints.

### Quick capture is keyword-heuristic only
`bclaw_quick_capture` uses keyword heuristics, not LLM inference. An agent cannot say "remember that we decided to use PostgreSQL" and have it auto-classified as a decision with confidence scoring.
**Impact:** Agents must use structured MCP calls with explicit type parameters instead of natural language.
